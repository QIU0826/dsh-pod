import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConcurrencyLimitError } from '../src/core/errors.js'
import { JsonStore } from '../src/core/store.js'
import { MissionOrchestrator, MAX_REVIEW_DIFF_CHARS, MAX_REVIEW_SPEC_CHARS } from '../src/core/orchestrator.js'
import { repairPath } from '../src/workers/preflight.js'
import type { LaunchInput, PlanTaskInput, WorktreeManager } from '../src/core/orchestrator.js'

// Windows 专项：宿主 PATH 可能缺失 git（CR-02-4），测试先修复再跑真实 git
repairPath()
import type {
  AgentSlot,
  MissionReport,
  Task,
  Vendor,
  WorkerBackend,
  WorkerCompletion,
  WorkerHandle,
  WorkerProgressEvent,
} from '../src/core/types.js'
import { APPROVAL_STALE_MS, CTX_RESET_THRESHOLD_PCT } from '../src/core/types.js'

/**
 * FakeBackend：脚本化回放——start 记录调用并按任务 id 脚本产出进度与完成信号。
 * 完成信号必须在 microtask 中回调（真实后端的进程退出语义），保证 run() 等待协议成立。
 */
class FakeBackend implements WorkerBackend {
  readonly vendor: Vendor
  readonly protocol = {
    family: 'headless-cli' as const,
    capabilities: { kill: true, session_persist: false, structured_output: true, usage_audit: false },
  }
  readonly started: Array<{ slot: AgentSlot; task: Task; worktree: string }> = []
  readonly kills: string[] = []
  /** v0.2 并行强化：并发峰值（同一时刻 active 任务数）——验证双路+ 派发进同轮。 */
  activeCount = 0
  peakActive = 0
  private readonly script: Record<string, { progress?: WorkerProgressEvent[]; completion?: WorkerCompletion; next?: WorkerCompletion; hang?: boolean; delayMs?: number }>
  private readonly calls = new Map<string, number>()

  constructor(vendor: Vendor, script: Record<string, { progress?: WorkerProgressEvent[]; completion?: WorkerCompletion; next?: WorkerCompletion; hang?: boolean; delayMs?: number }>) {
    this.vendor = vendor
    this.script = script
  }

  private scriptedFor(taskId: string): { progress?: WorkerProgressEvent[]; completion?: WorkerCompletion; hang?: boolean; delayMs?: number } {
    const entry = this.script[taskId]
    const count = (this.calls.get(taskId) ?? 0) + 1
    this.calls.set(taskId, count)
    if (entry === undefined) return this.defaultEntry(taskId)
    if (count === 1) return entry
    // 重试调用：走 next（未指定则默认成功完成）
    return entry.next !== undefined ? { ...entry, completion: entry.next } : this.defaultEntry(taskId)
  }

  private defaultEntry(taskId: string): { progress?: WorkerProgressEvent[]; completion?: WorkerCompletion; hang?: boolean; delayMs?: number } {
    return {
      completion: {
        exit: 'done',
        report: doneReport(taskId),
        usage: { tokens_in: 10, tokens_out: 5, source: 'measured' },
        artifacts: [],
      },
    }
  }

  async detect() {
    return { installed: true, authed: true, models: [] as string[], session_tiers: ['transient'] as Array<'transient'> }
  }

  async start(
    slot: AgentSlot,
    task: Task,
    worktree: string,
    callbacks: { onProgress?(event: WorkerProgressEvent): void; onExit?(completion: WorkerCompletion): void } = {},
  ): Promise<WorkerHandle> {
    this.started.push({ slot, task, worktree })
    this.activeCount += 1
    if (this.activeCount > this.peakActive) this.peakActive = this.activeCount
    const entry = this.scriptedFor(task.id)
    if (entry.hang !== true) {
      const fire = () => {
        for (const progress of entry.progress ?? []) callbacks.onProgress?.(progress)
        if (entry.completion !== undefined) callbacks.onExit?.(entry.completion)
        this.activeCount = Math.max(0, this.activeCount - 1)
      }
      if (entry.delayMs !== undefined) setTimeout(fire, entry.delayMs)
      else queueMicrotask(fire)
    }
    return { pid: 1000 + this.started.length, session_ref: `${this.vendor}-session-${task.id}` }
  }

  async kill(handle: WorkerHandle): Promise<void> {
    this.kills.push(String(handle.pid))
  }
}

function doneReport(taskId: string, over: Partial<MissionReport> = {}): MissionReport {
  return {
    task_id: taskId,
    task_type: 'implement',
    status: 'done',
    summary: 'done it',
    files_changed: ['src/x.ts'],
    commit_sha: `${taskId}-commit`,
    test_command: 'npm test',
    test_result: 'pass',
    test_evidence: '1/1 ✓',
    decisions: [],
    blockers: [],
    questions: [],
    usage: { tokens_in: 10, tokens_out: 5 },
    ...over,
  }
}

function failedCompletion(): WorkerCompletion {
  return { exit: 'failed', usage: { tokens_in: 1, tokens_out: 1, source: 'measured' }, artifacts: [], exit_code: 1 }
}

/** 真实 git 仓库 + 注入式 verifier（跳过真实 commit 校验的 fake git）。 */
interface Fixture {
  root: string
  repo: string
  store: JsonStore
  backends: Record<string, FakeBackend>
  worktrees: Map<string, string>
  clockNow: number
}

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'pod-orch-'))
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# demo\n')
  writeFileSync(join(repo, '.gitattributes'), '* text=auto eol=lf\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  const store = new JsonStore({ rootDir: root, clock: () => 0 })
  store.open()
  const worktrees = new Map<string, string>()
  return {
    root,
    repo,
    store,
    backends: {},
    worktrees,
    clockNow: 1_700_000_000_000,
  }
}

function launchInput(over: Partial<LaunchInput> = {}): LaunchInput {
  return {
    name: 'demo mission',
    goal: '写一个小工具函数并通过独立 review',
    cwd: '',
    budgetUsd: 2,
    slots: [
      { id: 'S-1', vendor: 'claude', role: 'implementer', capabilities: ['编码'], model: 'deepseek-v4-pro', session_tier: 'per-mission' },
      { id: 'S-2', vendor: 'codex', role: 'reviewer', capabilities: ['审查'], model: 'codex-default', session_tier: 'transient' },
    ],
    ...over,
  }
}

function plan(over: Partial<PlanTaskInput>[] = []): PlanTaskInput[] {
  const base: PlanTaskInput[] = [
    { id: 'T-1', title: '实现工具函数', spec: '实现 add(a,b)', type: 'implement', skill_tags: ['编码'] },
    { id: 'T-2', title: '独立 review', spec: '审查 T-1', type: 'review', skill_tags: ['审查'], depends_on: ['T-1'] },
  ]
  return base.map((task, i) => ({ ...task, ...(over[i] ?? {}) }))
}

/** 轮询等待条件成立（异步驱动循环的完成信号不暴露 promise 句柄时用）。 */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function makeWorktreeManager(fixture: Fixture): WorktreeManager {  return {
    async ensure(repoRoot: string, slotId: string) {
      let path = fixture.worktrees.get(slotId)
      if (path === undefined) {
        path = join(repoRoot, '.pod-worktrees', slotId)
        execFileSync('git', ['worktree', 'add', path, '-b', `pod-${slotId}`], { cwd: repoRoot })
        fixture.worktrees.set(slotId, path)
      }
      return path
    },
  }
}

let fixture: Fixture

beforeEach(async () => {
  fixture = await makeFixture()
})

afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true })
})

function makeOrchestrator(
  fixture: Fixture,
  script: Record<string, { progress?: WorkerProgressEvent[]; completion?: WorkerCompletion; next?: WorkerCompletion; hang?: boolean; delayMs?: number }>,
  missionId = 'M-1',
  deps: {
    memoryQuery?: (q: { owner_slot_id?: string; importance_min?: number; limit?: number }) => Array<{ id: string; type: string; importance: number; tags: string[]; content_ref: string }>
    consult?: (prompt: string) => Promise<{ ok: boolean; text: string }>
    experiments?: { isEnabled: (key: string) => boolean }
  } = {},
) {
  const backends: Record<string, FakeBackend> = {
    claude: new FakeBackend('claude', script),
    codex: new FakeBackend('codex', script),
  }
  fixture.backends = backends
  return new MissionOrchestrator(missionId, {
    store: fixture.store,
    backends,
    worktree: makeWorktreeManager(fixture),
    clock: () => fixture.clockNow,
    // 测试注入假 verifier：真实 commit 校验在 verifier.test.ts 已覆盖
    verify: async (task, report) => ({
      ok: true,
      commit_sha: report.commit_sha,
      parent_sha: `${task.id}-parent`,
      failures: [],
      mismatch: false,
    }),
    ...(deps.memoryQuery !== undefined ? { memoryQuery: deps.memoryQuery } : {}),
    ...(deps.consult !== undefined ? { consult: deps.consult } : {}),
    ...(deps.experiments !== undefined ? { experiments: deps.experiments } : {}),
  })
}

function makeOrchestratorWithDiff(
  fixture: Fixture,
  script: Record<string, { progress?: WorkerProgressEvent[]; completion?: WorkerCompletion; hang?: boolean; delayMs?: number }>,
  missionId = 'M-1',
) {
  const backends: Record<string, FakeBackend> = {
    claude: new FakeBackend('claude', script),
    codex: new FakeBackend('codex', script),
  }
  fixture.backends = backends
  return new MissionOrchestrator(missionId, {
    store: fixture.store,
    backends,
    worktree: makeWorktreeManager(fixture),
    clock: () => fixture.clockNow,
    verify: async (task, report) => ({
      ok: true,
      commit_sha: report.commit_sha,
      parent_sha: `${task.id}-parent`,
      failures: [],
      mismatch: false,
    }),
    diffProvider: async () => 'diff --git a/x.ts b/x.ts\nindex 111..222 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n+export const add = (a, b) => a + b\n',
  })
}

describe('launch（单 active mission / fan-out 上限 / 名册落盘）', () => {
  it('创建 mission 与 slots，事件流可见', () => {
    const orchestrator = makeOrchestrator(fixture, {})
    const mission = orchestrator.launch(launchInput({ cwd: fixture.repo }))
    expect(mission.status).toBe('planning')
    expect(fixture.store.listSlots('M-1')).toHaveLength(2)
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'mission_created')).toBe(true)
  })

  it('已有 active mission → ConcurrencyLimitError（2.12 节单 active）', () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    expect(() => orchestrator.launch(launchInput({ cwd: fixture.repo }))).toThrowError(ConcurrencyLimitError)
  })

  it('员工数超上限 → ConcurrencyLimitError（3.8 节 fan-out 限流）', () => {
    const orchestrator = makeOrchestrator(fixture, {})
    const slots = Array.from({ length: 9 }, (_, i) => ({
      id: `S-${i}`,
      vendor: 'claude' as const,
      role: 'implementer',
      capabilities: ['编码'],
      model: 'm',
    }))
    expect(() => orchestrator.launch(launchInput({ cwd: fixture.repo, slots }))).toThrowError(ConcurrencyLimitError)
  })
})

describe('createTasks（DAG 校验）', () => {
  it('合法 plan 落盘为 ready 任务', () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    const tasks = orchestrator.createTasks(plan())
    expect(tasks).toHaveLength(2)
    expect(fixture.store.getTask('T-1')!.status).toBe('ready')
  })

  it('重复 id → PodError(DUPLICATE_TASK)', () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks(plan())
    expect(() => orchestrator.createTasks(plan())).toThrowError(/already exists/)
  })

  it('依赖环 → 拒绝（PodError CYCLE）', () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    expect(() =>
      orchestrator.createTasks([
        { id: 'A', title: 'a', spec: 'a', type: 'implement', depends_on: ['B'] },
        { id: 'B', title: 'b', spec: 'b', type: 'implement', depends_on: ['A'] },
      ]),
    ).toThrowError(/cycle/i)
  })

  it('review 依赖不存在的任务 → 拒绝（fail-closed）', () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    expect(() =>
      orchestrator.createTasks([
        { id: 'T-2', title: 'review', spec: 'r', type: 'review', depends_on: ['T-nope'] },
      ]),
    ).toThrowError(/missing/i)
  })
})

describe('run 最小可演示链（fake 后端）', () => {
  it('实现 → 独立 review → awaiting_approval + 审批卡生成', async () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks(plan())
    const summary = await orchestrator.run()
    expect(summary.status).toBe('awaiting_approval')
    expect(fixture.store.getTask('T-1')!.status).toBe('done')
    expect(fixture.store.getTask('T-2')!.status).toBe('done')
    // 独立 review：审查者 ≠ 实现者（槽位 id 按 mission 命名空间化，CR-06-6）
    const ownerT1 = fixture.store.getTask('T-1')!.owner_slot_id!
    const ownerT2 = fixture.store.getTask('T-2')!.owner_slot_id!
    expect(ownerT1).toBe('M-1-S-1')
    expect(ownerT2).toBe('M-1-S-2')
    expect(ownerT1).not.toBe(ownerT2)
    // 审批卡已持久化（2.6 节模式 1）
    const approvals = fixture.store.listApprovals('M-1')
    expect(approvals).toHaveLength(1)
    expect(approvals[0]!.status).toBe('pending')
    // worktree 已为员工建立
    expect(fixture.worktrees.has('M-1-S-1')).toBe(true)
    expect(fixture.worktrees.has('M-1-S-2')).toBe(true)
    // 事件流含派单/完成/审批
    const kinds = fixture.store.listEvents('M-1').map((e) => e.kind)
    expect(kinds).toContain('task_dispatched')
    expect(kinds).toContain('task_done')
    expect(kinds).toContain('approval_requested')
  })

  it('审查者槽位被占用时，review 不得派给实现者本人（转人工）', async () => {
    const orchestrator = makeOrchestrator(fixture, {})
    // 只有一个员工：实现与 review 都要它做 → review 不可派发（DoD-5）
    orchestrator.launch(
      launchInput({
        cwd: fixture.repo,
        slots: [{ id: 'S-1', vendor: 'claude', role: 'implementer', capabilities: ['编码', '审查'], model: 'm' }],
      }),
    )
    orchestrator.createTasks(plan())
    const summary = await orchestrator.run()
    expect(summary.status).toBe('needs_human')
    expect(fixture.store.getTask('T-1')!.status).toBe('done')
    expect(fixture.store.getTask('T-2')!.status).toBe('escalated')
  })

  it('实现失败重试：attempts=1 重派成功 → 链完成', async () => {
    const script = {
      'T-1': { completion: failedCompletion() }, // 第一次失败
    }
    const orchestrator = makeOrchestrator(fixture, script)
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks(plan())
    const summary = await orchestrator.run()
    // 第一次失败 → blocked(attempts=1) → 重派（FakeBackend 第二次默认 done）
    expect(fixture.store.getTask('T-1')!.status).toBe('done')
    expect(fixture.store.getTask('T-1')!.attempts).toBe(1)
    expect(summary.status).toBe('awaiting_approval')
    // 失败路径单独计数接线：T-1 两笔 usage 分别带 attempts=0（首派失败）与 1（重试成功）
    const t1Entries = fixture.store.listLedger('M-1').filter((e) => e.task_id === 'T-1')
    expect(t1Entries.map((e) => e.attempts).sort()).toEqual([0, 1])
  })

  it('连续失败 3 次 → 转人工 escalated', async () => {
    const script = {
      'T-1': { completion: failedCompletion(), next: failedCompletion() },
    }
    const orchestrator = makeOrchestrator(fixture, script)
    // 每次重派都失败 → attempts 累计到 3 → 转人工
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks(plan())
    const summary = await orchestrator.run()
    expect(fixture.store.getTask('T-1')!.status).toBe('escalated')
    expect(fixture.store.getTask('T-1')!.attempts).toBe(3)
    expect(summary.status).toBe('needs_human')
  })

  it('429 → 不计 attempts + 退避未到 → run 返回 waiting_backoff', async () => {
    const orchestrator = makeOrchestrator(fixture, {
      'T-1': { completion: { exit: 'rate_limited', usage: { tokens_in: 0, tokens_out: 0, source: 'measured' }, artifacts: [] } },
    })
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks(plan())
    const summary = await orchestrator.run()
    const task = fixture.store.getTask('T-1')!
    expect(task.fault).toBe('rate_limited')
    expect(task.attempts).toBe(0)
    expect(summary.status).toBe('waiting_backoff')
    // 退避时间到 → 槽位恢复可用 → 再跑 → 成功
    fixture.clockNow += 60_000
    const summary2 = await orchestrator.run()
    expect(summary2.status).toBe('awaiting_approval')
    expect(fixture.store.getSlot('M-1-S-1')!.status).toBe('idle')
  })

  it('预算熔断 → mission paused + 事件（2.7 节）', async () => {
    const orchestrator = makeOrchestrator(fixture, {})
    // fake 后端每次 usage 15 tokens，token 预算 5 → 首笔即熔断
    orchestrator.launch(launchInput({ cwd: fixture.repo, budgetTokens: 5 }))
    orchestrator.createTasks(plan())
    const summary = await orchestrator.run()
    expect(summary.status).toBe('budget_exceeded')
    expect(fixture.store.getMission('M-1')!.status).toBe('paused')
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'mission_paused_budget')).toBe(true)
  })
})

describe('steer（CR-01-2：运行中指令排队为 micro-task）', () => {
  it('steer 指令入队，员工下次派单必带（spec 注入）', async () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks([{ id: 'T-1', title: '实现', spec: '实现 add', type: 'implement', skill_tags: ['编码'] }])
    orchestrator.steer('S-1', '加一层缓存')
    await orchestrator.run()
    const started = fixture.backends.claude!.started[0]!
    expect(started.task.spec).toContain('加一层缓存')
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'steer_queued')).toBe(true)
  })

  it('review 任务注入宿主机 diff 内容（CR-03：审查者无需仓库命令权限）', async () => {
    const orchestrator = makeOrchestratorWithDiff(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks(plan())
    await orchestrator.run()
    const review = fixture.backends.codex!.started.find((s) => s.task.type === 'review')!
    // P1-5 两级加载：变更地图全量 + hunk 正文注入（hunk 头在正文里，diff --git 行被解析进地图）
    expect(review.task.spec).toContain('被审 diff（hunk 正文，宿主机注入，勿访问仓库）')
    expect(review.task.spec).toContain('变更地图')
    expect(review.task.spec).toContain('@@ -1,1 +1,1 @@')
    expect(review.task.spec).toContain('export const add')
  })

  it('常规 implement→review 流转落 handoff_created 事件（审计 P1：协议层与实际传递对齐）', async () => {
    const orchestrator = makeOrchestratorWithDiff(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks(plan())
    await orchestrator.run()
    // 实现→审查的常规传递（宿主注入 diff）补一条 handoff_created，带 verify 清单
    const handoffs = fixture.store.listEvents('M-1').filter((e) => e.kind === 'handoff_created')
    const reviewHandoff = handoffs.find((e) => (e.payload as { handoff_id?: string }).handoff_id?.startsWith('H-REVIEW-'))
    expect(reviewHandoff).toBeDefined()
    const p = reviewHandoff!.payload as { from: string; to: string; verify: string[]; targets: Array<{ id: string }> }
    expect(p.from).toBeDefined() // 实现者槽位
    expect(p.to).toBeDefined()   // 审查者槽位
    expect(p.verify).toContain('diff_range_valid')
    expect(p.verify).toContain('test_log_exists')
    expect(p.verify).toContain('report_fields_complete')
    expect(p.targets.length).toBeGreaterThan(0)
  })
})

describe('团队宗旨（P0-B：mission 级价值观锚点注入）', () => {
  it('launch 带 tenets → 每个派发任务 spec 前置注入，task_context 事件标注', async () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(
      launchInput({ cwd: fixture.repo, tenets: ['优先可维护性：宁可多写两行说明，也别埋坑', '先跑通再优化'] }),
    )
    orchestrator.createTasks([{ id: 'T-1', title: '实现', spec: '实现 add', type: 'implement', skill_tags: ['编码'] }])
    await orchestrator.run()
    const started = fixture.backends.claude!.started[0]!
    expect(started.task.spec).toContain('团队宗旨（mission 取舍锚点）')
    expect(started.task.spec).toContain('优先可维护性')
    // 宗旨前置在任务简报内容之前（价值观锚点先行，而非塞在结尾）
    expect(started.task.spec.indexOf('团队宗旨')).toBeLessThan(started.task.spec.indexOf('实现 add'))
    const ctx = fixture.store.listEvents('M-1').find((e) => e.kind === 'task_context')
    expect(ctx?.payload.tenets_injected).toBe(true)
  })

  it('无 tenets → 不注入', async () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    await orchestrator.run()
    const started = fixture.backends.claude!.started[0]!
    expect(started.task.spec).not.toContain('团队宗旨')
  })
})

describe('产物字段持久化（Web 第二批：report → Task）', () => {
  it('done 任务把 test_result/test_evidence/decisions/blockers 落盘（UI 产物面数据源）', async () => {
    const orch = makeOrchestrator(fixture, {})
    orch.launch(launchInput({ cwd: fixture.repo }))
    orch.createTasks(plan())
    await orch.run()
    const impl = fixture.store.getTask('T-1')!
    expect(impl.status).toBe('done')
    expect(impl.test_result).toBe('pass')
    expect(impl.result_summary).toBeDefined()
    expect(impl.test_evidence).toBeDefined()
    expect(Array.isArray(impl.decisions)).toBe(true)
    expect(Array.isArray(impl.blockers)).toBe(true)
  })
})

describe('N2 记忆运行时注入（CR-07-4：相关 + 有界 + 指针式）', () => {
  it('派发时按槽位/团队注入相关记忆 + task_context 标注 memory_injected', async () => {
    const orch = makeOrchestrator(fixture, {}, 'M-1', {
      memoryQuery: () => [
        { id: 'mem-1', type: 'lesson', importance: 5, tags: ['编码'], content_ref: 'src/util.ts 用 export function 风格，测试放 tests/ 用 node:test' },
      ],
    })
    orch.launch(launchInput({ cwd: fixture.repo }))
    orch.createTasks([{ id: 'T-1', title: '实现', spec: '实现 add', type: 'implement', skill_tags: ['编码'] }])
    await orch.run()
    const started = fixture.backends.claude!.started[0]!
    expect(started.task.spec).toContain('相关记忆（团队沉淀，指针式）')
    expect(started.task.spec).toContain('src/util.ts 用 export function 风格')
    const ctx = fixture.store.listEvents('M-1').find((e) => e.kind === 'task_context' && e.task_id === 'T-1')
    expect(ctx?.payload.memory_injected).toBe(true)
  })

  it('无 memoryQuery → 不注入（零开销）', async () => {
    const orch = makeOrchestrator(fixture, {})
    orch.launch(launchInput({ cwd: fixture.repo }))
    orch.createTasks([{ id: 'T-1', title: '实现', spec: '实现 add', type: 'implement', skill_tags: ['编码'] }])
    await orch.run()
    expect(fixture.backends.claude!.started[0]!.task.spec).not.toContain('相关记忆')
  })

  it('P1-4 深化①：相关性优先于重要度——importance=2 的相关记忆越过旧 importance≥3 硬门入选且排在前', async () => {
    const orch = makeOrchestrator(fixture, {}, 'M-1', {
      // 旧启发式（importance≥3 硬门 + tag/importance 排序）只会注入高重要度但无关的周报模板，
      // 低重要度强相关的 token bucket 记忆被硬门滤掉；新检索让相关性做主
      memoryQuery: () => [
        { id: 'mem-irrelevant', type: 'lesson', importance: 5, tags: ['文档'], content_ref: '周报模板：每周五汇总本周提交' },
        { id: 'mem-relevant', type: 'lesson', importance: 2, tags: ['限流'], content_ref: 'token bucket 防 429：bucket 容量=速率×突发窗口' },
      ],
    })
    orch.launch(launchInput({ cwd: fixture.repo }))
    orch.createTasks([{ id: 'T-1', title: '实现 rate limiter', spec: '用 token bucket 防止 429，可配速率', type: 'implement', skill_tags: ['编码'] }])
    await orch.run()
    const spec = fixture.backends.claude!.started[0]!.task.spec
    const relevantAt = spec.indexOf('token bucket 防 429')
    const irrelevantAt = spec.indexOf('周报模板')
    expect(relevantAt).toBeGreaterThanOrEqual(0) // 相关记忆入选（旧代码被 importance≥3 硬门滤掉）
    expect(relevantAt).toBeLessThan(irrelevantAt) // 且排在无关但高重要度的记录之前
  })
})

describe('P0-5 交接投递（planDelivery 接线：重派按矩阵注入交接）', () => {
  it('reassign 后重派 → spec 注入交接 + delivered 标记 + task_context handoff_injected', async () => {
    const slots = [
      { id: 'S-1', vendor: 'claude' as const, role: 'implementer', capabilities: ['编码'], model: 'm', session_tier: 'per-mission' as const },
      { id: 'S-2', vendor: 'claude' as const, role: 'implementer', capabilities: ['编码'], model: 'm', session_tier: 'per-mission' as const },
    ]
    const orch = makeOrchestrator(fixture, {})
    orch.launch(launchInput({ cwd: fixture.repo, slots }))
    orch.createTasks([{ id: 'T-1', title: '实现', spec: '实现 add', type: 'implement', skill_tags: ['编码'] }])
    fixture.store.updateTask('T-1', { owner_slot_id: 'M-1-S-1', status: 'blocked', fault: 'crash' })
    await orch.reassignTask('T-1', 'M-1-S-2', '原槽位卡死')
    const handoff = fixture.store.listHandoffs('M-1')[0]!
    expect(handoff.delivered).toBeUndefined()
    await orch.run()
    const started = fixture.backends.claude!.started.find((s) => s.task.id === 'T-1')
    expect(started).toBeDefined()
    expect(started!.task.spec).toContain('交接消息')
    expect(started!.task.spec).toContain('原槽位卡死')
    expect(fixture.store.listHandoffs('M-1')[0]!.delivered).toBe(true)
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'handoff_delivered')).toBe(true)
    const ctx = fixture.store.listEvents('M-1').find((e) => e.kind === 'task_context' && e.task_id === 'T-1')
    expect(ctx?.payload.handoff_injected).toBe(true)
  })
})

describe('审批闭环', () => {
  it('approve → mission done', async () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks(plan())
    await orchestrator.run()
    const approval = fixture.store.listApprovals('M-1')[0]!
    orchestrator.approve(approval.id, 'user')
    expect(fixture.store.getMission('M-1')!.status).toBe('done')
  })

  it('approve → 自动规则在 mission 结束时清理（AS-2：scope=mission 不跨 mission 泄漏）', async () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks(plan())
    await orchestrator.run()
    // 审批前：无 auto 规则
    expect(fixture.store.listRules().filter((r) => r.source === 'auto-from-approval')).toHaveLength(0)
    const approval = fixture.store.listApprovals('M-1')[0]!
    orchestrator.approve(approval.id, 'user')
    // approve 已裁决并触发清理 → mission done 后无 auto 规则残留
    expect(fixture.store.getMission('M-1')!.status).toBe('done')
    expect(fixture.store.listRules().filter((r) => r.source === 'auto-from-approval')).toHaveLength(0)
  })

  it('deny → 回 running（审批卡带原因）', async () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks(plan())
    await orchestrator.run()
    const approval = fixture.store.listApprovals('M-1')[0]!
    orchestrator.deny(approval.id, 'user', '测试没过')
    expect(fixture.store.getMission('M-1')!.status).toBe('running')
    expect(fixture.store.getApproval(approval.id)!.deny_reason).toBe('测试没过')
  })

  it('deny → 原因回灌 worker（AS-3：以 steer 指令排队给 owner slot，下次派单必带）', async () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks(plan())
    await orchestrator.run()
    const approval = fixture.store.listApprovals('M-1')[0]!
    const slotId = approval.patch.slot_id
    orchestrator.deny(approval.id, 'user', '实现与规格不符，请重做')
    // steer 反馈事件已落盘，且带 owner slot 引用
    const feedbackEvents = fixture.store.listEvents('M-1').filter((e) => e.kind === 'steer_queued' && e.slot_id === slotId)
    expect(feedbackEvents.length).toBeGreaterThan(0)
    expect(feedbackEvents[0]!.payload.instruction).toContain('实现与规格不符')
  })
})

describe('派发前预算短路（AgentScope-F / DC-4）', () => {
  it('剩余预算 < 任务预估成本 → 不派发 + budget_short_circuit 告警事件', async () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo, budgetUsd: 2 }))
    orchestrator.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    // 模拟预算几乎耗尽：剩余 0.05 < implement 预估（deepseek-v4-pro → ~0.077）
    fixture.store.updateMission('M-1', { spent_equiv_usd: 1.95 })
    await orchestrator.run()
    const events = fixture.store.listEvents('M-1')
    const short = events.find((e) => e.kind === 'budget_short_circuit' && e.task_id === 'T-1')
    expect(short).toBeDefined()
    expect((short!.payload as { remaining_usd: number }).remaining_usd).toBeCloseTo(0.05, 4)
    // 任务保持 ready 未派发；后端未被调用
    expect(fixture.store.getTask('T-1')!.status).toBe('ready')
    expect(fixture.backends['claude']!.started).toHaveLength(0)
  })

  it('预算充足 → 正常派发执行', async () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo, budgetUsd: 2 }))
    orchestrator.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    await orchestrator.run()
    expect(fixture.store.getTask('T-1')!.status).toBe('done')
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'budget_short_circuit')).toBe(false)
  })
})

describe('watchdog 接线（任务空闲 kill + 故障分类）', () => {
  it('短阈值 idle → kill + blocked(idle_timeout)', async () => {
    const orchestrator = makeOrchestrator(fixture, { 'T-1': { hang: true } })
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    orchestrator.setWatchdogThreshold('task-idle', 100)
    await orchestrator.dispatchNext()
    fixture.clockNow += 101
    orchestrator.tickWatchdogs()
    const task = fixture.store.getTask('T-1')!
    expect(task.status).toBe('blocked')
    expect(task.fault).toBe('idle_timeout')
    expect(fixture.backends.claude!.kills.length).toBeGreaterThan(0)
  })
})

describe('maintenanceTick（CR-05-6：宿主周期巡检 = watchdog + 审批超期）', () => {
  it('审批超期 → staleApprovals 返回 + mission 自动 pause', async () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks(plan())
    await orchestrator.run()
    const approval = fixture.store.listApprovals('M-1')[0]!
    fixture.clockNow += APPROVAL_STALE_MS + 1
    const result = orchestrator.maintenanceTick()
    expect(result.staleApprovals).toEqual([approval.id])
    expect(fixture.store.getMission('M-1')!.status).toBe('paused')
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'mission_paused_stale_approval')).toBe(true)
  })

  it('watchdog 触发计入 watchdogFired（空闲超时 kill 路径经 maintenanceTick）', async () => {
    const orchestrator = makeOrchestrator(fixture, { 'T-1': { hang: true } })
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    orchestrator.setWatchdogThreshold('task-idle', 100)
    await orchestrator.dispatchNext()
    fixture.clockNow += 101
    const result = orchestrator.maintenanceTick()
    expect(result.watchdogFired).toBeGreaterThan(0)
    expect(fixture.store.getTask('T-1')!.status).toBe('blocked')
    expect(fixture.store.getTask('T-1')!.fault).toBe('idle_timeout')
  })
})

describe('humanResolve（3.4 节转人工接管，CR-06-8）', () => {
  function makeEscalated(orchestrator: MissionOrchestrator): void {
    // 「无人可派」（能力缺口）→ ready→escalated，attempts 不消费
    orchestrator.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['翻译'] }])
  }

  it('escalated → done：以证据（commit/parent）完成，事件落盘', async () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    makeEscalated(orchestrator)
    await orchestrator.dispatchNext()
    expect(fixture.store.getTask('T-1')!.status).toBe('escalated')
    fixture.clockNow += 1
    orchestrator.humanResolve('T-1', { outcome: 'done', commit_sha: 'abc123', parent_sha: 'def456', note: '人工核验 worktree 实现真实' })
    const task = fixture.store.getTask('T-1')!
    expect(task.status).toBe('done')
    expect(task.commit_sha).toBe('abc123')
    expect(task.parent_sha).toBe('def456')
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'task_human_resolved')).toBe(true)
  })

  it('escalated → blocked：保留 attempts 可重试（下一轮派发）', async () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    makeEscalated(orchestrator)
    await orchestrator.dispatchNext()
    expect(fixture.store.getTask('T-1')!.status).toBe('escalated')
    fixture.clockNow += 1
    orchestrator.humanResolve('T-1', { outcome: 'blocked', note: '人工判定需返工' })
    const task = fixture.store.getTask('T-1')!
    expect(task.status).toBe('blocked')
    expect(task.fault).toBeUndefined()
  })

  it('非 escalated 任务不可接管（状态机裁决）', () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    expect(() => orchestrator.humanResolve('T-1', { outcome: 'done' })).toThrowError(/escalated/i)
  })
})

describe('HITL 事件汇聚不变量（AgentScope-G / EV-3）', () => {
  it('所有 HITL 触发事件必进 mission 事件流（无仅内存路径）', async () => {
    const orchestrator = makeOrchestrator(fixture, {
      'T-1': {
        progress: [{ slot_id: 'M-1-S-1', task_id: 'T-1', ts: 1, kind: 'text', text: '开始实现' }],
        completion: {
          exit: 'done',
          report: doneReport('T-1'),
          usage: { tokens_in: 10, tokens_out: 5, source: 'measured' },
          artifacts: [],
        },
      },
    })
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks(plan())
    await orchestrator.run()
    const kinds = fixture.store.listEvents('M-1').map((e) => e.kind)
    // 一次完整链（实现→review→审批卡）应覆盖：派发/进度/完成/审批请求
    for (const required of ['mission_started', 'task_dispatched', 'worker_progress', 'task_done', 'approval_requested']) {
      expect(kinds).toContain(required)
    }
  })

  it('转人工（escalated）与人工接管事件也进流（commander/Canvas 可见）', async () => {
    const orchestrator = makeOrchestrator(fixture, {})
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['翻译'] }])
    await orchestrator.dispatchNext()
    expect(fixture.store.getTask('T-1')!.status).toBe('escalated')
    const kinds = fixture.store.listEvents('M-1').map((e) => e.kind)
    expect(kinds).toContain('task_escalated')
    fixture.clockNow += 1
    orchestrator.humanResolve('T-1', { outcome: 'blocked', note: '能力缺口，人工改配' })
    expect(fixture.store.listEvents('M-1').map((e) => e.kind)).toContain('task_human_resolved')
  })
})

describe('DoD-19：进度事件经 emitWorkerProgress 落 reply_id（事件→消息态重建）', () => {
  it('worker_progress 事件带 reply_id/seq，可按 slot+reply 聚合重建员工回复', async () => {
    const orchestrator = makeOrchestrator(fixture, {
      'T-1': {
        progress: [
          { slot_id: 'M-1-S-1', task_id: 'T-1', ts: 1, kind: 'text', text: '第一步' },
          { slot_id: 'M-1-S-1', task_id: 'T-1', ts: 2, kind: 'tool_call', tool: 'Read' },
          { slot_id: 'M-1-S-1', task_id: 'T-1', ts: 3, kind: 'text', text: '第二步' },
        ],
        completion: {
          exit: 'done',
          report: doneReport('T-1'),
          usage: { tokens_in: 10, tokens_out: 5, source: 'measured' },
          artifacts: [],
        },
      },
    })
    orchestrator.launch(launchInput({ cwd: fixture.repo }))
    orchestrator.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    await orchestrator.run()
    const events = fixture.store.listEvents('M-1').filter((e) => e.kind === 'worker_progress')
    expect(events.length).toBeGreaterThanOrEqual(3)
    const replyIds = new Set(events.map((e) => e.payload.reply_id as string))
    expect(replyIds.size).toBe(1) // 同任务共享 reply_id
    const seqs = events.map((e) => e.payload.seq as number)
    expect(seqs.every((s) => typeof s === 'number')).toBe(true)
  })

describe('v0.2 审批模式经 experiments 灰度（Berd-E）', () => {
  // 带 experiments 桩的编排器：enabled 数组 = 已开启的灰度 key
  function orchWithExp(enabled: string[]) {
    const backends = {
      claude: new FakeBackend('claude', {}),
      codex: new FakeBackend('codex', {}),
    }
    fixture.backends = backends
    return new MissionOrchestrator('M-1', {
      store: fixture.store,
      backends,
      worktree: makeWorktreeManager(fixture),
      clock: () => fixture.clockNow,
      experiments: { isEnabled: (k) => enabled.includes(k) },
      verify: async (task, report) => ({
        ok: true,
        commit_sha: report.commit_sha,
        parent_sha: `${task.id}-parent`,
        failures: [],
        mismatch: false,
      }),
    })
  }

  it('模式 3 灰度未开 → launch 拒绝（APPROVAL_MODE_DISABLED，fail-closed）', () => {
    const orch = orchWithExp([])
    expect(() => orch.launch(launchInput({ cwd: fixture.repo, approvalMode: 3 as const }))).toThrow(/gated behind experiments/)
  })

  it('模式 3 灰度开启 → 质量门通过后全自动直通 done（无审批卡）', async () => {
    const orch = orchWithExp(['approval-mode-3'])
    orch.launch(launchInput({ cwd: fixture.repo, approvalMode: 3 as const }))
    orch.createTasks(plan())
    const summary = await orch.run()
    expect(summary.status).toBe('done')
    expect(summary.pendingApprovals).toHaveLength(0)
    expect(fixture.store.listApprovals('M-1').filter((a) => a.kind === 'merge')).toHaveLength(0)
    expect(fixture.store.getMission('M-1')!.status).toBe('done')
  })

  it('模式 2 灰度未开 → launch 拒绝', () => {
    const orch = orchWithExp([])
    expect(() => orch.launch(launchInput({ cwd: fixture.repo, approvalMode: 2 as const }))).toThrow(/gated behind experiments/)
  })

  it('模式 2 灰度开启 → 派发前弹卡 awaiting_dispatch；批准后执行，最终仍走 merge 门', async () => {
    const orch = orchWithExp(['approval-mode-2'])
    orch.launch(launchInput({ cwd: fixture.repo, approvalMode: 2 as const }))
    orch.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    let summary = await orch.run()
    expect(summary.status).toBe('awaiting_dispatch')
    const gate = fixture.store.listApprovals('M-1').find((a) => a.kind === 'dispatch')!
    expect(gate).toBeDefined()
    expect(gate.task_id).toBe('T-1')
    // 未放行前任务保持 ready（不派发）
    expect(fixture.store.getTask('T-1')!.status).toBe('ready')
    // 人工批准派发门 → 重新驱动执行
    orch.approveDispatchGate(gate.id, 'user')
    summary = await orch.run()
    expect(fixture.store.getTask('T-1')!.status).toBe('done')
    // 模式 2 的合并交付仍是 merge 门（awaiting_approval）
    expect(summary.status).toBe('awaiting_approval')
    const mergeCard = fixture.store.listApprovals('M-1').find((a) => a.kind === 'merge')!
    expect(mergeCard).toBeDefined()
  })

  it('模式 2 派发门驳回 → 对应任务转人工（escalated）', async () => {
    const orch = orchWithExp(['approval-mode-2'])
    orch.launch(launchInput({ cwd: fixture.repo, approvalMode: 2 as const }))
    orch.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    await orch.run()
    const gate = fixture.store.listApprovals('M-1').find((a) => a.kind === 'dispatch')!
    orch.denyDispatchGate(gate.id, 'user', '不该派')
    expect(fixture.store.getTask('T-1')!.status).toBe('escalated')
  })
})
})
describe('v0.2 任务中途换人正式化（reassignTask）', () => {
  const imp = () => [
    { id: 'S-1', vendor: 'claude' as const, role: 'implementer', capabilities: ['编码'], model: 'm', session_tier: 'per-mission' as const },
    { id: 'S-2', vendor: 'claude' as const, role: 'implementer', capabilities: ['编码'], model: 'm', session_tier: 'per-mission' as const },
  ]
  const doneR = (id: string) => ({
    exit: 'done' as const,
    report: doneReport(id),
    usage: { tokens_in: 10, tokens_out: 5, source: 'measured' as const },
    artifacts: [],
  })

  it('reassign：blocked 任务转给 S-2 → 交接落盘 + owner 转移 + ready + 重派到 S-2 完成', async () => {
    const orch = makeOrchestrator(fixture, { 'T-1': { delayMs: 40, completion: doneR('T-1') } })
    orch.launch(launchInput({ cwd: fixture.repo, slots: imp() }))
    orch.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    // 制造 T-1 已归属 S-1 且失败（blocked）——人工换人的前置（同 humanResolve 合法写）
    fixture.store.updateTask('T-1', { owner_slot_id: 'M-1-S-1', status: 'blocked', fault: 'crash' })
    const h = await orch.reassignTask('T-1', 'M-1-S-2', '原槽位卡死')
    expect(h.id).toMatch(/^H-/)
    expect(h.to_slot).toBe('M-1-S-2')
    expect(fixture.store.listHandoffs('M-1')).toHaveLength(1)
    expect(h.payload.intent.brief).toContain('原槽位卡死')
    expect(fixture.store.getTask('T-1')!.owner_slot_id).toBe('M-1-S-2')
    expect(fixture.store.getTask('T-1')!.status).toBe('ready')
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'task_reassigned')).toBe(true)
    await orch.run()
    expect(fixture.store.getTask('T-1')!.status).toBe('done')
  })

  it('reassign：done 已终态拒绝；目标槽位不可用拒绝', async () => {
    const orch = makeOrchestrator(fixture, {})
    orch.launch(launchInput({ cwd: fixture.repo, slots: imp() }))
    orch.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    fixture.store.updateTask('T-1', { status: 'done' })
    await expect(orch.reassignTask('T-1', 'M-1-S-2', 'x')).rejects.toThrow(/cannot reassign a done task/)
    fixture.store.updateTask('T-1', { status: 'ready', owner_slot_id: undefined })
    fixture.store.updateSlot('M-1-S-2', { status: 'error' })
    await expect(orch.reassignTask('T-1', 'M-1-S-2', 'x')).rejects.toThrow(/target slot unavailable/)
  })
})

describe('v0.2 并行执行强化（双路+，dispatchBatch 填满 maxParallel）', () => {
  const twoImplementers = [
    { id: 'S-1', vendor: 'claude' as const, role: 'implementer', capabilities: ['编码'], model: 'm', session_tier: 'per-mission' as const },
    { id: 'S-2', vendor: 'claude' as const, role: 'implementer', capabilities: ['编码'], model: 'm', session_tier: 'per-mission' as const },
  ]
  const twoIndepTasks = () => [
    { id: 'T-1', title: 'A', spec: 's', type: 'implement' as const, skill_tags: ['编码'] },
    { id: 'T-2', title: 'B', spec: 's', type: 'implement' as const, skill_tags: ['编码'] },
  ]
  const doneX = (id: string) => ({
    exit: 'done' as const,
    report: doneReport(id),
    usage: { tokens_in: 10, tokens_out: 5, source: 'measured' as const },
    artifacts: [],
  })

  it('launch parallel=2：两个独立实现任务同轮并行派发（peakActive=2）', async () => {
    const orch = makeOrchestrator(fixture, { 'T-1': { delayMs: 40, completion: doneX('T-1') }, 'T-2': { delayMs: 40, completion: doneX('T-2') } })
    orch.launch(launchInput({ cwd: fixture.repo, parallel: 2, slots: twoImplementers }))
    orch.createTasks(twoIndepTasks())
    await orch.run()
    // 两任务同轮派满 2 个槽位 → 并发峰值为 2（而非单路串行）
    expect(fixture.backends.claude!.peakActive).toBe(2)
    expect(fixture.store.getTask('T-1')!.status).toBe('done')
    expect(fixture.store.getTask('T-2')!.status).toBe('done')
    expect(fixture.store.getTask('T-1')!.owner_slot_id).not.toBe(fixture.store.getTask('T-2')!.owner_slot_id)
  })

  it('launch parallel=1：并行上限收紧到单路（clamp 下限）→ peakActive=1', async () => {
    const orch = makeOrchestrator(fixture, { 'T-1': { delayMs: 40, completion: doneX('T-1') } })
    orch.launch(launchInput({ cwd: fixture.repo, parallel: 1, slots: twoImplementers }))
    orch.createTasks(twoIndepTasks())
    await orch.run()
    expect(fixture.backends.claude!.peakActive).toBe(1)
    expect(fixture.store.getTask('T-1')!.status).toBe('done')
    expect(fixture.store.getTask('T-2')!.status).toBe('done')
  })

  it('依赖链在 dispatchBatch 下仍保持串行（review 依赖实现，不提前并发）', async () => {
    const orch = makeOrchestrator(fixture, { 'T-1': { delayMs: 40, completion: doneX('T-1') }, 'T-2': { delayMs: 40, completion: doneX('T-2') } })
    orch.launch(launchInput({ cwd: fixture.repo, parallel: 2, slots: twoImplementers }))
    orch.createTasks([
      { id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] },
      { id: 'T-2', title: '依赖 T-1', spec: 's', type: 'implement', skill_tags: ['编码'], depends_on: ['T-1'] },
    ])
    await orch.run()
    expect(fixture.backends.claude!.peakActive).toBe(1) // 依赖使然，并行不破坏拓扑
    expect(fixture.store.getTask('T-1')!.status).toBe('done')
    expect(fixture.store.getTask('T-2')!.status).toBe('done')
  })
})

describe('v0.2 cross-review / bake-off 阵型强化（4.3：异构交叉审查抓盲点）', () => {
  // 双实现者（都带编码+审查能力）→ 并行实现 + 交叉互审（review 不派给被审实现者）
  const twoCross = () => [
    { id: 'S-1', vendor: 'claude' as const, role: 'implementer', capabilities: ['编码', '审查'], model: 'm', session_tier: 'per-mission' as const },
    { id: 'S-2', vendor: 'codex' as const, role: 'implementer', capabilities: ['编码', '审查'], model: 'm', session_tier: 'transient' as const },
  ]
  const doneC = (id: string) => ({
    exit: 'done' as const,
    report: doneReport(id),
    usage: { tokens_in: 10, tokens_out: 5, source: 'measured' as const },
    artifacts: [],
  })

  it('cross-review 互审阵型：双实现并行 + 交叉审查，审查者≠实现者，质量门全过后进审批', async () => {
    const orch = makeOrchestrator(fixture, {
      'T-1': { delayMs: 30, completion: doneC('T-1') },
      'T-2': { delayMs: 30, completion: doneC('T-2') },
      'T-3': { delayMs: 30, completion: doneC('T-3') },
      'T-4': { delayMs: 30, completion: doneC('T-4') },
    })
    orch.launch(launchInput({ cwd: fixture.repo, parallel: 2, slots: twoCross() }))
    orch.createTasks([
      { id: 'T-1', title: '实现A', spec: 's', type: 'implement', skill_tags: ['编码'] },
      { id: 'T-2', title: '实现B', spec: 's', type: 'implement', skill_tags: ['编码'] },
      { id: 'T-3', title: '互审 T-1', spec: '审A', type: 'review', skill_tags: ['审查'], depends_on: ['T-1'] },
      { id: 'T-4', title: '互审 T-2', spec: '审B', type: 'review', skill_tags: ['审查'], depends_on: ['T-2'] },
    ])
    const summary = await orch.run()
    expect(summary.status).toBe('awaiting_approval') // 双实现 + 双审查全过 → 质量门过
    const t1 = fixture.store.getTask('T-1')!
    const t2 = fixture.store.getTask('T-2')!
    const t3 = fixture.store.getTask('T-3')!
    const t4 = fixture.store.getTask('T-4')!
    expect([t1.owner_slot_id, t2.owner_slot_id].sort()).toEqual(['M-1-S-1', 'M-1-S-2'].sort())
    // 交叉：T-3 审 T-1（排除 S-1 实现者）→ S-2；T-4 审 T-2（排除 S-2 实现者）→ S-1
    expect(t3.owner_slot_id).toBe('M-1-S-2')
    expect(t4.owner_slot_id).toBe('M-1-S-1')
    expect(t1.owner_slot_id).not.toBe(t3.owner_slot_id)
    expect(t2.owner_slot_id).not.toBe(t4.owner_slot_id)
  })
})

describe('W4 暂停/恢复（pod_pause / pod_resume）', () => {
  it('运行中 mission 可暂停 → 状态 paused → 恢复（无 pending 审批卡回 running）', async () => {
    const fx = await makeFixture()
    const orch = new MissionOrchestrator('M-1', {
      store: fx.store,
      backends: { claude: new FakeBackend('claude', {}), codex: new FakeBackend('codex', {}) },
      worktree: { ensure: async () => fx.repo },
      verify: async (task, report) => ({ ok: true, failures: [], commit_sha: report.commit_sha, parent_sha: task.id + '-parent', mismatch: false }),
      diffProvider: async () => '',
    })
    orch.launch({ name: 'p', goal: 'g', cwd: fx.repo, budgetUsd: 2, slots: [{ id: 'S-1', vendor: 'claude', role: 'implementer', capabilities: ['编码'] }] })
    orch.createTasks([{ id: 'T-1', title: 't', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    void orch.run()
    await new Promise((r) => setTimeout(r, 20))
    orch.pause()
    expect(fx.store.getMission('M-1')!.status).toBe('paused')
    orch.resume()
    const status = fx.store.getMission('M-1')!.status
    // 有 pending 审批卡（实现完成待审查/待合并）→ awaiting_approval 或继续 running
    expect(['running', 'awaiting_approval', 'done']).toContain(status)
    fx.store.close()
    rmSync(fx.root, { recursive: true, force: true })
  })
})


describe('DoD-19 result_summary（非写码任务 report 摘要落盘 + review 注入）', () => {
  it('research 任务 done → result_summary 落盘；review 收到摘要注入', async () => {
    const fx = await makeFixture()
    const orch = new MissionOrchestrator('M-1', {
      store: fx.store,
      backends: { ark: new FakeBackend('ark', {
        'T-1': { completion: { exit: 'done', report: doneReport('T-1', { task_type: 'research', summary: '研究报告：WAL 在单机单用户场景收益有限' }), usage: { tokens_in: 10, tokens_out: 5, source: 'measured' }, artifacts: [] } },
        'T-2': { completion: { exit: 'done', report: doneReport('T-2', { task_type: 'review', summary: '审查通过' }), usage: { tokens_in: 10, tokens_out: 5, source: 'measured' }, artifacts: [] } },
      }) },
      worktree: { ensure: async () => fx.repo },
      verify: async (task, report) => ({ ok: true, failures: [], commit_sha: report.commit_sha, parent_sha: task.id + '-p', mismatch: false }),
      diffProvider: async () => '（无 diff）',
    })
    orch.launch({ name: 'r', goal: 'g', cwd: fx.repo, budgetUsd: 2, slots: [{ id: 'S-1', vendor: 'ark', role: 'researcher', capabilities: [] }, { id: 'S-2', vendor: 'ark', role: 'reviewer', capabilities: ['审查'] }] })
    orch.createTasks([
      { id: 'T-1', title: '研究', spec: '研究 WAL', type: 'research', skill_tags: [] },
      { id: 'T-2', title: '审查', spec: '审查 T-1', type: 'review', skill_tags: ['审查'], depends_on: ['T-1'] },
    ])
    const summary = await orch.run()
    const t1 = fx.store.getTask('T-1')!
    expect(t1.result_summary).toContain('WAL')
    expect(t1.result_summary).toContain('单机单用户')
    // review 派发 spec 注入 T-1 摘要（审查者能拿到产物内容）
    const dispatched = fx.store.listEvents('M-1').filter((e) => e.kind === 'task_dispatched' && e.task_id === 'T-2')
    expect(dispatched.length).toBeGreaterThan(0)
    void summary
    fx.store.close()
    rmSync(fx.root, { recursive: true, force: true })
  })
})


describe('P0 修复：驱动循环可靠性与重启恢复', () => {
  const doneC = (id: string): WorkerCompletion => ({
    exit: 'done',
    report: doneReport(id),
    usage: { tokens_in: 10, tokens_out: 5, source: 'measured' },
    artifacts: [],
  })
  const rateLimited = (): WorkerCompletion => ({
    exit: 'rate_limited',
    usage: { tokens_in: 1, tokens_out: 1, source: 'measured' },
    artifacts: [],
  })

  it('pause 停止派发并如实上报 paused；resume 自动重驱（此前 resume 后永久停摆）', async () => {
    const orch = makeOrchestrator(fixture, { 'T-1': { delayMs: 20, completion: doneC('T-1') } })
    orch.launch(launchInput({ cwd: fixture.repo }))
    orch.createTasks([
      { id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] },
      { id: 'T-2', title: '审查', spec: 'r', type: 'review', skill_tags: ['审查'], depends_on: ['T-1'] },
    ])
    const runPromise = orch.run()
    await until(() => fixture.backends.claude!.started.length === 1)
    orch.pause()
    expect(fixture.store.getMission('M-1')!.status).toBe('paused')
    const summary = await runPromise
    expect(summary.status).toBe('paused')
    // 暂停期间不再派新任务（T-2 依赖 T-1，此处验证无派发行为）
    const dispatchedDuringPause = fixture.backends.codex!.started.length
    expect(dispatchedDuringPause).toBe(0)
    // resume → 不显式调 run()，自动重驱，链条走完进审批
    orch.resume()
    expect(orch.driveActive()).toBe(true)
    await until(() => fixture.store.getMission('M-1')!.status === 'awaiting_approval')
    expect(fixture.store.getTask('T-1')!.status).toBe('done')
    expect(fixture.store.getTask('T-2')!.status).toBe('done')
  })

  it('maintenanceTick 停摆补偿：退避到期的 blocked 任务自动重派（此前无人重驱）', async () => {
    const orch = makeOrchestrator(fixture, { 'T-1': { completion: rateLimited(), next: doneC('T-1') } })
    orch.launch(launchInput({ cwd: fixture.repo }))
    orch.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    const s1 = await orch.run()
    expect(s1.status).toBe('waiting_backoff')
    expect(fixture.store.getTask('T-1')!.status).toBe('blocked')
    expect(orch.driveActive()).toBe(false)
    // 退避到期（首次 rate_limited 退避 ≤ 2×BASE=10s，推进 60s 足够）
    fixture.clockNow += 60_000
    orch.maintenanceTick()
    await until(() => fixture.store.getTask('T-1')!.status === 'done')
    expect(fixture.backends.claude!.started.length).toBe(2) // 重试派发发生
  })

  it('abortMission：树杀在途 worker + summary 如实上报 aborted（此前不杀进程且伪装 needs_human）', async () => {
    const orch = makeOrchestrator(fixture, { 'T-1': { hang: true } })
    orch.launch(launchInput({ cwd: fixture.repo }))
    orch.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    const runPromise = orch.run()
    await until(() => fixture.backends.claude!.started.length === 1)
    orch.abortMission('测试中止')
    await until(() => fixture.backends.claude!.kills.length === 1)
    expect(fixture.store.getMission('M-1')!.status).toBe('aborted')
    const summary = await runPromise
    expect(summary.status).toBe('aborted')
  })

  it('run() 重入守卫：驱动在途时并发调用返回同一 promise（防双循环抢派）', async () => {
    const orch = makeOrchestrator(fixture, { 'T-1': { hang: true } })
    orch.launch(launchInput({ cwd: fixture.repo }))
    orch.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    const p1 = orch.run()
    const p2 = orch.run()
    expect(p2).toBe(p1)
    orch.abortMission('收尾')
    await p1
  })

  it('recoverFromRestart：孤儿 dispatched 任务按 crash 故障化（此前重启后永久卡死）', async () => {
    const orch1 = makeOrchestrator(fixture, { 'T-1': { hang: true } })
    orch1.launch(launchInput({ cwd: fixture.repo }))
    orch1.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    // 模拟宿主重启前的在途状态：任务已派发，worker 进程随宿主死亡
    await orch1.dispatchNext()
    // dispatchTask 内 dispatch→start 连续迁移，孤儿态是 running（dispatched 为瞬态，两者恢复逻辑同 path）
    expect(['dispatched', 'running']).toContain(fixture.store.getTask('T-1')!.status)
    // 模拟重启：同 store 上的新编排器实例做恢复
    const orch2 = makeOrchestrator(fixture, {})
    const recovery = orch2.recoverFromRestart()
    expect(recovery.orphanedTasks).toEqual(['T-1'])
    const task = fixture.store.getTask('T-1')!
    expect(task.status).toBe('blocked')
    expect(task.fault).toBe('crash')
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'mission_recovered')).toBe(true)
  })
})

describe('P1 id 白名单（防 worktree 路径逃逸与 argv 注入）', () => {
  it('slot id 含路径分隔符/.. → launch 拒绝（INVALID_ID）', () => {
    const orch = makeOrchestrator(fixture, {})
    for (const id of ['../evil', 'a/b', 'a\\b', 'a b', '.hidden']) {
      expect(() =>
        orch.launch(launchInput({ cwd: fixture.repo, slots: [{ id, vendor: 'claude', role: 'implementer', capabilities: ['编码'], model: 'm', session_tier: 'per-mission' }] })),
      ).toThrow(/slot id rejected/)
    }
  })
  it('task id 含路径分隔符 → createTasks 拒绝', () => {
    const orch = makeOrchestrator(fixture, {})
    orch.launch(launchInput({ cwd: fixture.repo }))
    expect(() =>
      orch.createTasks([{ id: 'T-1/../../evil', title: 'x', spec: 's', type: 'implement', skill_tags: ['编码'] }]),
    ).toThrow(/task id rejected/)
  })
})

describe('P1 规划层（goal → DAG 智能分解，AgentScope DAGPlanExecutor 借鉴）', () => {
  const plannerRoster = [
    { id: 'S-P', vendor: 'claude' as const, role: 'planner', capabilities: ['规划'], model: 'm', session_tier: 'per-mission' as const },
    { id: 'S-1', vendor: 'claude' as const, role: 'implementer', capabilities: ['编码'], model: 'm', session_tier: 'per-mission' as const },
    { id: 'S-2', vendor: 'codex' as const, role: 'reviewer', capabilities: ['审查'], model: '', session_tier: 'transient' as const },
  ]
  const validPlan = [
    { id: 'T-1', title: '实现', spec: 's', type: 'implement' as const, skill_tags: ['编码'], depends_on: [] },
    { id: 'T-2', title: '独立 review', spec: 'r', type: 'review' as const, skill_tags: ['审查'], depends_on: ['T-1'] },
  ]
  // plan 参数放宽为通用 shape（非法提案同样塞进 report，由 validatePlanProposal 裁决）
  type PlanShape = Array<{ id: string; title: string; spec: string; type: 'implement' | 'review' | 'test' | 'doc' | 'research'; skill_tags?: string[]; depends_on?: string[] }>
  const planDone = (taskId: string, plan: PlanShape | undefined): WorkerCompletion => ({
    exit: 'done',
    report: doneReport(taskId, { task_type: 'plan', ...(plan !== undefined ? { plan } : {}) }),
    usage: { tokens_in: 10, tokens_out: 5, source: 'measured' },
    artifacts: [],
  })

  it('planner 槽位检测 + createPlannerTask：P-1 type=plan、skill_tags=[规划]', () => {
    const orch = makeOrchestrator(fixture, {})
    orch.launch(launchInput({ cwd: fixture.repo, slots: plannerRoster }))
    expect(orch.hasPlannerCapability()).toBe(true)
    const task = orch.createPlannerTask('给仓库加登录')
    expect(task.id).toBe('P-1')
    expect(task.type).toBe('plan')
    expect(task.skill_tags).toEqual(['规划'])
    expect(task.spec).toContain('给仓库加登录')
    expect(task.spec).toContain('S-P（planner）：规划')
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'plan_delegation')).toBe(true)
  })

  it('规划任务完成 + 提案通过裁决 → expand 为任务 DAG 并走完质量门', async () => {
    const orch = makeOrchestrator(fixture, { 'P-1': { completion: planDone('P-1', validPlan) } })
    orch.launch(launchInput({ cwd: fixture.repo, slots: plannerRoster }))
    orch.createPlannerTask('目标')
    const summary = await orch.run()
    // P-1 → 提案落盘 T-1/T-2 → 实现+审查完成 → 进审批
    expect(fixture.store.getTask('P-1')!.status).toBe('done')
    expect(fixture.store.getTask('T-1')!.status).toBe('done')
    expect(fixture.store.getTask('T-2')!.status).toBe('done')
    expect(summary.status).toBe('awaiting_approval')
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'plan_expanded')).toBe(true)
    // Context Builder：每次派发落 task_context 事件（实际发给 agent 的完整上下文）
    const ctxEvents = fixture.store.listEvents('M-1').filter((e) => e.kind === 'task_context')
    expect(ctxEvents.length).toBeGreaterThanOrEqual(3) // 每次派发一条（P-1 + 实现任务；重派也各落一条）
    const ctxPayload = ctxEvents[0]!.payload as { spec?: string; to_slot?: string; base_length?: number; final_length?: number }
    expect(typeof ctxPayload.spec).toBe('string')
    expect(ctxPayload.spec!.length).toBeGreaterThan(0)
    expect(ctxPayload.to_slot).toContain('S-')
    expect(ctxPayload.final_length).toBeGreaterThanOrEqual(ctxPayload.base_length ?? 0)
    // 回归（审批 diff 实证）：plan 任务（无 commit）不得成为合并单元——primary 必须
    // 是带 commit 的实现任务，否则审批卡 base/head 缺失、详情页无 diff 可审
    const pending = fixture.store.listApprovals('M-1').find((a) => a.status === 'pending')
    expect(pending).toBeDefined()
    expect(pending!.patch.base_commit).toBeDefined()
    expect(pending!.patch.head_commit).toBeDefined()
  })

  it('提案缺失/非法 → silent_failure 走重试，绝不落盘脏任务图', async () => {
    // 首次完成无 plan；重试（默认完成）也无 plan → attempts 用尽转人工
    const orch = makeOrchestrator(fixture, { 'P-1': { completion: planDone('P-1', undefined) } })
    orch.launch(launchInput({ cwd: fixture.repo, slots: plannerRoster }))
    orch.createPlannerTask('目标')
    const summary = await orch.run()
    expect(summary.status).toBe('needs_human')
    expect(fixture.store.getTask('P-1')!.status).toBe('escalated')
    // 展开从未发生：任务图里只有规划任务自身
    expect(fixture.store.listTasks('M-1').map((t) => t.id)).toEqual(['P-1'])
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'plan_rejected')).toBe(true)
    // 规划任务自身失败不触发自动重规划
    expect(orch.replanRemaining()).toBe(2)
  })

  it('语义类拒绝（能力缺口）→ 执行侧约束写回失败任务 spec + plan_rejected 标注（P1 feedback 环）', async () => {
    const gapPlan = [
      { id: 'T-1', title: '实现', spec: 's', type: 'implement' as const, skill_tags: ['运维'], depends_on: [] },
      { id: 'T-2', title: '独立 review', spec: 'r', type: 'review' as const, skill_tags: ['审查'], depends_on: ['T-1'] },
    ]
    const orch = makeOrchestrator(fixture, { 'P-1': { completion: planDone('P-1', gapPlan) } })
    orch.launch(launchInput({ cwd: fixture.repo, slots: plannerRoster }))
    orch.createPlannerTask('目标')
    await orch.run()
    const p1 = fixture.store.getTask('P-1')!
    // 反馈已写回失败任务 spec——重试即带执行侧约束（此前按原 spec 无反馈重试，同样错误反复发生）
    expect(p1.spec).toContain('上次提案被拒的反馈（执行侧约束）')
    expect(p1.spec).toContain('T-1 需求 [运维]')
    expect(p1.spec).toContain('名册实际能力')
    const ev = fixture.store.listEvents('M-1').find((e) => e.kind === 'plan_rejected')!
    expect((ev.payload.semantic as string[]).some((s) => s.includes('capability gap'))).toBe(true)
    expect(ev.payload.feedback_applied).toBe(true)
  })

  it('feedback v2（灰度 feedback-consult）：语义拒绝 → 真咨询最匹配槽位 worker，咨询结果写回 spec', async () => {
    const gapPlan = [
      { id: 'T-1', title: '实现', spec: 's', type: 'implement' as const, skill_tags: ['运维'], depends_on: [] },
    ]
    const consult = vi.fn(async (prompt: string) => {
      // 断言 prompt 带缺口标签与目标槽位能力（交集为 0 也咨询最接近的槽位，id 升序 → S-1）
      expect(prompt).toContain('运维')
      expect(prompt).toContain('S-1')
      expect(prompt).toContain('编码')
      expect(prompt).toContain('任务规格')
      return { ok: true, text: '可用脚本绕过：运维类需求可用 claude 自带工具链完成，无需新增槽位' }
    })
    const orch = makeOrchestrator(fixture, { 'P-1': { completion: planDone('P-1', gapPlan) } }, 'M-1', {
      consult,
      experiments: { isEnabled: (key) => key === 'feedback-consult' },
    })
    orch.launch(launchInput({ cwd: fixture.repo, slots: plannerRoster }))
    orch.createPlannerTask('目标')
    await orch.run()
    expect(consult).toHaveBeenCalledTimes(1)
    const p1 = fixture.store.getTask('P-1')!
    expect(p1.spec).toContain('上次提案被拒的反馈（LLM 咨询·执行侧约束）')
    expect(p1.spec).toContain('可用脚本绕过')
    const ev = fixture.store.listEvents('M-1').find((e) => e.kind === 'plan_rejected')!
    expect(ev.payload.feedback_mode).toBe('consult')
  })

  it('feedback v2：咨询失败（ok=false）→ 回落 v1 名册反馈（feedback_mode=roster）', async () => {
    const gapPlan = [
      { id: 'T-1', title: '实现', spec: 's', type: 'implement' as const, skill_tags: ['运维'], depends_on: [] },
    ]
    const consult = vi.fn(async () => ({ ok: false, text: '' }))
    const orch = makeOrchestrator(fixture, { 'P-1': { completion: planDone('P-1', gapPlan) } }, 'M-1', {
      consult,
      experiments: { isEnabled: (key) => key === 'feedback-consult' },
    })
    orch.launch(launchInput({ cwd: fixture.repo, slots: plannerRoster }))
    orch.createPlannerTask('目标')
    await orch.run()
    expect(consult).toHaveBeenCalledTimes(1)
    const p1 = fixture.store.getTask('P-1')!
    expect(p1.spec).toContain('上次提案被拒的反馈（执行侧约束）') // v1 标题
    expect(p1.spec).toContain('名册实际能力')
    const ev = fixture.store.listEvents('M-1').find((e) => e.kind === 'plan_rejected')!
    expect(ev.payload.feedback_mode).toBe('roster')
  })

  it('feedback v2：灰度关（默认）→ 不走咨询，行为与 v1 一致', async () => {
    const gapPlan = [
      { id: 'T-1', title: '实现', spec: 's', type: 'implement' as const, skill_tags: ['运维'], depends_on: [] },
    ]
    const consult = vi.fn(async () => ({ ok: true, text: '不应被调用' }))
    const orch = makeOrchestrator(fixture, { 'P-1': { completion: planDone('P-1', gapPlan) } }, 'M-1', { consult })
    orch.launch(launchInput({ cwd: fixture.repo, slots: plannerRoster }))
    orch.createPlannerTask('目标')
    await orch.run()
    expect(consult).not.toHaveBeenCalled()
    const p1 = fixture.store.getTask('P-1')!
    expect(p1.spec).toContain('上次提案被拒的反馈（执行侧约束）')
  })

  it('结构类拒绝（自依赖）→ 不写回反馈，plan_rejected 标注 structural（P1 feedback 环）', async () => {
    const badPlan = [
      { id: 'T-1', title: '实现', spec: 's', type: 'implement' as const, skill_tags: ['编码'], depends_on: ['T-1'] },
    ]
    const orch = makeOrchestrator(fixture, { 'P-1': { completion: planDone('P-1', badPlan) } })
    orch.launch(launchInput({ cwd: fixture.repo, slots: plannerRoster }))
    orch.createPlannerTask('目标')
    await orch.run()
    const p1 = fixture.store.getTask('P-1')!
    expect(p1.spec).not.toContain('上次提案被拒的反馈')
    const ev = fixture.store.listEvents('M-1').find((e) => e.kind === 'plan_rejected')!
    expect(ev.payload.semantic).toHaveLength(0)
    expect((ev.payload.structural as string[]).some((s) => s.includes('depends on itself'))).toBe(true)
    expect(ev.payload.feedback_applied).toBe(false)
  })

  it('自动重规划：实现任务转人工 → 带 failure 上下文的 P 任务；REPLAN_LIMIT 有界', async () => {
    // T-1 能力无人覆盖 → 派发即 escalate → 自动 requestReplan 生成 P-1；
    // P-1 完成仍无 plan → 重试耗尽 escalate（规划任务不再触发重规划）
    const orch = makeOrchestrator(fixture, { 'P-1': { completion: planDone('P-1', undefined) } })
    orch.launch(launchInput({ cwd: fixture.repo, slots: [plannerRoster[0]!, plannerRoster[1]!] }))
    orch.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['运维'] }])
    const summary = await orch.run()
    expect(summary.status).toBe('needs_human')
    const planTasks = fixture.store.listTasks('M-1').filter((t) => t.type === 'plan')
    expect(planTasks.length).toBe(1) // T-1 escalate 触发一次；P-1 自身 escalate 不再触发
    expect(planTasks[0]!.id).toBe('P-1')
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'plan_replan_requested')).toBe(true)
    expect(orch.replanRemaining()).toBe(1)
  })

  it('requestReplan 三重门：无 planner 拒绝 / 超限拒绝 / 预算不足跳过', () => {
    const orch = makeOrchestrator(fixture, {})
    orch.launch(launchInput({ cwd: fixture.repo })) // 无 planner 槽位（默认名册：编码+审查）
    expect(orch.requestReplan('x').requested).toBe(false)
    orch.abortMission('测试收尾') // 单 active mission：先终止再启下一个
    // 超限：直接消耗完额度
    const orch3 = makeOrchestrator(fixture, {}, 'M-3')
    orch3.launch(launchInput({ cwd: fixture.repo, slots: plannerRoster, budgetUsd: 100 }))
    expect(orch3.requestReplan('r1').requested).toBe(true)
    expect(orch3.requestReplan('r2').requested).toBe(true)
    expect(orch3.requestReplan('r3').requested).toBe(false) // REPLAN_LIMIT=2
    orch3.abortMission('测试收尾')
    // 预算门控：花光预算后拒绝
    const orch4 = makeOrchestrator(fixture, {}, 'M-4')
    orch4.launch(launchInput({ cwd: fixture.repo, slots: plannerRoster, budgetUsd: 0.001 }))
    const r = orch4.requestReplan('r')
    expect(r.requested).toBe(false)
    expect(fixture.store.listEvents('M-4').some((e) => e.kind === 'plan_replan_skipped')).toBe(true)
  })
})

describe('P2 对话式问题通道（task_question 事件）', () => {
  it('报告带 questions → task_question 事件落盘（前端弹选项卡的数据源）', async () => {
    const orch = makeOrchestrator(fixture, {
      'T-1': { completion: { exit: 'done', report: doneReport('T-1', { status: 'need_clarify', questions: ['用 SQLite 还是 LevelDB？'] }), usage: { tokens_in: 5, tokens_out: 5, source: 'measured' }, artifacts: [] }, next: { exit: 'done', report: doneReport('T-2'), usage: { tokens_in: 5, tokens_out: 5, source: 'measured' }, artifacts: [] } },
    })
    orch.launch(launchInput({ cwd: fixture.repo }))
    orch.createTasks([
      { id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] },
      { id: 'T-2', title: '独立 review', spec: 'r', type: 'review', skill_tags: ['审查'], depends_on: ['T-1'] },
    ])
    const summary = await orch.run()
    const q = fixture.store.listEvents('M-1').filter((e) => e.kind === 'task_question')
    expect(q.length).toBeGreaterThanOrEqual(1)
    expect((q[0]!.payload as { questions: string[] }).questions).toContain('用 SQLite 还是 LevelDB？')
    expect(q[0]!.task_id).toBe('T-1')
    void summary
  })

  it('need_clarify ×3 → escalated（烧钱封顶）：恰派发 3 次后转人工，不再无限自动重派', async () => {
    const needClarify = (): WorkerCompletion => ({
      exit: 'done',
      report: doneReport('T-1', { status: 'need_clarify', questions: ['用 SQLite 还是 LevelDB？'] }),
      usage: { tokens_in: 5, tokens_out: 5, source: 'measured' },
      artifacts: [],
    })
    const orch = makeOrchestrator(fixture, { 'T-1': { completion: needClarify(), next: needClarify() } })
    orch.launch(launchInput({ cwd: fixture.repo }))
    orch.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    const summary = await orch.run()
    expect(summary.status).toBe('needs_human')
    const t1 = fixture.store.getTask('M-1', 'T-1')!
    expect(t1.status).toBe('escalated')
    expect(t1.fault).toBe('need_clarify')
    expect(t1.soft_attempts).toBe(3)
    // 恰 3 次派发封顶（此前 soft 失败不烧 attempts，无人值守无限重派烧 LLM 调用）
    expect(fixture.backends.claude!.started.filter((s) => s.task.id === 'T-1').length).toBe(3)
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'task_escalated')).toBe(true)
  })

  it('steer 答复在 need_clarify 自动重派时注入 spec（问答闭环：提问 → steer 排队 → 重派带答复）', async () => {
    const needClarify = (): WorkerCompletion => ({
      exit: 'done',
      report: doneReport('T-1', { status: 'need_clarify', questions: ['用 SQLite 还是 LevelDB？'] }),
      usage: { tokens_in: 5, tokens_out: 5, source: 'measured' },
      artifacts: [],
    })
    const doneC = (): WorkerCompletion => ({
      exit: 'done',
      report: doneReport('T-1'),
      usage: { tokens_in: 5, tokens_out: 5, source: 'measured' },
      artifacts: [],
    })
    const orch = makeOrchestrator(fixture, { 'T-1': { completion: needClarify(), next: doneC(), delayMs: 30 } })
    orch.launch(launchInput({ cwd: fixture.repo }))
    orch.createTasks([{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    // 首次派发后立即 steer：答复排队，等 need_clarify blocked → 自动重派时消费注入
    // （delayMs 宏任务保证 steer 赶在完成回调/重派之前排队——微任务时序下重派先跑）
    const runPromise = orch.run()
    await until(() => fixture.backends.claude!.started.length === 1)
    orch.steer('S-1', '用 SQLite')
    await runPromise
    const started = fixture.backends.claude!.started.filter((s) => s.task.id === 'T-1')
    expect(started.length).toBe(2)
    expect(started[1]!.task.spec).toContain('排队指令')
    expect(started[1]!.task.spec).toContain('用 SQLite')
    expect(fixture.store.getTask('M-1', 'T-1')!.status).toBe('done')
  })
})

describe('P0 token 开销：审查上下文分级上限 + task_context 去重', () => {
  it('被审 spec 与 diff 都按上限截断（此前无上限，单次派发可达 12 万+ 字符）', async () => {
    const fx = await makeFixture()
    const longSpec = 'x'.repeat(20_000)
    const backend = new FakeBackend('ark', {
      'T-1': { completion: { exit: 'done', report: doneReport('T-1'), usage: { tokens_in: 10, tokens_out: 5, source: 'measured' }, artifacts: [] } },
      'T-2': { completion: { exit: 'done', report: doneReport('T-2', { task_type: 'review' }), usage: { tokens_in: 10, tokens_out: 5, source: 'measured' }, artifacts: [] } },
    })
    const orch = new MissionOrchestrator('M-1', {
      store: fx.store,
      backends: { ark: backend },
      worktree: { ensure: async () => fx.repo },
      verify: async (task, report) => ({ ok: true, failures: [], commit_sha: report.commit_sha, parent_sha: task.id + '-p', mismatch: false }),
      diffProvider: async () => 'd'.repeat(100_000),
    })
    orch.launch({
      name: 'r', goal: 'g', cwd: fx.repo, budgetUsd: 5,
      slots: [
        { id: 'S-1', vendor: 'ark', role: 'coder', capabilities: [] },
        { id: 'S-2', vendor: 'ark', role: 'reviewer', capabilities: ['审查'] },
      ],
    })
    orch.createTasks([
      { id: 'T-1', title: '实现', spec: longSpec, type: 'implement', skill_tags: [] },
      { id: 'T-2', title: '审查', spec: '审查 T-1', type: 'review', skill_tags: ['审查'], depends_on: ['T-1'] },
    ])
    await orch.run()
    const reviewStart = backend.started.find((s) => s.task.id === 'T-2')!
    const reviewSpec = reviewStart.task.spec
    // 20K 的被审 spec → 2K；100K 的 diff → 40K；其余都是常量文案
    expect(reviewSpec.length).toBeLessThan(MAX_REVIEW_DIFF_CHARS + MAX_REVIEW_SPEC_CHARS + 1_500)
    expect(reviewSpec).toContain('截断')
    // 关键回归：不得把 20K 的原始 spec 整段塞进审查上下文
    expect(reviewSpec).not.toContain(longSpec)
    fx.store.close()
    rmSync(fx.root, { recursive: true, force: true })
  })

  it('产物摘要只注入非空项（此前给无摘要任务产出「T-1: 」空行）', async () => {
    const fx = await makeFixture()
    const backend = new FakeBackend('ark', {
      'T-1': { completion: { exit: 'done', report: doneReport('T-1', { summary: '实现要点：加了缓存层' }), usage: { tokens_in: 10, tokens_out: 5, source: 'measured' }, artifacts: [] } },
      'T-2': { completion: { exit: 'done', report: doneReport('T-2', { task_type: 'review' }), usage: { tokens_in: 10, tokens_out: 5, source: 'measured' }, artifacts: [] } },
    })
    const orch = new MissionOrchestrator('M-1', {
      store: fx.store,
      backends: { ark: backend },
      worktree: { ensure: async () => fx.repo },
      verify: async (task, report) => ({ ok: true, failures: [], commit_sha: report.commit_sha, parent_sha: task.id + '-p', mismatch: false }),
    })
    orch.launch({
      name: 'r', goal: 'g', cwd: fx.repo, budgetUsd: 5,
      slots: [
        { id: 'S-1', vendor: 'ark', role: 'coder', capabilities: [] },
        { id: 'S-2', vendor: 'ark', role: 'reviewer', capabilities: ['审查'] },
      ],
    })
    orch.createTasks([
      { id: 'T-1', title: '实现', spec: '实现缓存', type: 'implement', skill_tags: [] },
      { id: 'T-2', title: '审查', spec: '审查 T-1', type: 'review', skill_tags: ['审查'], depends_on: ['T-1'] },
    ])
    await orch.run()
    const reviewSpec = backend.started.find((s) => s.task.id === 'T-2')!.task.spec
    expect(reviewSpec).toContain('被审产物摘要')
    expect(reviewSpec).toContain('加了缓存层')
    // 回归：摘要段里不得出现「T-1: 」这样的空值行
    expect(reviewSpec).not.toMatch(/被审产物摘要[\s\S]*T-1:\s*$/m)
    fx.store.close()
    rmSync(fx.root, { recursive: true, force: true })
  })

  it('同一任务的 task_context 只保留最新一份（重试不再重复落盘 8KB）', async () => {
    const fx = await makeFixture()
    const backend = new FakeBackend('ark', {
      'T-1': {
        completion: failedCompletion(),
        next: { exit: 'done', report: doneReport('T-1'), usage: { tokens_in: 10, tokens_out: 5, source: 'measured' }, artifacts: [] },
      },
      'T-2': { completion: { exit: 'done', report: doneReport('T-2', { task_type: 'review' }), usage: { tokens_in: 10, tokens_out: 5, source: 'measured' }, artifacts: [] } },
    })
    const orch = new MissionOrchestrator('M-1', {
      store: fx.store,
      backends: { ark: backend },
      worktree: { ensure: async () => fx.repo },
      verify: async (task, report) => ({ ok: true, failures: [], commit_sha: report.commit_sha, parent_sha: task.id + '-p', mismatch: false }),
    })
    orch.launch({
      name: 'r', goal: 'g', cwd: fx.repo, budgetUsd: 5,
      slots: [
        { id: 'S-1', vendor: 'ark', role: 'coder', capabilities: [] },
        { id: 'S-2', vendor: 'ark', role: 'reviewer', capabilities: ['审查'] },
      ],
    })
    orch.createTasks([
      { id: 'T-1', title: '实现', spec: 's'.repeat(12_000), type: 'implement', skill_tags: [] },
      { id: 'T-2', title: '审查', spec: '审查 T-1', type: 'review', skill_tags: ['审查'], depends_on: ['T-1'] },
    ])
    await orch.run()
    // 前提：T-1 确实派发了两次（失败 + 重派），否则这条测试是空转
    expect(backend.started.filter((s) => s.task.id === 'T-1').length).toBe(2)
    const ctx = fx.store.listEvents('M-1').filter((e) => e.kind === 'task_context' && e.task_id === 'T-1')
    expect(ctx.length).toBe(1)
    fx.store.close()
    rmSync(fx.root, { recursive: true, force: true })
  })
})

describe('P0 会话档位：会话句柄写回 slot（档位 B 复用）', () => {
  function twoTasks(): Array<{ id: string; title: string; spec: string; type: 'implement'; skill_tags: string[] }> {
    return [
      { id: 'T-1', title: '实现 A', spec: 'a', type: 'implement', skill_tags: [] },
      { id: 'T-2', title: '实现 B', spec: 'b', type: 'implement', skill_tags: [] },
    ]
  }

  async function runWithTier(tier: 'per-mission' | 'transient'): Promise<{
    started: Array<{ slot: AgentSlot; task: Task; worktree: string }>
    slotRef: string | undefined
    cleanup: () => void
  }> {
    const fx = await makeFixture()
    const backend = new FakeBackend('ark', {
      'T-1': { completion: { exit: 'done', report: doneReport('T-1'), usage: { tokens_in: 10, tokens_out: 5, source: 'measured' }, artifacts: [] } },
      'T-2': { completion: { exit: 'done', report: doneReport('T-2'), usage: { tokens_in: 10, tokens_out: 5, source: 'measured' }, artifacts: [] } },
    })
    const orch = new MissionOrchestrator('M-1', {
      store: fx.store,
      backends: { ark: backend },
      worktree: { ensure: async () => fx.repo },
      verify: async (task, report) => ({ ok: true, failures: [], commit_sha: report.commit_sha, parent_sha: task.id + '-p', mismatch: false }),
    })
    orch.launch({
      name: 'r', goal: 'g', cwd: fx.repo, budgetUsd: 5, parallel: 1,
      slots: [{ id: 'S-1', vendor: 'ark', role: 'coder', capabilities: [], session_tier: tier }],
    })
    orch.createTasks(twoTasks())
    await orch.run()
    return {
      started: backend.started,
      // 槽位 id 带 mission 前缀（launch 时合成为 M-1-S-1）
      slotRef: fx.store.getSlot('M-1-S-1')!.session_ref,
      cleanup: () => {
        fx.store.close()
        rmSync(fx.root, { recursive: true, force: true })
      },
    }
  }

  it('per-mission：第二次派发带着第一次的 session_ref（此前恒 undefined）', async () => {
    const r = await runWithTier('per-mission')
    // 前提：两个任务都派给了同一个槽位，否则这条测试是空转
    expect(r.started.length).toBe(2)
    expect(r.started.every((s) => s.slot.id === 'M-1-S-1')).toBe(true)
    // 回归：第二次派发必须读到第一次写回的句柄，否则 workers 层会再起一个新会话
    expect(r.started[1]!.slot.session_ref).toBe('ark-session-T-1')
    // 每次派发后刷新为本次句柄
    expect(r.slotRef).toBe('ark-session-T-2')
    r.cleanup()
  })

  it('transient 不写回（语义就是每任务新进程，无跨任务上下文）', async () => {
    const r = await runWithTier('transient')
    expect(r.started.length).toBe(2)
    expect(r.slotRef).toBeUndefined()
    r.cleanup()
  })

  it('占用达阈值 → 重建会话 + 注入摘要 + 记基线，且不会每次派发都重置', async () => {
    const fx = await makeFixture()
    const backend = new FakeBackend('ark', {
      'T-1': { completion: { exit: 'done', report: doneReport('T-1'), usage: { tokens_in: 60, tokens_out: 20, source: 'measured' }, artifacts: [] } },
      'T-2': { completion: { exit: 'done', report: doneReport('T-2'), usage: { tokens_in: 5, tokens_out: 5, source: 'measured' }, artifacts: [] } },
      'T-3': { completion: { exit: 'done', report: doneReport('T-3'), usage: { tokens_in: 5, tokens_out: 5, source: 'measured' }, artifacts: [] } },
    })
    const orch = new MissionOrchestrator('M-1', {
      store: fx.store,
      backends: { ark: backend },
      worktree: { ensure: async () => fx.repo },
      verify: async (task, report) => ({ ok: true, failures: [], commit_sha: report.commit_sha, parent_sha: task.id + '-p', mismatch: false }),
    })
    orch.launch({
      name: 'r', goal: 'g', cwd: fx.repo, budgetUsd: 5, parallel: 1,
      // 窗口 100 token：T-1 消耗 80 → 占用 80%，跨过 70% 阈值
      slots: [{ id: 'S-1', vendor: 'ark', role: 'coder', capabilities: [], session_tier: 'per-mission', window_tokens: 100 }],
    })
    orch.createTasks([
      { id: 'T-1', title: '实现 A', spec: 'a', type: 'implement', skill_tags: [] },
      { id: 'T-2', title: '实现 B', spec: 'b', type: 'implement', skill_tags: [] },
      { id: 'T-3', title: '实现 C', spec: 'c', type: 'implement', skill_tags: [] },
    ])
    await orch.run()

    // 只重置一次：T-2 派发时触发；T-3 派发时占用已按基线归零 → 不再触发
    // （没有基线的話，累计 90/100 = 90% 会让它每次派发都重置）
    const resets = fx.store.listEvents('M-1').filter((e) => e.kind === 'session_reset')
    expect(resets.length).toBe(1)
    expect((resets[0]!.payload as { ctx_usage_pct: number }).ctx_usage_pct).toBe(80)

    // 重置摘要注入 T-2 的上下文（含已完成的 T-1 事实），T-3 不再收到
    const specOf = (id: string): string => backend.started.find((s) => s.task.id === id)!.task.spec
    expect(specOf('T-2')).toContain('会话重置摘要')
    expect(specOf('T-2')).toContain('T-1')
    expect(specOf('T-3')).not.toContain('会话重置摘要')

    // 会话句柄被清空 → workers 层下次起新会话而非 --resume
    expect(backend.started[1]!.slot.session_ref).toBeUndefined()
    // T-3 带着 T-2 重建后的新句柄（证明重置只发生一次）
    expect(backend.started[2]!.slot.session_ref).toBe('ark-session-T-2')

    const slot = fx.store.getSlot('M-1-S-1')!
    expect(slot.session_base_tokens).toBe(80)
    expect(slot.ctx_usage_pct).toBeLessThan(CTX_RESET_THRESHOLD_PCT)
    fx.store.close()
    rmSync(fx.root, { recursive: true, force: true })
  })

  it('P1-2 review 派发记录内容密度；高密度下重置事件用 50% 低阈值', async () => {
    const fx = await makeFixture()
    const backend = new FakeBackend('ark', {
      'T-1': { completion: { exit: 'done', report: doneReport('T-1'), usage: { tokens_in: 5, tokens_out: 5, source: 'measured' }, artifacts: [] } },
    })
    const orch = new MissionOrchestrator('M-1', {
      store: fx.store,
      backends: { ark: backend },
      worktree: { ensure: async () => fx.repo },
      verify: async (task, report) => ({ ok: true, failures: [], commit_sha: report.commit_sha, parent_sha: task.id + '-p', mismatch: false }),
      diffProvider: async () => 'diff --git a/x.ts b/x.ts\nindex 1..2 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,30 @@\n' + '+line\n'.repeat(50),
    })
    orch.launch({ name: 'r', goal: 'g', cwd: fx.repo, budgetUsd: 5, parallel: 1, slots: [{ id: 'S-1', vendor: 'ark', role: 'reviewer', capabilities: ['审查'] }] })
    orch.createTasks([{ id: 'T-1', title: '审查', spec: '审查 T-1', type: 'review', skill_tags: ['审查'], depends_on: [] }])
    await orch.run()
    // review 派发后 slot 记录内容密度（diff 密集 → 高）
    const slot = fx.store.getSlot('M-1-S-1')!
    expect(slot.content_density_pct).toBeGreaterThanOrEqual(60)
    const ctx = fx.store.listEvents('M-1').find((e) => e.kind === 'task_context' && e.task_id === 'T-1')!
    expect((ctx.payload as { content_density_pct: number }).content_density_pct).toBeGreaterThanOrEqual(60)
    fx.store.close()
    rmSync(fx.root, { recursive: true, force: true })
  })
})
