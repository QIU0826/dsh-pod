import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InvalidTransitionError, InvalidReportError, NotFoundError } from '../src/core/errors.js'
import { JsonStore } from '../src/core/store.js'
import { TaskMachine, classifyFault } from '../src/core/task-machine.js'
import type { TaskVerifyFn } from '../src/core/task-machine.js'
import type { AgentSlot, Mission, MissionReport, Task } from '../src/core/types.js'

let root: string
let store: JsonStore
let machine: TaskMachine
let now: number
let verify: ReturnType<typeof vi.fn<TaskVerifyFn>>

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'T-1',
    mission_id: 'M-1',
    title: 'implement rate limiter',
    spec: 'build it',
    skill_tags: ['编码'],
    type: 'implement',
    depends_on: [],
    status: 'ready',
    attempts: 0,
    soft_attempts: 0,
    max_wall_clock_ms: 3600_000,
    created_at: now,
    updated_at: now,
    ...over,
  }
}

function makeSlot(over: Partial<AgentSlot> = {}): AgentSlot {
  return {
    id: 'S-1',
    mission_id: 'M-1',
    vendor: 'claude',
    role: 'implementer',
    capabilities: ['编码'],
    model: 'claude-sonnet',
    effort: 'medium',
    session_tier: 'per-mission',
    status: 'idle',
    tokens_in: 0,
    tokens_out: 0,
    ctx_usage_pct: 0,
    window_tokens: 200_000,
    ...over,
  }
}

function makeMission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'M-1',
    name: 'm',
    goal: 'g',
    status: 'running',
    budget_usd: 2,
    spent_tokens: 0,
    spent_equiv_usd: 0,
    approval_mode: 1,
    cwd: 'C:\\repo',
    worktree_policy: 'per-slot',
    orchestration_mode: 'commander',
    commander_healthy: true,
    created_at: now,
    updated_at: now,
    ...over,
  }
}

function doneReport(over: Partial<MissionReport> = {}): MissionReport {
  return {
    task_id: 'T-1',
    task_type: 'implement',
    status: 'done',
    summary: 'implemented',
    files_changed: ['src/x.ts'],
    commit_sha: 'abc123',
    test_result: 'pass',
    test_evidence: '12/12 ✓',
    decisions: [],
    blockers: [],
    questions: [],
    ...over,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pod-task-'))
  now = 1_700_000_000_000
  store = new JsonStore({ rootDir: root, clock: () => now })
  store.open()
  store.createMission(makeMission())
  store.createSlot(makeSlot())
  store.createTask(makeTask())
  verify = vi.fn<TaskVerifyFn>(async () => ({
    ok: true,
    commit_sha: 'abc123',
    parent_sha: 'def456',
    failures: [],
    mismatch: false,
  }))
  machine = new TaskMachine(store, {
    clock: () => now,
    rng: () => 0,
    verify,
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('TaskMachine 基本流转', () => {
  it('dispatch: ready → dispatched，绑定 slot 并置 slot working', () => {
    machine.dispatch('T-1', 'S-1')
    const task = store.getTask('T-1')!
    expect(task.status).toBe('dispatched')
    expect(task.owner_slot_id).toBe('S-1')
    expect(store.getSlot('S-1')!.status).toBe('working')
  })

  it('start: dispatched → running', async () => {
    machine.dispatch('T-1', 'S-1')
    machine.start('T-1')
    expect(store.getTask('T-1')!.status).toBe('running')
  })

  it('start 未派发即调用 → InvalidTransitionError（LLM 提议、代码裁决）', () => {
    expect(() => machine.start('T-1')).toThrowError(InvalidTransitionError)
  })

  it('report done + verifier 通过 → done，commit/parent 落盘，slot 回 idle', async () => {
    machine.dispatch('T-1', 'S-1')
    machine.start('T-1')
    await machine.report('T-1', doneReport())
    const task = store.getTask('T-1')!
    expect(task.status).toBe('done')
    expect(task.commit_sha).toBe('abc123')
    expect(task.parent_sha).toBe('def456')
    expect(store.getSlot('S-1')!.status).toBe('idle')
  })

  it('非法二次派发（done → dispatch）→ InvalidTransitionError', async () => {
    machine.dispatch('T-1', 'S-1')
    machine.start('T-1')
    await machine.report('T-1', doneReport())
    expect(() => machine.dispatch('T-1', 'S-1')).toThrowError(InvalidTransitionError)
  })

  it('不存在的任务 → NotFoundError', () => {
    expect(() => machine.dispatch('nope', 'S-1')).toThrowError(NotFoundError)
  })
})

describe('故障分类全集（3.4 节）', () => {
  it('report done 但 verifier 不过 → blocked(silent_failure)，attempts+1', async () => {
    verify.mockResolvedValue({ ok: false, failures: [{ check: 'commit_exists', detail: 'no commit' }], mismatch: false })
    machine.dispatch('T-1', 'S-1')
    machine.start('T-1')
    await machine.report('T-1', doneReport())
    const task = store.getTask('T-1')!
    expect(task.status).toBe('blocked')
    expect(task.fault).toBe('silent_failure')
    expect(task.attempts).toBe(1)
  })

  it('report 叙事与产物不符（mismatch）→ 直接转人工 escalated', async () => {
    verify.mockResolvedValue({
      ok: false,
      failures: [{ check: 'narrative_match', detail: 'report claims done but no files' }],
      mismatch: true,
    })
    machine.dispatch('T-1', 'S-1')
    machine.start('T-1')
    await machine.report('T-1', doneReport())
    const task = store.getTask('T-1')!
    expect(task.status).toBe('escalated')
    expect(task.escalated_at).toBe(now)
  })

  it('report blocked → blocked，attempts+1（保留 blockers）', async () => {
    machine.dispatch('T-1', 'S-1')
    machine.start('T-1')
    await machine.report('T-1', doneReport({ status: 'blocked', blockers: ['依赖缺失'] }))
    const task = store.getTask('T-1')!
    expect(task.status).toBe('blocked')
    expect(task.attempts).toBe(1)
    expect(task.last_error).toContain('依赖缺失')
  })

  it('report need_clarify → blocked，不计 attempts，soft_attempts+1', async () => {
    machine.dispatch('T-1', 'S-1')
    machine.start('T-1')
    await machine.report('T-1', doneReport({ status: 'need_clarify', questions: ['接口签名是?'] }))
    const task = store.getTask('T-1')!
    expect(task.status).toBe('blocked')
    expect(task.fault).toBe('need_clarify')
    expect(task.attempts).toBe(0)
    expect(task.soft_attempts).toBe(1)
  })

  it('report 的 task_id 不匹配 → InvalidReportError', async () => {
    machine.dispatch('T-1', 'S-1')
    machine.start('T-1')
    await expect(machine.report('T-1', doneReport({ task_id: 'T-9' }))).rejects.toThrowError(InvalidReportError)
  })

  it('fail crash ×3 → escalated（attempts≥3 转人工）；前两次可重试', () => {
    machine.dispatch('T-1', 'S-1')
    machine.start('T-1')
    machine.fail('T-1', { kind: 'crash', message: 'exit 1' })
    let task = store.getTask('T-1')!
    expect(task.status).toBe('blocked')
    expect(task.attempts).toBe(1)
    expect(machine.shouldRetry(task, now)).toBe(true)
    machine.dispatch('T-1', 'S-1')
    machine.start('T-1')
    machine.fail('T-1', { kind: 'crash', message: 'exit 1 again' })
    machine.dispatch('T-1', 'S-1')
    machine.start('T-1')
    machine.fail('T-1', { kind: 'idle_timeout', message: 'no events 15min' })
    task = store.getTask('T-1')!
    expect(task.attempts).toBe(3)
    expect(task.status).toBe('escalated')
    expect(machine.shouldRetry(task, now)).toBe(false)
  })

  it('fail rate_limited → 不计 attempts，slot 置 rate_limited，指数退避 next_retry_at', () => {
    machine.dispatch('T-1', 'S-1')
    machine.start('T-1')
    machine.fail('T-1', { kind: 'rate_limited', message: '429' })
    const task = store.getTask('T-1')!
    expect(task.attempts).toBe(0)
    expect(task.soft_attempts).toBe(1)
    expect(task.status).toBe('blocked')
    expect(store.getSlot('S-1')!.status).toBe('rate_limited')
    expect(task.next_retry_at).toBe(now + 5_000) // base 5s, rng=0
    expect(machine.shouldRetry(task, now)).toBe(false)
    expect(machine.shouldRetry(task, now + 5_001)).toBe(true)
  })

  it('fail auth_expired → slot error，不重试', () => {
    machine.dispatch('T-1', 'S-1')
    machine.start('T-1')
    machine.fail('T-1', { kind: 'auth_expired', message: 'credential expired' })
    const task = store.getTask('T-1')!
    expect(task.fault).toBe('auth_expired')
    expect(store.getSlot('S-1')!.status).toBe('error')
    expect(machine.shouldRetry(task, now)).toBe(false)
  })

  it('fail 在 ready 状态被拒绝（不能失败一个没派发的任务）', () => {
    expect(() => machine.fail('T-1', { kind: 'crash', message: 'x' })).toThrowError(InvalidTransitionError)
  })
})

describe('故障分类器 classifyFault（worker 原始信号 → FaultKind）', () => {
  it('非零退出码 → crash', () => {
    expect(classifyFault({ exit: 'failed', exitCode: 1 })).toBe('crash')
  })
  it('429 特征 → rate_limited', () => {
    expect(classifyFault({ exit: 'rate_limited' })).toBe('rate_limited')
    expect(classifyFault({ exit: 'failed', exitCode: 1, stderrTail: '429 Too Many Requests' })).toBe('rate_limited')
  })
  it('凭据特征 → auth_expired', () => {
    expect(classifyFault({ exit: 'failed', exitCode: 1, stderrTail: 'credential has expired, run claude auth' })).toBe('auth_expired')
  })
  it('正常完成 → null', () => {
    expect(classifyFault({ exit: 'done', exitCode: 0 })).toBe(null)
  })
})

describe('Canvas 事件流', () => {
  it('每次状态迁移追加结构化事件', async () => {
    machine.dispatch('T-1', 'S-1')
    machine.start('T-1')
    await machine.report('T-1', doneReport())
    const events = store.listEvents('M-1').map((e) => e.kind)
    expect(events).toEqual(['task_dispatched', 'task_started', 'task_done'])
  })
})
