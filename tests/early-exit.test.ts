/**
 * 信息增量式止损 early exit（调研 2026-08-29 §1.3-4）。
 *
 * 锁定：
 *   - 证据指纹归一化（空白/大小写抖动同签名；长消息取尾段）；
 *   - 灰度关（默认）：行为与旧版完全一致——attempts>=3 才转人工，但证据字段照常落盘；
 *   - 灰度开：连续两轮完全同证据的硬失败 → 第 2 次即转人工（不烧第 3 轮全价重试）；
 *   - 证据变化不触发；软失败（429）不清空硬失败证据链；软失败自身不参与比较。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore } from '../src/core/store.js'
import { TaskMachine } from '../src/core/task-machine.js'
import { failureSignature, normalizeEvidence } from '../src/core/failure-evidence.js'
import { RATE_LIMIT_BACKOFF_BASE_MS } from '../src/core/types.js'
import type { TaskVerifyFn } from '../src/core/task-machine.js'
import type { AgentSlot, Mission, Task } from '../src/core/types.js'

let root: string
let store: JsonStore
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

function makeMachine(earlyExit: { isEnabled(): boolean } | undefined): TaskMachine {
  return new TaskMachine(store, { clock: () => now, rng: () => 0, verify, earlyExit })
}

/** 派发→运行→失败的完整一轮（blocked 后可再次 dispatch 重试）。 */
function failOnce(machine: TaskMachine, message: string, kind: 'crash' | 'rate_limited' = 'crash'): void {
  machine.dispatch('T-1', 'S-1')
  machine.start('T-1')
  machine.fail('T-1', { kind, message })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pod-early-exit-'))
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
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('failure-evidence 指纹', () => {
  it('空白/大小写抖动同签名（同一根因的格式噪音不改变证据）', () => {
    expect(normalizeEvidence('Error:  EPERM  at rename\n  operation')).toBe(
      normalizeEvidence('error: eperm at rename operation'),
    )
    expect(failureSignature('crash', ' Boom ')).toBe(failureSignature('crash', 'boom'))
  })

  it('不同故障类别或消息 → 不同签名；长消息取尾段 400 字符', () => {
    expect(failureSignature('crash', 'a')).not.toBe(failureSignature('wall_clock', 'a'))
    expect(failureSignature('crash', 'a')).not.toBe(failureSignature('crash', 'b'))
    const long = 'x'.repeat(500) + '-tail-marker'
    // 500 + 12 = 512 字符，取尾 400 → 丢头部 112 → 剩 388 个 x + 尾标记
    expect(normalizeEvidence(long)).toBe('x'.repeat(388) + '-tail-marker')
  })
})

describe('early exit 灰度关（默认，行为与旧版一致）', () => {
  it('连续同证据失败不提前转人工，attempts>=3 才 escalated；证据字段照常落盘', () => {
    const machine = makeMachine(undefined)
    failOnce(machine, 'EPERM: rename failed')
    failOnce(machine, 'EPERM: rename failed')
    let task = store.getTask('M-1', 'T-1')!
    expect(task.status).toBe('blocked')
    expect(task.attempts).toBe(2)
    expect(task.no_new_evidence).toBe(1)
    expect(task.last_failure_signature).toBe(failureSignature('crash', 'EPERM: rename failed'))

    failOnce(machine, 'EPERM: rename failed')
    task = store.getTask('M-1', 'T-1')!
    expect(task.status).toBe('escalated')
    expect(task.attempts).toBe(3)
    expect(task.last_error).not.toContain('early exit')
  })
})

describe('early exit 灰度开', () => {
  it('连续两轮同证据 → 第 2 次即转人工（省下第 3 轮），事件带 early_exit 标记', () => {
    const machine = makeMachine({ isEnabled: () => true })
    failOnce(machine, 'EPERM: rename failed')
    failOnce(machine, 'EPERM: rename failed')
    const task = store.getTask('M-1', 'T-1')!
    expect(task.status).toBe('escalated')
    expect(task.attempts).toBe(2)
    expect(task.last_error).toContain('early exit')
    expect(task.last_error).toContain('EPERM: rename failed')
    const escalated = store.listEvents('M-1').filter((e) => e.kind === 'task_escalated')
    expect(escalated).toHaveLength(1)
    expect(escalated[0]!.payload.early_exit).toBe(true)
    expect(escalated[0]!.payload.no_new_evidence).toBe(1)
  })

  it('证据在变化（错误信息不同）→ 不触发，第 3 次才按 attempts 兜底转人工', () => {
    const machine = makeMachine({ isEnabled: () => true })
    failOnce(machine, 'EPERM: rename failed')
    failOnce(machine, 'ENOENT: no such file')
    let task = store.getTask('M-1', 'T-1')!
    expect(task.status).toBe('blocked')
    expect(task.no_new_evidence).toBe(0)

    failOnce(machine, 'EACCES: permission denied')
    task = store.getTask('M-1', 'T-1')!
    expect(task.status).toBe('escalated')
    expect(task.attempts).toBe(3)
  })

  it('429 软失败不清空硬失败证据链：crash(A) → 429 → crash(A) 触发止损', () => {
    const machine = makeMachine({ isEnabled: () => true })
    failOnce(machine, 'EPERM: rename failed')
    failOnce(machine, 'upstream 429', 'rate_limited')
    let task = store.getTask('M-1', 'T-1')!
    expect(task.status).toBe('blocked') // 429 自身不触发（软失败不参与比较）
    expect(task.no_new_evidence).toBe(0)

    // soft_attempts 从首次硬失败起累计（crash 后=1），429 退避指数 2^1 → 2×base
    now += 2 * RATE_LIMIT_BACKOFF_BASE_MS + 1 // 等过 429 退避窗口再重派
    failOnce(machine, 'EPERM: rename failed')
    task = store.getTask('M-1', 'T-1')!
    expect(task.status).toBe('escalated')
    expect(task.attempts).toBe(2)
    expect(task.last_error).toContain('early exit')
  })

  it('阈值可调：threshold=3 时连续两次同证据仍给第三次机会', () => {
    const machine = new TaskMachine(store, {
      clock: () => now,
      rng: () => 0,
      verify,
      earlyExit: { isEnabled: () => true, threshold: 3 },
    })
    failOnce(machine, 'EPERM: rename failed')
    failOnce(machine, 'EPERM: rename failed')
    let task = store.getTask('M-1', 'T-1')!
    expect(task.status).toBe('blocked')
    failOnce(machine, 'EPERM: rename failed')
    task = store.getTask('M-1', 'T-1')!
    // attempts=3 兜底先到：止损阈值≥3 时等价于旧行为
    expect(task.status).toBe('escalated')
    expect(task.last_error).not.toContain('early exit')
  })
})
