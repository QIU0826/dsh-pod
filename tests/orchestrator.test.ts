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
  private readonly script: Record<string, { progress?: WorkerProgressEvent[]; completion?: WorkerCompletion; next?: WorkerCompletion; hang?: boolean }>
  private readonly calls = new Map<string, number>()

  constructor(vendor: Vendor, script: Record<string, { progress?: WorkerProgressEvent[]; completion?: WorkerCompletion; next?: WorkerCompletion; hang?: boolean }>) {
    this.vendor = vendor
    this.script = script
  }

  private scriptedFor(taskId: string): { progress?: WorkerProgressEvent[]; completion?: WorkerCompletion; hang?: boolean } {
    const entry = this.script[taskId]
    const count = (this.calls.get(taskId) ?? 0) + 1
    this.calls.set(taskId, count)
    if (entry === undefined) return this.defaultEntry(taskId)
    if (count === 1) return entry
    // 重试调用：走 next（未指定则默认成功完成）
    return entry.next !== undefined ? { ...entry, completion: entry.next } : this.defaultEntry(taskId)
  }

  private defaultEntry(taskId: string): { progress?: WorkerProgressEvent[]; completion?: WorkerCompletion; hang?: boolean } {
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
    const entry = this.scriptedFor(task.id)
    if (entry.hang !== true) {
      queueMicrotask(() => {
        for (const progress of entry.progress ?? []) callbacks.onProgress?.(progress)
        if (entry.completion !== undefined) callbacks.onExit?.(entry.completion)
      })
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
  script: Record<string, { progress?: WorkerProgressEvent[]; completion?: WorkerCompletion; hang?: boolean }>,
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
  script: Record<string, { progress?: WorkerProgressEvent[]; completion?: WorkerCompletion; hang?: boolean }>,
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
    // 独立 review：审查者 ≠ 实现者
    expect(fixture.store.getTask('T-1')!.owner_slot_id).toBe('S-1')
    expect(fixture.store.getTask('T-2')!.owner_slot_id).toBe('S-2')
    // 审批卡已持久化（2.6 节模式 1）
    const approvals = fixture.store.listApprovals('M-1')
    expect(approvals).toHaveLength(1)
    expect(approvals[0]!.status).toBe('pending')
    // worktree 已为员工建立
    expect(fixture.worktrees.has('S-1')).toBe(true)
    expect(fixture.worktrees.has('S-2')).toBe(true)
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
    expect(fixture.store.getSlot('S-1')!.status).toBe('idle')
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
