import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HandoffValidationError, NotFoundError } from '../src/core/errors.js'
import { JsonStore } from '../src/core/store.js'
import { buildHandoff, planDelivery, validateHandoffPayload } from '../src/core/handoff.js'
import type { AgentSlot, HandoffPayload, Mission, Task } from '../src/core/types.js'

let root: string
let store: JsonStore
let now: number

function makeMission(): Mission {
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
  }
}

function makeSlot(id: string, tier: AgentSlot['session_tier']): AgentSlot {
  return {
    id,
    mission_id: 'M-1',
    vendor: 'claude',
    role: 'implementer',
    capabilities: ['编码'],
    model: 'claude-sonnet',
    effort: 'medium',
    session_tier: tier,
    status: 'idle',
    tokens_in: 0,
    tokens_out: 0,
    ctx_usage_pct: 0,
    window_tokens: 200_000,
  }
}

function makeTask(): Task {
  return {
    id: 'T-1',
    mission_id: 'M-1',
    title: 't',
    spec: 's',
    skill_tags: [],
    type: 'implement',
    depends_on: [],
    status: 'ready',
    attempts: 0,
    soft_attempts: 0,
    max_wall_clock_ms: 3600_000,
    created_at: now,
    updated_at: now,
  }
}

function validPayload(): HandoffPayload {
  return {
    intent: {
      brief: '实现 rate limiter',
      constraints: ['不改 API'],
      acceptance: 'npm test 全绿',
    },
    artifacts: {
      spec: 'mission/plan.md#t-1',
      context_files: ['docs/rfc.md'],
      base_commit: 'a1b2c3d',
      diff_range: 'a1b2c3d..f0e1d2c',
    },
    state: { tried: [], blockers: [] },
    expected_output: 'commit + diff + MISSION_REPORT',
    verify: ['commit_exists', 'diff_range_valid', 'test_log_exists'],
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pod-handoff-'))
  now = 1_700_000_000_000
  store = new JsonStore({ rootDir: root, clock: () => now })
  store.open()
  store.createMission(makeMission())
  store.createTask(makeTask())
  store.createSlot(makeSlot('S-1', 'per-mission'))
  store.createSlot(makeSlot('S-2', 'transient'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('交接协议校验（四件套 + verify 列表）', () => {
  it('合法 payload 通过校验', () => {
    expect(validateHandoffPayload(validPayload())).toEqual([])
  })

  it('缺失 brief → 失败', () => {
    const failures = validateHandoffPayload({ ...validPayload(), intent: { brief: '', constraints: [], acceptance: 'a' } })
    expect(failures.some((f) => f.check === 'intent_brief')).toBe(true)
  })

  it('缺失 verify 列表 → 失败（收方不信任叙事，必须声明可检查物）', () => {
    const failures = validateHandoffPayload({ ...validPayload(), verify: [] })
    expect(failures.some((f) => f.check === 'verify_checks')).toBe(true)
  })

  it('verify 含未知检查项 → 失败（fail-closed）', () => {
    const failures = validateHandoffPayload({ ...validPayload(), verify: ['magic'] })
    expect(failures.some((f) => f.check === 'verify_known')).toBe(true)
  })

  it('context_files 越界路径（..）→ 失败（路径白名单前置）', () => {
    const failures = validateHandoffPayload({
      ...validPayload(),
      artifacts: { ...validPayload().artifacts, context_files: ['../secret.md'] },
    })
    expect(failures.some((f) => f.check === 'context_files_path')).toBe(true)
  })
})

describe('buildHandoff', () => {
  it('校验通过 → 落盘 + 事件流可见', () => {
    const handoff = buildHandoff(store, {
      from_slot: 'S-1',
      to_slot: 'S-2',
      task_id: 'T-1',
      payload: validPayload(),
      mode: 'queue',
    }, { clock: () => now, idFn: () => 'H-1' })
    expect(handoff.id).toBe('H-1')
    expect(store.listHandoffs('M-1')).toHaveLength(1)
    expect(store.listEvents('M-1').some((e) => e.kind === 'handoff_created')).toBe(true)
  })

  it('非法 payload → HandoffValidationError，不落盘', () => {
    expect(() =>
      buildHandoff(store, {
        from_slot: 'S-1',
        to_slot: 'S-2',
        task_id: 'T-1',
        payload: { ...validPayload(), verify: [] },
        mode: 'queue',
      }, { clock: () => now }),
    ).toThrowError(HandoffValidationError)
    expect(store.listHandoffs('M-1')).toHaveLength(0)
  })

  it('不存在的 slot → NotFoundError', () => {
    expect(() =>
      buildHandoff(store, {
        from_slot: 'nope',
        to_slot: 'S-2',
        task_id: 'T-1',
        payload: validPayload(),
        mode: 'queue',
      }, { clock: () => now }),
    ).toThrowError(NotFoundError)
  })
})

describe('2×3 投递语义矩阵（3.2 节 × 2.5 节）', () => {
  it('瞬时会话 + queue → 新进程 + 任务 prompt 前缀注入', () => {
    expect(planDelivery(makeSlot('S-x', 'transient'), 'queue')).toEqual({
      kind: 'new-process',
      inject: 'task-prompt-prefix',
    })
  })
  it('per-mission + queue → 恢复会话为独立一轮', () => {
    expect(planDelivery(makeSlot('S-x', 'per-mission'), 'queue')).toEqual({
      kind: 'resume-session',
      inject: 'task-prompt',
    })
  })
  it('auto-reset + queue → 重置会话 + 注入结构化摘要', () => {
    expect(planDelivery(makeSlot('S-x', 'auto-reset'), 'queue')).toEqual({
      kind: 'reset-session',
      inject: 'structured-summary',
    })
  })
  it('瞬时会话 + memory → 落盘待下次任务携带', () => {
    expect(planDelivery(makeSlot('S-x', 'transient'), 'memory')).toEqual({
      kind: 'memory-file',
      carry: 'next-dispatch',
    })
  })
  it('per-mission + memory → 写入会话上下文不打断', () => {
    expect(planDelivery(makeSlot('S-x', 'per-mission'), 'memory')).toEqual({
      kind: 'context-append',
      interrupt: false,
    })
  })
  it('auto-reset + memory → 磁盘 memory 附件下次派单必带', () => {
    expect(planDelivery(makeSlot('S-x', 'auto-reset'), 'memory')).toEqual({
      kind: 'memory-file',
      carry: 'mandatory',
    })
  })
})
