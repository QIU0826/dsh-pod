/**
 * 任务生命周期状态机（A2A 对齐版）端到端测试：
 *   Created(ready) → Negotiating(negotiating) → Accepted(accepted) → InProgress(dispatched/running)
 *   ⇄ Paused(paused)；谢绝换人 failover；全员谢绝 → rejected 终态。
 * 协商的「接受/拒绝」由 vendor 健康探测真实裁决（安装 + 凭据），不是仪式。
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
import { RATE_LIMIT_BACKOFF_MAX_MS } from '../src/core/types.js'
import type { LaunchInput, PlanTaskInput, WorktreeManager } from '../src/core/orchestrator.js'
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

repairPath()

/** 可配置健康结论的假后端（协商裁决的注入点）。 */
class HealthBackend implements WorkerBackend {
  readonly vendor: Vendor
  readonly protocol = {
    family: 'headless-cli' as const,
    capabilities: { kill: true, session_persist: false, structured_output: true, usage_audit: false },
  }
  health: { installed: boolean; authed: boolean }
  readonly starts: string[] = []
  readonly kills: string[] = []
  private readonly script: Record<string, { hang?: boolean }>
  private calls = 0

  constructor(vendor: Vendor, health: { installed: boolean; authed: boolean }, script: Record<string, { hang?: boolean }> = {}) {
    this.vendor = vendor
    this.health = health
    this.script = script
  }

  async detect() {
    return {
      installed: this.health.installed,
      authed: this.health.authed,
      models: [] as string[],
      version: 'fake-1.0.0',
      session_tiers: ['transient'] as Array<'transient'>,
      error: this.health.authed ? undefined : 'not logged in',
    }
  }

  async start(
    _slot: AgentSlot,
    task: Task,
    _worktree: string,
    callbacks: { onProgress?(event: WorkerProgressEvent): void; onExit?(completion: WorkerCompletion): void } = {},
  ): Promise<WorkerHandle> {
    this.starts.push(task.id)
    this.calls += 1
    const entry = this.script[task.id]
    const hang = this.calls === 1 && entry?.hang === true
    if (!hang) {
      queueMicrotask(() => {
        callbacks.onExit?.({
          exit: 'done',
          report: doneReport(task.id),
          usage: { tokens_in: 10, tokens_out: 5, source: 'measured' },
          artifacts: [],
        })
      })
    }
    return { pid: 4000 + this.starts.length }
  }

  async kill(handle: WorkerHandle): Promise<void> {
    this.kills.push(String(handle.pid))
  }
}

function doneReport(taskId: string): MissionReport {
  return {
    task_id: taskId,
    task_type: 'implement',
    status: 'done',
    summary: 'done it',
    files_changed: ['src/x.ts'],
    commit_sha: `${taskId}-commit`,
    test_command: 'npm test',
    test_result: 'pass',
    test_evidence: '1/1 ok',
    decisions: [],
    blockers: [],
    questions: [],
    usage: { tokens_in: 10, tokens_out: 5 },
  }
}

interface Fixture {
  root: string
  repo: string
  store: JsonStore
}

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'pod-lifecycle-'))
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# demo\n')
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

function worktreeManager(): WorktreeManager {
  return {
    async ensure(repoRoot: string, slotId: string) {
      const path = join(repoRoot, '.pod-worktrees', slotId)
      try {
        execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot })
        execFileSync('git', ['worktree', 'add', path, '-b', `pod-${slotId}`], { cwd: repoRoot, stdio: 'pipe' })
      } catch {
        // 已存在则复用
      }
      return path
    },
  }
}

function launchInput(over: Partial<LaunchInput> = {}): LaunchInput {
  return {
    name: 'lifecycle',
    goal: '验证任务生命周期',
    cwd: '',
    budgetUsd: 2,
    slots: [
      { id: 'S-1', vendor: 'codex', role: 'implementer', capabilities: ['编码'], session_tier: 'transient' },
      { id: 'S-2', vendor: 'claude', role: 'implementer2', capabilities: ['编码'], session_tier: 'transient' },
    ],
    ...over,
  }
}

const singlePlan: PlanTaskInput[] = [
  { id: 'T-1', title: '实现', spec: '实现 add', type: 'implement', skill_tags: ['编码'] },
]

function makeOrchestrator(backends: Partial<Record<Vendor, WorkerBackend>>) {
  return new MissionOrchestrator('M-1', {
    store: fixture.store,
    backends,
    worktree: worktreeManager(),
    clock: () => 1_700_000_000_000,
    verify: async (task, report) => ({
      ok: true,
      commit_sha: report.commit_sha,
      parent_sha: `${task.id}-parent`,
      failures: [],
      mismatch: false,
    }),
  })
}

async function waitFor(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 15))
  }
}

describe('TaskMachine 生命周期迁移（非法迁移 fail-closed）', () => {
  function seed(taskOver: Partial<Task> = {}): void {
    fixture.store.createMission({
      id: 'M-1', name: 'm', goal: 'g', status: 'running', budget_usd: 5, spent_tokens: 0, spent_equiv_usd: 0,
      approval_mode: 1, cwd: fixture.repo, worktree_policy: 'per-slot', orchestration_mode: 'manual', commander_healthy: true,
      created_at: 1, updated_at: 1,
    })
    fixture.store.createSlot({
      id: 'S-1', mission_id: 'M-1', vendor: 'claude', role: 'r', capabilities: ['编码'], model: '', effort: 'medium',
      session_tier: 'transient', status: 'idle', tokens_in: 0, tokens_out: 0, ctx_usage_pct: 0, window_tokens: 100_000,
    })
    fixture.store.createTask({
      id: 'T-1', mission_id: 'M-1', title: 't', spec: 's', skill_tags: [], type: 'implement', depends_on: [],
      status: 'ready', attempts: 0, soft_attempts: 0, max_wall_clock_ms: 1000, created_at: 1, updated_at: 1,
      ...taskOver,
    })
  }

  it('offer → accept → dispatch 链路落协商事件', () => {
    seed()
    const machine = new TaskMachine(fixture.store, { missionId: 'M-1' })
    machine.offer('T-1', 'S-1', { est_usd: 0.1 })
    expect(fixture.store.getTask('M-1', 'T-1')?.status).toBe('negotiating')
    machine.accept('T-1', { vendor: 'claude' })
    expect(fixture.store.getTask('M-1', 'T-1')?.status).toBe('accepted')
    machine.dispatch('T-1', 'S-1')
    expect(fixture.store.getTask('M-1', 'T-1')?.status).toBe('dispatched')
    const kinds = fixture.store.listEvents('M-1').filter((e) => e.kind === 'task_negotiation').map((e) => (e.payload as { phase?: string }).phase)
    expect(kinds).toEqual(['offer', 'accepted'])
  })

  it('pause/resume：running ⇄ paused ⇄ ready（清 owner）；ready 不可暂停', () => {
    seed()
    const machine = new TaskMachine(fixture.store, { missionId: 'M-1' })
    expect(() => machine.pause('T-1')).toThrow()
    machine.offer('T-1', 'S-1', {})
    machine.accept('T-1', {})
    machine.dispatch('T-1', 'S-1')
    machine.start('T-1')
    machine.pause('T-1')
    expect(fixture.store.getTask('M-1', 'T-1')?.status).toBe('paused')
    machine.resume('T-1')
    const resumed = fixture.store.getTask('M-1', 'T-1')
    expect(resumed?.status).toBe('ready')
    expect(resumed?.owner_slot_id).toBeUndefined()
    expect(() => machine.resume('T-1')).toThrow()
  })

  it('rejectBySlot 回 ready 换人；rejectTerminal 允许 ready（E2E 实证 2026-09-01：换人后无下家的终局拒绝）', () => {
    seed()
    const machine = new TaskMachine(fixture.store, { missionId: 'M-1' })
    machine.offer('T-1', 'S-1', {})
    machine.rejectBySlot('T-1', '凭据失效')
    expect(fixture.store.getTask('M-1', 'T-1')?.status).toBe('ready')
    // 修复语义：rejectBySlot 回退到 ready 后，换尽槽位仍无下家 → 终局拒绝合法
    machine.rejectTerminal('T-1', '全员谢绝')
    expect(fixture.store.getTask('M-1', 'T-1')?.status).toBe('rejected')
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'task_rejected')).toBe(true)
  })

  it('rejectTerminal 对非法前置态（running）仍抛错（守卫不放宽到任意状态）', () => {
    seed()
    const machine = new TaskMachine(fixture.store, { missionId: 'M-1' })
    const t = fixture.store.getTask('M-1', 'T-1')!
    fixture.store.updateTask('M-1', t.id, { status: 'running' })
    expect(() => machine.rejectTerminal('T-1', 'x')).toThrow(/only a negotiating/)
  })

  it('report(need_clarify) 软失败 → blocked + soft_attempts=1、不计 attempts、可重派（回归：竞态定位 2026-09-02）', async () => {
    seed()
    const machine = new TaskMachine(fixture.store, {
      missionId: 'M-1',
      clock: () => 1_700_000_000_000,
      verify: async () => ({ ok: true, failures: [], mismatch: false }),
    })
    machine.offer('T-1', 'S-1', {})
    machine.accept('T-1', {})
    machine.dispatch('T-1', 'S-1')
    machine.start('T-1')
    await machine.report('T-1', {
      task_id: 'T-1',
      task_type: 'implement',
      status: 'need_clarify',
      summary: '实现前需澄清范围',
      files_changed: [],
      test_result: 'not_run',
      decisions: [],
      blockers: [],
      questions: ['q1?', 'q2?'],
    })
    const t = fixture.store.getTask('M-1', 'T-1')
    expect(t?.status).toBe('blocked') // 软失败转 blocked（非 escalated，非 running）
    expect(t?.soft_attempts).toBe(1)
    expect(t?.attempts).toBe(0) // 软失败不消费 attempts
    expect(t?.fault).toBe('need_clarify')
    // 可重派（next_retry_at 为 now，非 auth/rate_limited 退避）；steer 答复在重派时注入 spec
    expect(machine.shouldRetry(t!, 1_700_000_000_000)).toBe(true)
  })

  it('need_clarify ×3 → escalated（软失败烧钱封顶：soft 失败不烧 attempts，无上限则无人值守无限重派）', async () => {
    seed()
    const machine = new TaskMachine(fixture.store, {
      missionId: 'M-1',
      clock: () => 1_700_000_000_000,
      verify: async () => ({ ok: true, failures: [], mismatch: false }),
    })
    const reportNeedClarify = () => ({
      task_id: 'T-1',
      task_type: 'implement' as const,
      status: 'need_clarify' as const,
      summary: '还是不清楚',
      files_changed: [],
      test_result: 'not_run' as const,
      decisions: [],
      blockers: [],
      questions: ['q?'],
    })
    for (let i = 1; i <= 3; i += 1) {
      machine.dispatch('T-1', 'S-1')
      machine.start('T-1')
      await machine.report('T-1', reportNeedClarify())
      const t = fixture.store.getTask('M-1', 'T-1')!
      if (i < 3) {
        expect(t.status).toBe('blocked')
        expect(t.soft_attempts).toBe(i)
        expect(machine.shouldRetry(t, 1_700_000_000_000)).toBe(true) // 前两次自动重派
      }
    }
    const t = fixture.store.getTask('M-1', 'T-1')!
    expect(t.status).toBe('escalated')
    expect(t.soft_attempts).toBe(3)
    expect(machine.shouldRetry(t, 1_700_000_000_000)).toBe(false)
  })

  it('429 穿插不污染提问封顶：rate_limited×2 + need_clarify×1 → 仍 blocked 可重试（2026-09-03 独立计数修复）', async () => {
    seed()
    let now = 1_700_000_000_000
    const machine = new TaskMachine(fixture.store, {
      missionId: 'M-1',
      clock: () => now,
      rng: () => 0, // 确定性退避：base 恰好 = RATE_LIMIT_BACKOFF_BASE_MS
      verify: async () => ({ ok: true, failures: [], mismatch: false }),
    })
    const reportNeedClarify = () => ({
      task_id: 'T-1',
      task_type: 'implement' as const,
      status: 'need_clarify' as const,
      summary: '实现前需澄清',
      files_changed: [],
      test_result: 'not_run' as const,
      decisions: [],
      blockers: [],
      questions: ['q?'],
    })
    // 两次 429（各自退避后重派）：soft_attempts 累计，但 need_clarify_count 必须保持 0
    for (let i = 1; i <= 2; i += 1) {
      machine.dispatch('T-1', 'S-1')
      machine.start('T-1')
      machine.fail('T-1', { kind: 'rate_limited', message: '429 upstream' })
      const t = fixture.store.getTask('M-1', 'T-1')!
      expect(t.status).toBe('blocked')
      expect(t.soft_attempts).toBe(i)
      expect(t.need_clarify_count ?? 0).toBe(0) // 429 不累计提问数
      now += RATE_LIMIT_BACKOFF_MAX_MS // 越过指数退避（softAttempts 增长退避翻倍）
    }
    // 第 3 次运行才真正输出 need_clarify（第一次提问）：修复前 softAttempts=3 会被误判 ×3 升级
    machine.dispatch('T-1', 'S-1')
    machine.start('T-1')
    await machine.report('T-1', reportNeedClarify())
    const t = fixture.store.getTask('M-1', 'T-1')!
    expect(t.status).toBe('blocked') // 修复前：误 escalated
    expect(t.need_clarify_count).toBe(1)
    expect(t.fault).toBe('need_clarify')
    expect(t.soft_attempts).toBe(3) // 观察字段仍累计所有软失败
    expect(machine.shouldRetry(t, now)).toBe(true) // 提问机会未被 429 提前耗尽
  })

  it('need_clarify 独立计数达 3 仍升级（封顶不受 429 干扰，且不依赖 soft_attempts 总值）', async () => {
    seed()
    let now = 1_700_000_000_000
    const machine = new TaskMachine(fixture.store, {
      missionId: 'M-1',
      clock: () => now,
      rng: () => 0,
      verify: async () => ({ ok: true, failures: [], mismatch: false }),
    })
    const reportNeedClarify = () => ({
      task_id: 'T-1',
      task_type: 'implement' as const,
      status: 'need_clarify' as const,
      summary: '还是不清楚',
      files_changed: [],
      test_result: 'not_run' as const,
      decisions: [],
      blockers: [],
      questions: ['q?'],
    })
    // 429 → need_clarify×3：soft_attempts 总 4，但提问数独立到 3 → escalate
    machine.dispatch('T-1', 'S-1')
    machine.start('T-1')
    machine.fail('T-1', { kind: 'rate_limited', message: '429' })
    now += RATE_LIMIT_BACKOFF_MAX_MS
    for (let i = 1; i <= 3; i += 1) {
      machine.dispatch('T-1', 'S-1')
      machine.start('T-1')
      await machine.report('T-1', reportNeedClarify())
    }
    const t = fixture.store.getTask('M-1', 'T-1')!
    expect(t.status).toBe('escalated')
    expect(t.need_clarify_count).toBe(3)
    expect(t.soft_attempts).toBe(4) // 429×1 + need_clarify×3
    expect(t.last_error).toContain('need_clarify ×3')
  })
})

describe('协商（Negotiating）编排行为', () => {
  it('健康 agent：offer → accepted → 派发，协商事件成链', async () => {
    const claude = new HealthBackend('claude', { installed: true, authed: true })
    const orch = makeOrchestrator({ claude })
    orch.launch(launchInput({ slots: [launchInput().slots[1]!] }))
    orch.createTasks(singlePlan)
    const summary = await orch.run()
    expect(summary.status).toBe('awaiting_approval')
    const phases = fixture.store
      .listEvents('M-1')
      .filter((e) => e.kind === 'task_negotiation')
      .map((e) => (e.payload as { phase?: string }).phase)
    expect(phases).toEqual(['offer', 'accepted'])
    expect(claude.starts).toEqual(['T-1'])
  })

  it('凭据失效 → 该 agent 谢绝 → 换人 failover 到健康 agent', async () => {
    const codex = new HealthBackend('codex', { installed: true, authed: false })
    const claude = new HealthBackend('claude', { installed: true, authed: true })
    const orch = makeOrchestrator({ codex, claude })
    orch.launch(launchInput())
    orch.createTasks(singlePlan)
    const summary = await orch.run()
    expect(summary.status).toBe('awaiting_approval')
    const rejected = fixture.store
      .listEvents('M-1')
      .filter((e) => e.kind === 'task_negotiation' && (e.payload as { phase?: string }).phase === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(String((rejected[0]!.payload as { by_slot?: string }).by_slot)).toContain('S-1')
    expect(String((rejected[0]!.payload as { reason?: string }).reason)).toContain('codex')
    const task = fixture.store.getTask('M-1', 'T-1')
    expect(task?.status).toBe('done')
    expect(String(task?.owner_slot_id)).toContain('S-2')
    expect(codex.starts).toHaveLength(0)
    expect(claude.starts).toEqual(['T-1'])
  })

  it('全员谢绝 → rejected 终态 + needs_human（不再烧运行）', async () => {
    const codex = new HealthBackend('codex', { installed: true, authed: false })
    const claude = new HealthBackend('claude', { installed: false, authed: false })
    const orch = makeOrchestrator({ codex, claude })
    orch.launch(launchInput())
    orch.createTasks(singlePlan)
    const summary = await orch.run()
    expect(summary.status).toBe('needs_human')
    expect(summary.escalatedTasks).toContain('T-1')
    expect(fixture.store.getTask('M-1', 'T-1')?.status).toBe('rejected')
    expect(codex.starts).toHaveLength(0)
    expect(claude.starts).toHaveLength(0)
  })
})

describe('任务级暂停/恢复（InProgress ⇄ Paused）', () => {
  it('暂停运行中任务：杀进程、不计故障；恢复后重新协商派发到完成', async () => {
    const claude = new HealthBackend('claude', { installed: true, authed: true }, { 'T-1': { hang: true } })
    const orch = makeOrchestrator({ claude })
    orch.launch(launchInput({ slots: [launchInput().slots[1]!] }))
    orch.createTasks(singlePlan)
    void orch.run()
    await waitFor(() => fixture.store.getTask('M-1', 'T-1')?.status === 'running')
    await orch.pauseTask('T-1')
    expect(fixture.store.getTask('M-1', 'T-1')?.status).toBe('paused')
    expect(claude.kills).toHaveLength(1)
    // killed 退出被暂停标记吞掉：不得出现 task_blocked（用户行为不是故障）
    await new Promise((r) => setTimeout(r, 50))
    expect(fixture.store.listEvents('M-1').some((e) => e.kind === 'task_blocked')).toBe(false)
    // 恢复：paused → ready → 重新协商（第二轮 start 不 hang）→ done
    orch.resumeTask('T-1')
    await waitFor(() => fixture.store.getTask('M-1', 'T-1')?.status === 'done')
    expect(claude.starts).toHaveLength(2)
    const pausedEv = fixture.store.listEvents('M-1').filter((e) => e.kind === 'task_paused')
    const resumedEv = fixture.store.listEvents('M-1').filter((e) => e.kind === 'task_resumed')
    expect(pausedEv).toHaveLength(1)
    expect(resumedEv).toHaveLength(1)
  })

  it('非可暂停状态（done）暂停 → INVALID_TRANSITION 409 语义', async () => {
    const claude = new HealthBackend('claude', { installed: true, authed: true })
    const orch = makeOrchestrator({ claude })
    orch.launch(launchInput({ slots: [launchInput().slots[1]!] }))
    orch.createTasks(singlePlan)
    await orch.run()
    await expect(orch.pauseTask('T-1')).rejects.toThrow()
  })
})
