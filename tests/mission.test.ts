import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InvalidTransitionError, NotFoundError } from '../src/core/errors.js'
import { ApprovalEngine } from '../src/core/approvals.js'
import { JsonStore } from '../src/core/store.js'
import { MissionMachine } from '../src/core/mission.js'
import type { AgentSlot, Mission, Task } from '../src/core/types.js'
import { APPROVAL_STALE_MS } from '../src/core/types.js'

let root: string
let store: JsonStore
let approvals: ApprovalEngine
let machine: MissionMachine
let now: number
let seq: number

function makeMission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'M-1',
    name: 'm',
    goal: 'g',
    status: 'planning',
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

function makeSlot(id: string, role: string): AgentSlot {
  return {
    id,
    mission_id: 'M-1',
    vendor: 'claude',
    role,
    capabilities: ['编码'],
    model: 'claude-sonnet',
    effort: 'medium',
    session_tier: 'per-mission',
    status: 'idle',
    tokens_in: 0,
    tokens_out: 0,
    ctx_usage_pct: 0,
    window_tokens: 200_000,
  }
}

function makeTask(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    mission_id: 'M-1',
    title: id,
    spec: 's',
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

/** 一组已完成的实现任务 + 由不同员工完成的独立 review（DoD-5 形态）。 */
function setupDoneChain() {
  store.createTask(makeTask('T-1', { status: 'done', owner_slot_id: 'S-1' }))
  store.createTask(
    makeTask('T-2', { type: 'review', status: 'done', owner_slot_id: 'S-2', depends_on: ['T-1'] }),
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pod-mission-'))
  now = 1_700_000_000_000
  seq = 0
  store = new JsonStore({ rootDir: root, clock: () => now })
  store.open()
  store.createMission(makeMission())
  store.createSlot(makeSlot('S-1', 'implementer'))
  store.createSlot(makeSlot('S-2', 'reviewer'))
  approvals = new ApprovalEngine(store, { clock: () => now, idFn: () => `A-${++seq}` })
  machine = new MissionMachine(store, approvals, 'M-1', { clock: () => now })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('MissionMachine 基本流转', () => {
  it('start: planning → running', () => {
    machine.start()
    expect(store.getMission('M-1')!.status).toBe('running')
  })

  it('非法 start（running → running）→ InvalidTransitionError', () => {
    machine.start()
    expect(() => machine.start()).toThrowError(InvalidTransitionError)
  })

  it('tasksCompleted：全 done + 独立 review 通过 → awaiting_approval', () => {
    machine.start()
    setupDoneChain()
    machine.tasksCompleted()
    expect(store.getMission('M-1')!.status).toBe('awaiting_approval')
  })

  it('有任务未完成 → 拒绝进入 awaiting_approval', () => {
    machine.start()
    store.createTask(makeTask('T-1', { status: 'done', owner_slot_id: 'S-1' }))
    store.createTask(makeTask('T-2', { status: 'running', owner_slot_id: 'S-2' }))
    expect(() => machine.tasksCompleted()).toThrowError(InvalidTransitionError)
  })

  it('无任务 → 拒绝（不允许空 mission 空批准）', () => {
    machine.start()
    expect(() => machine.tasksCompleted()).toThrowError(InvalidTransitionError)
  })
})

describe('质量门（DoD-5：独立 review 不可关）', () => {
  it('存在 review 任务但未完成 → 拒绝', () => {
    machine.start()
    store.createTask(makeTask('T-1', { status: 'done', owner_slot_id: 'S-1' }))
    store.createTask(makeTask('T-2', { type: 'review', status: 'ready', depends_on: ['T-1'] }))
    expect(() => machine.tasksCompleted()).toThrowError(/review/i)
  })

  it('审查者 = 实现者 → 拒绝（审查者 ≠ 实现者）', () => {
    machine.start()
    store.createTask(makeTask('T-1', { status: 'done', owner_slot_id: 'S-1' }))
    store.createTask(
      makeTask('T-2', { type: 'review', status: 'done', owner_slot_id: 'S-1', depends_on: ['T-1'] }),
    )
    expect(() => machine.tasksCompleted()).toThrowError(/different/i)
  })

  it('review 任务缺少审查对象（depends_on 空）→ 拒绝（fail-closed）', () => {
    machine.start()
    store.createTask(makeTask('T-1', { status: 'done', owner_slot_id: 'S-1' }))
    store.createTask(makeTask('T-2', { type: 'review', status: 'done', owner_slot_id: 'S-2' }))
    expect(() => machine.tasksCompleted()).toThrowError(/target/i)
  })

  it('用户显式不派发 review 任务 → 放行（3.4 节：可跳过的退化形态）', () => {
    machine.start()
    store.createTask(makeTask('T-1', { status: 'done', owner_slot_id: 'S-1' }))
    machine.tasksCompleted()
    expect(store.getMission('M-1')!.status).toBe('awaiting_approval')
  })
})

describe('审批与 mission 状态联动', () => {
  it('approve → mission done（审批卡同步 approved）', () => {
    machine.start()
    setupDoneChain()
    machine.tasksCompleted()
    const approval = approvals.request('M-1', {
      slot_id: 'S-1',
      worktree_path: 'C:\\repo\\.worktrees\\S-1',
      summary: 'merge T-1',
    })
    machine.approve(approval.id, 'user')
    expect(store.getMission('M-1')!.status).toBe('done')
    expect(store.getApproval(approval.id)!.status).toBe('approved')
  })

  it('deny → 回到 running（审批卡 denied，可再次流转）', () => {
    machine.start()
    setupDoneChain()
    machine.tasksCompleted()
    const approval = approvals.request('M-1', {
      slot_id: 'S-1',
      worktree_path: 'x',
      summary: 'merge',
    })
    machine.deny(approval.id, 'user', '测试没过')
    expect(store.getMission('M-1')!.status).toBe('running')
    expect(store.getApproval(approval.id)!.status).toBe('denied')
  })

  it('非 awaiting_approval 状态 approve → InvalidTransitionError', () => {
    machine.start()
    expect(() => machine.approve('A-1', 'user')).toThrowError(InvalidTransitionError)
  })

  it('approveCard：仅裁决卡 approved，mission 保持 awaiting_approval（合并前确认）', () => {
    machine.start()
    setupDoneChain()
    machine.tasksCompleted()
    const approval = approvals.request('M-1', { slot_id: 'S-1', worktree_path: 'x', summary: 'merge' })
    machine.approveCard(approval.id, 'user')
    expect(store.getApproval(approval.id)!.status).toBe('approved')
    expect(store.getMission('M-1')!.status).toBe('awaiting_approval')
  })

  it('completeAfterMerge：合并成功 → mission done（不重复裁决）', () => {
    machine.start()
    setupDoneChain()
    machine.tasksCompleted()
    const approval = approvals.request('M-1', { slot_id: 'S-1', worktree_path: 'x', summary: 'merge' })
    machine.approveCard(approval.id, 'user')
    machine.completeAfterMerge(approval.id, 'user')
    expect(store.getMission('M-1')!.status).toBe('done')
    expect(store.getApproval(approval.id)!.status).toBe('approved')
  })

  it('rollbackApproval：合并失败 → 卡回 pending（mission 保持 awaiting_approval，可重试）', () => {
    machine.start()
    setupDoneChain()
    machine.tasksCompleted()
    const approval = approvals.request('M-1', { slot_id: 'S-1', worktree_path: 'x', summary: 'merge' })
    machine.approveCard(approval.id, 'user')
    machine.rollbackApproval(approval.id)
    expect(store.getApproval(approval.id)!.status).toBe('pending')
    expect(store.getApproval(approval.id)!.decided_by).toBeUndefined()
    expect(store.getMission('M-1')!.status).toBe('awaiting_approval')
    // 回滚后可再次裁决（防误双击后的恢复路径）
    machine.approveCard(approval.id, 'user')
    expect(store.getApproval(approval.id)!.status).toBe('approved')
  })
})

describe('暂停/恢复/中止', () => {
  it('pause/resume：running ⇄ paused', () => {
    machine.start()
    machine.pause()
    expect(store.getMission('M-1')!.status).toBe('paused')
    machine.resume()
    expect(store.getMission('M-1')!.status).toBe('running')
  })

  it('awaiting_approval 暂停后恢复 → 回到 awaiting_approval（审批卡仍在）', () => {
    machine.start()
    setupDoneChain()
    machine.tasksCompleted()
    approvals.request('M-1', { slot_id: 'S-1', worktree_path: 'x', summary: 'merge' })
    machine.pause()
    machine.resume()
    expect(store.getMission('M-1')!.status).toBe('awaiting_approval')
  })

  it('abort 从 running/paused/planning 均合法；done 之后拒绝', () => {
    machine.start()
    machine.abort('user stopped')
    expect(store.getMission('M-1')!.status).toBe('aborted')
    expect(() => machine.resume()).toThrowError(InvalidTransitionError) // aborted 是终态
  })
})

describe('Commander 降级与 watchdog 语义', () => {
  it('commanderFailed → 手动模式（orchestration_mode=manual，状态机仍完备可用）', () => {
    machine.start()
    machine.commanderFailed('watchdog: no progress 5min')
    const mission = store.getMission('M-1')!
    expect(mission.orchestration_mode).toBe('manual')
    expect(mission.commander_healthy).toBe(false)
    // 手动模式下状态机照常工作（3.3 节：状态机自洽不依赖 commander）
    setupDoneChain()
    machine.tasksCompleted()
    expect(store.getMission('M-1')!.status).toBe('awaiting_approval')
  })

  it('watchdogActive：awaiting_approval 期间挂起（CR-01-4），running 期间生效', () => {
    machine.start()
    expect(machine.watchdogActive()).toBe(true)
    setupDoneChain()
    machine.tasksCompleted()
    expect(machine.watchdogActive()).toBe(false)
  })

  it('tickStaleApprovals：审批超期 → mission 自动 pause + 告警事件（CR-01-7）', () => {
    machine.start()
    setupDoneChain()
    machine.tasksCompleted()
    approvals.request('M-1', { slot_id: 'S-1', worktree_path: 'x', summary: 'merge' })
    now += APPROVAL_STALE_MS + 1
    const stale = machine.tickStaleApprovals()
    expect(stale).toHaveLength(1)
    expect(store.getMission('M-1')!.status).toBe('paused')
    // 走状态机入口 pause()（2026-09-05 修复：此前直接 updateMission 绕过，
    // 不发 mission_paused——A2A 对端收不到 paused 信号）
    expect(store.listEvents('M-1').some((e) => e.kind === 'mission_paused')).toBe(true)
    expect(store.listEvents('M-1').some((e) => e.kind === 'mission_paused_stale_approval')).toBe(true)
  })
})

describe('跨重启恢复（DoD-11）', () => {
  it('recover：新进程从磁盘读出 mission + pending 审批卡', () => {
    machine.start()
    setupDoneChain()
    machine.tasksCompleted()
    approvals.request('M-1', { slot_id: 'S-1', worktree_path: 'x', summary: 'merge' })
    const reopenedStore = new JsonStore({ rootDir: root })
    reopenedStore.open()
    const reopenedApprovals = new ApprovalEngine(reopenedStore)
    const recovered = MissionMachine.recover(reopenedStore, reopenedApprovals, 'M-1')
    expect(recovered.mission.status).toBe('awaiting_approval')
    expect(recovered.pendingApprovals).toHaveLength(1)
  })

  it('recover 不存在的 mission → NotFoundError', () => {
    expect(() => MissionMachine.recover(store, approvals, 'nope')).toThrowError(NotFoundError)
  })
})
