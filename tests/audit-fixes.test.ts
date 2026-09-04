/**
 * 2026-09-02 深审修复回归测试（P1 #1/#3/#4/#5 + P2 #10/#11/#12）。
 * 每个用例对应审计报告中的一条，防止回退。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repairPath } from '../src/workers/preflight.js'
import { JsonStore } from '../src/core/store.js'
import { MissionOrchestrator } from '../src/core/orchestrator.js'
import { TaskMachine } from '../src/core/task-machine.js'
import type { LaunchInput, PlanTaskInput, WorktreeManager } from '../src/core/orchestrator.js'
import type {
  AgentSlot, MissionReport, Task, Vendor, WorkerBackend,
  WorkerCompletion, WorkerHandle, WorkerProgressEvent,
} from '../src/core/types.js'

repairPath()

/** 可手动触发退出的假后端（复刻真实后端「退出晚于派发」的时序）。 */
class ManualBackend implements WorkerBackend {
  readonly vendor: Vendor
  readonly protocol = { family: 'headless-cli' as const, capabilities: { kill: true, session_persist: true, structured_output: true, usage_audit: false } }
  readonly starts: string[] = []
  readonly kills: string[] = []
  private calls = 0
  private pending: Array<{ taskId: string; fire: (c: WorkerCompletion) => void }> = []
  /** 真实时序：session_ref 只在进程退出（collect 完成）时才出现在 handle 上。 */
  sessionRefOnExit = true
  /** auto=true：首次派发也自动完成（不复刻挂起时序），供 run() 直接收口的用例。 */
  auto = false
  private handleRef = new Map<string, string>()

  constructor(vendor: Vendor) {
    this.vendor = vendor
  }

  async detect() {
    return { installed: true, authed: true, models: [] as string[], version: 'fake', session_tiers: ['per-mission'] as Array<'per-mission'> }
  }

  async start(
    _slot: AgentSlot,
    task: Task,
    _worktree: string,
    callbacks: { onProgress?(event: WorkerProgressEvent): void; onExit?(completion: WorkerCompletion): void } = {},
  ): Promise<WorkerHandle> {
    this.starts.push(task.id)
    this.calls += 1
    const callNo = this.calls
    const handle: WorkerHandle = { pid: 9000 + this.calls }
    if (this.auto) {
      queueMicrotask(() => {
        handle.session_ref = `sess-${task.id}`
        callbacks.onExit?.({
          exit: 'done',
          report: this.reportFor(task),
          usage: { tokens_in: 10, tokens_out: 5, source: 'measured' },
          artifacts: [],
        })
      })
    } else if (callNo === 1) {
      // 首次派发：挂起，等待测试手动触发退出（复刻长任务）
      this.pending.push({
        taskId: task.id,
        fire: (c) => {
          if (this.sessionRefOnExit && handle.pid !== undefined) this.handleRef.set(task.id, `sess-${task.id}`)
          handle.session_ref = this.handleRef.get(task.id)
          callbacks.onExit?.(c)
        },
      })
    } else {
      queueMicrotask(() => {
        handle.session_ref = `sess-${task.id}-r${callNo}`
        callbacks.onExit?.({
          exit: 'done',
          report: this.reportFor(task),
          usage: { tokens_in: 10, tokens_out: 5, source: 'measured' },
          artifacts: [],
        })
      })
    }
    return handle
  }

  private reportFor(task: Task): MissionReport {
    const base = doneReport(task.id)
    const coding = task.type === 'implement' || task.type === 'test'
    return coding ? base : { ...base, commit_sha: undefined, files_changed: [] }
  }

  /** 测试手动触发挂起任务的退出（模拟旧进程迟到退出）。 */
  fireExit(taskId: string, completion: WorkerCompletion): void {
    const entry = this.pending.find((p) => p.taskId === taskId)
    if (entry === undefined) throw new Error(`no pending exit for ${taskId}`)
    this.pending = this.pending.filter((p) => p !== entry)
    entry.fire(completion)
  }

  async kill(handle: WorkerHandle): Promise<void> {
    this.kills.push(String(handle.pid))
  }
}

function doneReport(taskId: string): MissionReport {
  return {
    task_id: taskId, task_type: 'implement', status: 'done', summary: 'ok', files_changed: ['src/x.ts'],
    commit_sha: `${taskId}-commit`, test_command: 'npm test', test_result: 'pass', test_evidence: 'ok',
    decisions: [], blockers: [], questions: [], usage: { tokens_in: 10, tokens_out: 5 },
  }
}

interface Fixture { root: string; repo: string; store: JsonStore }

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'pod-fix-'))
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# x\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  const store = new JsonStore({ rootDir: root, clock: () => 1_700_000_000_000 })
  store.open()
  return { root, repo, store }
}

let fixture: Fixture

beforeEach(async () => {
  fixture = await makeFixture()
})

afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true })
})

function makeOrchestrator(backends: Partial<Record<Vendor, WorkerBackend>>, missionId = 'M-1') {
  return new MissionOrchestrator(missionId, {
    store: fixture.store,
    backends,
    worktree: {
      async ensure(repoRoot: string, slotId: string) {
        const path = join(repoRoot, '.pod-worktrees', slotId)
        try {
          execFileSync('git', ['worktree', 'add', path, '-b', `pod-${slotId}`], { cwd: repoRoot, stdio: 'pipe' })
        } catch { /* 已存在 */ }
        return path
      },
    } satisfies WorktreeManager,
    clock: () => 1_700_000_000_000,
    verify: async (task, report) => ({
      ok: true,
      // 写码类才有 commit；research/doc/plan 无产物（NO_PATCH 收口路径的如实形态）
      commit_sha: task.type === 'implement' || task.type === 'test' ? report.commit_sha : undefined,
      parent_sha: task.type === 'implement' || task.type === 'test' ? `${task.id}-p` : undefined,
      failures: [],
      mismatch: false,
    }),
  })
}

function launchInput(over: Partial<LaunchInput> = {}): LaunchInput {
  return {
    name: 'fix', goal: '回归', cwd: '', budgetUsd: 5,
    slots: [{ id: 'S-1', vendor: 'claude', role: 'dev', capabilities: ['编码', '审查'], session_tier: 'per-mission' }],
    ...over,
  }
}

async function waitFor(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  expect(cond()).toBe(true)
}

describe('P1 #1 跨 mission 短 id 撞键：失败必须写进本 mission 的任务', () => {
  it('两个 mission 共享 T-1 时，M-2 的失败不污染 M-1 的同名任务', () => {
    for (const mid of ['M-1', 'M-2']) {
      fixture.store.createMission({
        id: mid, name: 'm', goal: 'g', status: 'running', budget_usd: 5, spent_tokens: 0, spent_equiv_usd: 0,
        approval_mode: 1, cwd: fixture.repo, worktree_policy: 'per-slot', orchestration_mode: 'manual', commander_healthy: true,
        created_at: 1, updated_at: 1,
      })
      fixture.store.createSlot({
        id: `${mid}::S-1`, mission_id: mid, vendor: 'claude', role: 'r', capabilities: ['编码'], model: '', effort: 'medium',
        session_tier: 'transient', status: 'idle', tokens_in: 0, tokens_out: 0, ctx_usage_pct: 0, window_tokens: 100_000,
      })
      fixture.store.createTask({
        id: 'T-1', mission_id: mid, title: 't', spec: 's', skill_tags: [], type: 'implement', depends_on: [],
        status: 'ready', attempts: 0, soft_attempts: 0, max_wall_clock_ms: 1000, created_at: 1, updated_at: 1,
      })
    }
    const machine = new TaskMachine(fixture.store, { missionId: 'M-2' })
    machine.offer('T-1', 'M-2::S-1', {})
    machine.accept('T-1', {})
    machine.dispatch('T-1', 'M-2::S-1')
    machine.start('T-1')
    machine.fail('T-1', { kind: 'crash', message: 'boom' })
    const mine = fixture.store.getTask('M-2', 'T-1')
    const other = fixture.store.getTask('M-1', 'T-1')
    expect(mine?.status).toBe('blocked')
    expect(mine?.attempts).toBe(1)
    // 旧 mission（先创建、单参 first-match 会命中它）不得被污染
    expect(other?.status).toBe('ready')
    expect(other?.attempts).toBe(0)
  })
})

describe('P1 #4 档位 B 会话写回：退出时解析的 session_ref 必须落槽位', () => {
  it('任务完成（真实时序：session_ref 在退出时才有）→ slot.session_ref 已写回', async () => {
    const backend = new ManualBackend('claude')
    const orch = makeOrchestrator({ claude: backend })
    orch.launch(launchInput({ cwd: fixture.repo }))
    orch.createTasks([{ id: 'T-1', title: 'i', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    void orch.run()
    await waitFor(() => fixture.store.getTask('M-1', 'T-1')?.status === 'running')
    backend.fireExit('T-1', { exit: 'failed', usage: { tokens_in: 1, tokens_out: 1, source: 'measured' }, artifacts: [], exit_code: 1 })
    await waitFor(() => (fixture.store.listSlots('M-1')[0]?.session_ref ?? '').length > 0)
    expect(fixture.store.listSlots('M-1')[0]?.session_ref).toContain('sess-T-1')
  })
})

describe('P1 #5 代际守卫：旧代际迟到退出不改任务状态', () => {
  it('kill 重派后旧退出到达 → 只记账本，任务不被旧失败烧 attempts', async () => {
    const backend = new ManualBackend('claude')
    const orch = makeOrchestrator({ claude: backend })
    orch.launch(launchInput({ cwd: fixture.repo, budgetUsd: 5 }))
    orch.createTasks([{ id: 'T-1', title: 'i', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    void orch.run()
    await waitFor(() => fixture.store.getTask('M-1', 'T-1')?.status === 'running')
    // 真实 watchdog 路径：idle 超时 → kill（代际作废）+ fail（blocked 可重试）+ 唤醒重派
    orch.tickWatchdogs([{ key: 'task-idle:T-1', kind: 'task-idle', mission_id: 'M-1', task_id: 'T-1', deadline: 0 } as never])
    await waitFor(() => backend.starts.length >= 2)
    // 旧进程（第一代）此刻才退出，且是 failed：不得影响第二代尝试
    backend.fireExit('T-1', { exit: 'failed', usage: { tokens_in: 7, tokens_out: 3, source: 'measured', cache_read_tokens: 100, cache_creation_tokens: 5 }, artifacts: [], exit_code: 1, error_detail: 'old gen' })
    await new Promise((r) => setTimeout(r, 100))
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'task_stale_exit' && e.task_id === 'T-1')).toBe(true)
    const task = fixture.store.getTask('M-1', 'T-1')
    // 第二代按脚本正常完成 → done（而不是被旧失败打回 blocked）
    await waitFor(() => task?.status === 'done' || fixture.store.getTask('M-1', 'T-1')?.status === 'done')
    expect(fixture.store.getTask('M-1', 'T-1')?.status).toBe('done')
    // 旧代际 usage 全列入账（2026-09-04）：cache 两列不丢——kill+重派是常态路径，
    // 丢了 debrief 的 total_cache_read/creation 就静默少计。generation 是全局派发序号
    // 映射不回任务内派发序 → attempts 不猜，落 'unknown' 桶（重试成本口径明确排除它）。
    const staleEntry = fixture.store.listLedger('M-1').find((e) => e.task_id === 'T-1' && e.tokens_in === 7)
    expect(staleEntry).toBeDefined()
    expect(staleEntry!.cache_read_tokens).toBe(100)
    expect(staleEntry!.cache_creation_tokens).toBe(5)
    expect(staleEntry!.attempts).toBeUndefined()
  })
})

describe('P2 #10 纯调研会话收口 + #11 预算短路 pause + #12 人工裁决重试资格', () => {
  it('纯 research 任务全 done（无 commit）→ mission 直接 done（不再楔死 awaiting_approval）', async () => {
    const backend = new ManualBackend('claude')
    backend.auto = true
    const orch = makeOrchestrator({ claude: backend })
    orch.launch(launchInput({ cwd: fixture.repo }))
    orch.createTasks([{ id: 'R-1', title: '调研', spec: '查资料', type: 'research', skill_tags: ['编码'] } as PlanTaskInput])
    const summary = await orch.run()
    expect(summary.status).toBe('done')
    expect(fixture.store.getMission('M-1')?.status).toBe('done')
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'mission_done')).toBe(true)
  })

  it('预算短路 → mission 进 paused（不再 30s 重驱空转）', async () => {
    const backend = new ManualBackend('claude')
    const orch = makeOrchestrator({ claude: backend })
    orch.launch(launchInput({ cwd: fixture.repo, budgetUsd: 0.0001 }))
    orch.createTasks([{ id: 'T-1', title: 'i', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    const summary = await orch.run()
    expect(fixture.store.getMission('M-1')?.status).toBe('paused')
    expect(summary.status).toBe('budget_exceeded')
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'budget_short_circuit')).toBe(true)
  })

  it('attempts=3 升级 → humanResolve(blocked) 授予重试资格（attempts 归零）→ 重派完成', async () => {
    const backend = new ManualBackend('claude')
    const orch = makeOrchestrator({ claude: backend })
    orch.launch(launchInput({ cwd: fixture.repo }))
    orch.createTasks([{ id: 'T-1', title: 'i', spec: 's', type: 'implement', skill_tags: ['编码'] }])
    void orch.run()
    await waitFor(() => fixture.store.getTask('M-1', 'T-1')?.status === 'running')
    backend.fireExit('T-1', { exit: 'failed', usage: { tokens_in: 1, tokens_out: 1, source: 'measured' }, artifacts: [], exit_code: 1 })
    // 烧满 attempts 至升级（machine.fail 直接走 applyFailure）
    const machine = (orch as unknown as { taskMachine: TaskMachine }).taskMachine
    await waitFor(() => fixture.store.getTask('M-1', 'T-1')?.status === 'blocked')
    fixture.store.updateTask('M-1', 'T-1', { attempts: 3, status: 'running' })
    machine.fail('T-1', { kind: 'crash', message: '3rd' })
    expect(fixture.store.getTask('M-1', 'T-1')?.status).toBe('escalated')
    orch.humanResolve('T-1', { outcome: 'blocked', note: '人工已修复环境' })
    const resolved = fixture.store.getTask('M-1', 'T-1')
    expect(resolved?.status).toBe('blocked')
    expect(resolved?.attempts).toBe(0)
  })
})
