import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalConflictError, NotFoundError, UnsupportedError } from '../src/core/errors.js'
import { JsonStore } from '../src/core/store.js'
import { ApprovalEngine } from '../src/core/approvals.js'
import { decidePermission, DEFAULT_RULES } from '../src/core/permission-rules.js'
import type { Mission } from '../src/core/types.js'
import { APPROVAL_STALE_MS } from '../src/core/types.js'

let root: string
let store: JsonStore
let engine: ApprovalEngine
let now: number
let seq: number

function makeMission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'M-1',
    name: 'm',
    goal: 'g',
    status: 'awaiting_approval',
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

const patch = {
  slot_id: 'S-1',
  worktree_path: 'C:\\repo\\.worktrees\\S-1',
  base_commit: 'a1b2c3d',
  head_commit: 'f0e1d2c',
  diff_path: 'out/task-T-3.diff',
  summary: '实现 rate limiter',
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pod-approval-'))
  now = 1_700_000_000_000
  seq = 0
  store = new JsonStore({ rootDir: root, clock: () => now })
  store.open()
  store.createMission(makeMission())
  engine = new ApprovalEngine(store, {
    clock: () => now,
    idFn: () => `A-${++seq}`,
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ApprovalEngine.request', () => {
  it('创建 pending 审批卡并持久化（跨重启恢复的事实源）', () => {
    const approval = engine.request('M-1', patch)
    expect(approval.status).toBe('pending')
    expect(approval.mission_id).toBe('M-1')
    const reopened = new JsonStore({ rootDir: root })
    reopened.open()
    expect(reopened.getApproval(approval.id)?.status).toBe('pending')
  })

  it('设置审批过期时刻（CR-01-7：7 天未处理 → 自动 pause）', () => {
    engine.request('M-1', patch)
    expect(store.getMission('M-1')!.approval_stale_at).toBe(now + APPROVAL_STALE_MS)
  })

  it('不存在的 mission → NotFoundError', () => {
    expect(() => engine.request('nope', patch)).toThrowError(NotFoundError)
  })

  it('审批模式 2/3 未实现 → UnsupportedError（显式拒绝，不静默降级）', () => {
    store.updateMission('M-1', { approval_mode: 2 })
    expect(() => engine.request('M-1', patch)).toThrowError(UnsupportedError)
  })
})

describe('ApprovalEngine.decide', () => {
  it('approve：pending → approved，记录决定人与时间', () => {
    const approval = engine.request('M-1', patch)
    now += 60_000
    const decided = engine.decide(approval.id, 'approved', 'user')
    expect(decided.status).toBe('approved')
    expect(decided.decided_by).toBe('user')
    expect(decided.decided_at).toBe(now)
    expect(store.getMission('M-1')!.approval_stale_at).toBeUndefined()
  })

  it('deny：pending → denied，带原因', () => {
    const approval = engine.request('M-1', patch)
    const decided = engine.decide(approval.id, 'denied', 'user', '测试没过')
    expect(decided.status).toBe('denied')
    expect(decided.deny_reason).toBe('测试没过')
  })

  it('重复 decide → ApprovalConflictError（幂等拒绝）', () => {
    const approval = engine.request('M-1', patch)
    engine.decide(approval.id, 'approved', 'user')
    expect(() => engine.decide(approval.id, 'approved', 'user2')).toThrowError(ApprovalConflictError)
  })

  it('decide 不存在的审批卡 → NotFoundError', () => {
    expect(() => engine.decide('A-nope', 'approved', 'user')).toThrowError(NotFoundError)
  })

  it('approve 携带 edited_params（AS-3：编辑参数后放行，审计留痕）', () => {
    const approval = engine.request('M-1', patch)
    const decided = engine.decide(approval.id, 'approved', 'user', undefined, { merge_note: '评审确认过，放行' })
    expect(decided.status).toBe('approved')
    expect(decided.edited_params).toEqual({ merge_note: '评审确认过，放行' })
    // 审批事件 payload 含 edited_params（Canvas 可展开查看）
    const events = store.listEvents('M-1')
    const approvedEvent = events.find((e) => e.kind === 'approval_approved')
    expect(approvedEvent?.payload.edited_params).toEqual({ merge_note: '评审确认过，放行' })
  })

  it('approve 不带 edited_params → 不写该字段', () => {
    const approval = engine.request('M-1', patch)
    const decided = engine.decide(approval.id, 'approved', 'user')
    expect(decided.edited_params).toBeUndefined()
  })
})

describe('ApprovalEngine 恢复与过期', () => {
  it('rebuildAfterRestart：从磁盘重建 pending 审批卡列表（DoD-11）', () => {
    engine.request('M-1', patch)
    now += 1000
    engine.request('M-1', { ...patch, summary: '第二个 patch' })
    const rebuilt = engine.rebuildAfterRestart('M-1')
    expect(rebuilt).toHaveLength(2)
    expect(rebuilt.every((a) => a.status === 'pending')).toBe(true)
  })

  it('staleCheck：超期未处理 → 标记 stale 并返回（供 mission 层自动 pause）', () => {
    const approval = engine.request('M-1', patch)
    now += APPROVAL_STALE_MS + 1
    const stale = engine.staleCheck('M-1')
    expect(stale.map((a) => a.id)).toEqual([approval.id])
    expect(store.getApproval(approval.id)!.status).toBe('stale')
    // 已处理的审批卡不会再被标 stale
    expect(engine.staleCheck('M-1')).toEqual([])
  })

  it('已 approve 的审批卡不参与 staleCheck', () => {
    const approval = engine.request('M-1', patch)
    engine.decide(approval.id, 'approved', 'user')
    now += APPROVAL_STALE_MS + 1
    expect(engine.staleCheck('M-1')).toEqual([])
  })
})

describe('AS-2：审批通过 → 生成建议规则 → 同类免弹卡（AgentScope-B）', () => {
  it('approve → 自动落 mission 级规则（tool=apply_patch，pattern=diff 基名，source=auto-from-approval）', () => {
    const approval = engine.request('M-1', patch)
    engine.decide(approval.id, 'approved', 'user')
    const rules = store.listRules().filter((r) => r.source === 'auto-from-approval')
    expect(rules).toHaveLength(1)
    expect(rules[0]!.tool).toBe('apply_patch')
    expect(rules[0]!.pattern).toBe('task-T-3.diff')
    expect(rules[0]!.decision).toBe('allow')
    expect(rules[0]!.scope).toBe('mission')
  })

  it('deny → 不生成规则（只记录拒绝事实）', () => {
    const approval = engine.request('M-1', patch)
    engine.decide(approval.id, 'denied', 'user', '测试没过')
    expect(store.listRules().filter((r) => r.source === 'auto-from-approval')).toHaveLength(0)
  })

  it('生成的规则可被 decidePermission 命中（同类免弹卡语义）', () => {
    const approval = engine.request('M-1', { ...patch, summary: '实现 rate limiter' })
    engine.decide(approval.id, 'approved', 'user')
    const rule = store.listRules().find((r) => r.source === 'auto-from-approval')!
    const decision = decidePermission({
      tool: { name: 'apply_patch', input: { file: 'task-T-3.diff' } },
      rules: [...DEFAULT_RULES, rule],
      defaultMode: 'ask',
    })
    expect(decision.behavior).toBe('allow')
    expect(decision.rule_id).toBe('apply_patch:task-T-3.diff')
  })
})
