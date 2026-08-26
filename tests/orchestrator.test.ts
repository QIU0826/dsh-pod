import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConcurrencyLimitError } from '../src/core/errors.js'
import { JsonStore } from '../src/core/store.js'
import { MissionOrchestrator } from '../src/core/orchestrator.js'
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
import { APPROVAL_STALE_MS } from '../src/core/types.js'

/**
 * FakeBackend：脚本化回放——start 记录调用并按任务 id 脚本产出进度与完成信号。
 * 完成信号必须在 microtask 中回调（真实后端的进程退出语义），保证 run() 等待协议成立。
 */
class FakeBackend implements WorkerBackend {
  readonly vendor: Vendor
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

function makeWorktreeManager(fixture: Fixture): WorktreeManager {
  return {
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
    // 测试注入假 verifier：真实 commit 校验在 verifier.test.ts 已覆盖
    verify: async (task, report) => ({
      ok: true,
      commit_sha: report.commit_sha,
      parent_sha: `${task.id}-parent`,
      failures: [],
      mismatch: false,
    }),
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
    diffProvider: async () => 'diff --git a/x.ts b/x.ts\n+export const add = (a, b) => a + b\n',
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
    expect(review.task.spec).toContain('被审 diff（宿主机注入，勿访问仓库）')
    expect(review.task.spec).toContain('diff --git a/x.ts b/x.ts')
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
