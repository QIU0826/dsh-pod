/**
 * Mission 状态机 —— 方案书 3.4 节：
 *   planning → running → awaiting_approval → done | paused | aborted
 *
 * 架构不变量（3.3 节）：
 *   - LLM 提议、代码裁决：所有迁移经本模块校验，非法迁移抛 InvalidTransitionError；
 *   - 质量门不可关（DoD-5）：tasksCompleted 强制执行「独立 review」——
 *     审查者 ≠ 实现者、review 有明确审查对象、存在 review 任务则必须 done；
 *   - 手动模式不绕过状态机：commanderFailed 只切换 orchestration_mode，
 *     UI 手动派发/收集/审批走同一套代码入口。
 *
 * CR-01-4：awaiting_approval 期间全部 watchdog 挂起（watchdogActive=false）。
 * CR-01-7：审批超期 → mission 自动 pause（不 abort、不丢状态）。
 * DoD-11：recover 从磁盘重建 mission + pending 审批卡，跨重启无内存态依赖。
 */

import { InvalidTransitionError, NotFoundError } from './errors.js'
import type { ApprovalEngine } from './approvals.js'
import type { PodStore } from './store.js'
import type { ApprovalRequest, Mission, MissionStatus } from './types.js'

export interface MissionMachineOptions {
  clock?: () => number
}

export interface MissionRecovery {
  mission: Mission
  pendingApprovals: ApprovalRequest[]
}

type MissionEvent = 'start' | 'tasksCompleted' | 'approve' | 'deny' | 'pause' | 'resume' | 'abort'

/** 状态 → 合法事件表（唯一裁决源，代码即法律）。 */
const TRANSITIONS: Readonly<Record<MissionStatus, ReadonlySet<MissionEvent>>> = {
  planning: new Set(['start', 'abort']),
  running: new Set(['tasksCompleted', 'pause', 'abort']),
  awaiting_approval: new Set(['approve', 'deny', 'pause', 'abort']),
  paused: new Set(['resume', 'abort']),
  done: new Set(),
  aborted: new Set(),
}

const ABORTABLE: ReadonlySet<MissionStatus> = new Set(['planning', 'running', 'paused', 'awaiting_approval'])

export class MissionMachine {
  private readonly store: PodStore
  private readonly approvals: ApprovalEngine
  private readonly clock: () => number
  private readonly missionId: string

  constructor(
    store: PodStore,
    approvals: ApprovalEngine,
    missionId: string,
    options: MissionMachineOptions = {},
  ) {
    this.store = store
    this.approvals = approvals
    this.missionId = missionId
    this.clock = options.clock ?? (() => Date.now())
  }

  /** 显式绑定 mission（2.12 节：Store 按多 mission 设计，状态机不猜"当前"mission）。 */
  private getMission(): Mission {
    const mission = this.store.getMission(this.missionId)
    if (mission === undefined) throw new NotFoundError('mission', this.missionId)
    return mission
  }

  private guard(mission: Mission, event: MissionEvent): void {
    if (!TRANSITIONS[mission.status].has(event)) {
      throw new InvalidTransitionError(mission.status, event, `event '${event}' not allowed`)
    }
  }

  private emit(mission: Mission, kind: string, payload: Record<string, unknown>): void {
    this.store.appendEvent(mission.id, {
      id: `ev-${kind}-${this.clock()}`,
      mission_id: mission.id,
      ts: this.clock(),
      kind,
      payload,
    })
  }

  start(): void {
    const mission = this.getMission()
    this.guard(mission, 'start')
    this.store.updateMission(mission.id, { status: 'running' })
    this.emit(mission, 'mission_started', {})
  }

  /**
   * 代码裁决的进审批条件（3.4 节 / DoD-5）：
   * 全部任务 done；存在 review 任务则必须至少一个 done；
   * 每个 review 必须有审查对象且审查者 ≠ 实现者（fail-closed）。
   */
  tasksCompleted(): void {
    const mission = this.getMission()
    this.guard(mission, 'tasksCompleted')
    const tasks = this.store.listTasks(mission.id)
    if (tasks.length === 0) {
      throw new InvalidTransitionError('running', 'awaiting_approval', 'mission has no tasks: refusing empty approval')
    }
    // 质量门优先检查（DoD-5）：review 存在但未完成，直接以 review 理由拒绝。
    const reviewTasks = tasks.filter((t) => t.type === 'review')
    if (reviewTasks.length > 0) {
      const doneReviews = reviewTasks.filter((t) => t.status === 'done')
      if (doneReviews.length === 0) {
        throw new InvalidTransitionError('running', 'awaiting_approval', 'review tasks exist but none completed (quality gate cannot be off)')
      }
      for (const review of doneReviews) {
        if (review.depends_on.length === 0) {
          throw new InvalidTransitionError('running', 'awaiting_approval', `review ${review.id} has no review target (fail-closed)`)
        }
        for (const targetId of review.depends_on) {
          const target = this.store.getTask(targetId)
          if (target === undefined) {
            throw new InvalidTransitionError('running', 'awaiting_approval', `review ${review.id} targets missing task ${targetId}`)
          }
          if (target.owner_slot_id !== undefined && target.owner_slot_id === review.owner_slot_id) {
            throw new InvalidTransitionError('running', 'awaiting_approval', `review ${review.id}: reviewer must be different from implementer (DoD-5)`)
          }
        }
      }
    }
    for (const task of tasks) {
      if (task.status !== 'done') {
        throw new InvalidTransitionError(
          'running',
          'awaiting_approval',
          `task ${task.id} is ${task.status}, all tasks must be done`,
        )
      }
    }
    this.store.updateMission(mission.id, { status: 'awaiting_approval' })
    this.emit(mission, 'mission_awaiting_approval', {})
  }

  /**
   * 模式 3（全自动，经 experiments 灰度）：质量门通过后无审批门，直接 done。
   * 复用 tasksCompleted 的校验（质量门不可关，DoD-5），只是跳过硬性 awaiting_approval。
   */
  autoComplete(): void {
    const mission = this.getMission()
    this.guard(mission, 'tasksCompleted')
    // 复用同一质量门：review 存在必须 done、审查者≠实现者、全任务 done（DoD-5）。
    this.tasksCompleted()
    // tasksCompleted 会把状态置 awaiting_approval；模式 3 直接越过为 done。
    const after = this.getMission()
    if (after.status === 'awaiting_approval') {
      this.store.updateMission(mission.id, { status: 'done' })
      this.cleanupMissionRules()
      this.emit(mission, 'mission_done', { mode: 3 })
    }
  }

  /** 批准合并 → done。审批卡裁决由 ApprovalEngine 持久化（2.6 节模式 1）。 */
  approve(approvalId: string, by: string): void {
    const mission = this.getMission()
    this.guard(mission, 'approve')
    this.approvals.decide(approvalId, 'approved', by)
    this.store.updateMission(mission.id, { status: 'done' })
    this.cleanupMissionRules()
    this.emit(mission, 'mission_done', { approval_id: approvalId, by })
  }

  /**
   * W5 合并前确认（3.3 节不变量 3：合并必须已批准）：
   * 仅裁决审批卡 → approved，mission 状态不变（仍 awaiting_approval）。
   * ApplyPatch.apply 校验卡已 approved 后才执行 git merge。
   */
  approveCard(approvalId: string, by: string, editedParams?: Record<string, string>): void {
    const mission = this.getMission()
    this.guard(mission, 'approve')
    this.approvals.decide(approvalId, 'approved', by, undefined, editedParams)
  }

  /** 合并成功 → mission done（卡已 approved，不再重复裁决）。 */
  completeAfterMerge(approvalId: string, by: string): void {
    const mission = this.getMission()
    this.guard(mission, 'approve')
    this.store.updateMission(mission.id, { status: 'done' })
    this.cleanupMissionRules()
    this.emit(mission, 'mission_done', { approval_id: approvalId, by })
  }

  /** AS-2：mission 结束清理 scope=mission 的 auto 建议规则（同类免弹卡不跨 mission 泄漏）。 */
  private cleanupMissionRules(): void {
    for (const rule of this.store.listRules()) {
      if (rule.scope === 'mission' && rule.source === 'auto-from-approval') {
        this.store.deleteRule(rule.id)
      }
    }
  }

  /** 合并失败 → 审批卡回滚 pending（mission 保持 awaiting_approval，可重试或驳回）。 */
  rollbackApproval(approvalId: string): void {
    const approval = this.store.getApproval(approvalId)
    if (approval === undefined) throw new NotFoundError('approval', approvalId)
    this.store.updateApproval(approvalId, { status: 'pending', decided_at: undefined, decided_by: undefined })
  }

  /** 拒绝 → 回到 running（补任务重跑；审批卡记录 deny 原因）。 */
  deny(approvalId: string, by: string, reason: string): void {
    const mission = this.getMission()
    this.guard(mission, 'deny')
    this.approvals.decide(approvalId, 'denied', by, reason)
    this.store.updateMission(mission.id, { status: 'running' })
    this.emit(mission, 'mission_denied', { approval_id: approvalId, by, reason })
  }

  pause(): void {
    const mission = this.getMission()
    this.guard(mission, 'pause')
    this.store.updateMission(mission.id, { status: 'paused' })
    this.emit(mission, 'mission_paused', {})
  }

  /** 恢复：pending 审批卡仍在 → awaiting_approval；否则 running。 */
  resume(): void {
    const mission = this.getMission()
    this.guard(mission, 'resume')
    const hasPending = this.approvals.pendingFor(mission.id).length > 0
    this.store.updateMission(mission.id, { status: hasPending ? 'awaiting_approval' : 'running' })
    this.emit(mission, 'mission_resumed', { back_to: hasPending ? 'awaiting_approval' : 'running' })
  }

  abort(reason: string): void {
    const mission = this.getMission()
    if (!ABORTABLE.has(mission.status)) {
      throw new InvalidTransitionError(mission.status, 'aborted', 'mission already terminal')
    }
    this.store.updateMission(mission.id, { status: 'aborted' })
    this.cleanupMissionRules()
    this.emit(mission, 'mission_aborted', { reason })
  }

  /** Watchdog 触发：切手动模式。状态机本身完备自洽，不依赖 commander 存在（3.3 节）。 */
  commanderFailed(reason: string): void {
    const mission = this.getMission()
    this.store.updateMission(mission.id, {
      orchestration_mode: 'manual',
      commander_healthy: false,
    })
    this.emit(mission, 'mission_manual_mode', { reason })
  }

  /**
   * CR-01-4：awaiting_approval 期间 watchdog 全部挂起（审批可挂起数小时至数天，
   * idle/commander watchdog 继续计时会误杀）；approve/deny 后恢复。
   */
  watchdogActive(): boolean {
    return this.getMission().status !== 'awaiting_approval'
  }

  /** CR-01-7：超期审批 → 自动 pause + 告警事件（不 abort、不丢状态）。 */
  tickStaleApprovals(): ApprovalRequest[] {
    const mission = this.getMission()
    const stale = this.approvals.staleCheck(mission.id)
    if (stale.length > 0 && mission.status === 'awaiting_approval') {
      this.store.updateMission(mission.id, { status: 'paused' })
      this.emit(mission, 'mission_paused_stale_approval', { stale: stale.map((a) => a.id) })
    }
    return stale
  }

  /** DoD-11：跨重启恢复——只读磁盘重建，commander 窗口只是缓存。 */
  static recover(store: PodStore, approvals: ApprovalEngine, missionId: string): MissionRecovery {
    const mission = store.getMission(missionId)
    if (mission === undefined) throw new NotFoundError('mission', missionId)
    return { mission, pendingApprovals: approvals.rebuildAfterRestart(missionId) }
  }
}
