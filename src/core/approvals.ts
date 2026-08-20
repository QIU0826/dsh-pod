/**
 * 审批引擎 —— 方案书 2.6 节。
 *
 * MVP 实现模式 1（写盘前确认）：apply_patch 唯一入口，合并回主树必须用户 approve。
 * 模式 2/3 显式拒绝（UnsupportedError），不静默降级。
 *
 * 持久执行范式（附录 F-6/F-26）：审批请求持久化于 Store（磁盘唯一事实源），
 * 可挂起数小时至数天；DSH 插件或浏览器重启后，rebuildAfterRestart 从磁盘
 * 重建审批卡（DoD-11）。
 *
 * CR-01-7：审批卡有处理期限（默认 7 天），超期标记 stale，由 mission 层自动 pause。
 */

import { ApprovalConflictError, NotFoundError, UnsupportedError } from './errors'
import type { PodStore } from './store'
import type { ApprovalRequest, Mission } from './types'
import { APPROVAL_STALE_MS } from './types'

export interface ApprovalPatch {
  slot_id: string
  worktree_path: string
  base_commit?: string
  head_commit?: string
  diff_path?: string
  summary: string
}

export interface ApprovalEngineOptions {
  clock?: () => number
  idFn?: () => string
  staleAfterMs?: number
}

export class ApprovalEngine {
  private readonly store: PodStore
  private readonly clock: () => number
  private readonly idFn: () => string
  private readonly staleAfterMs: number

  constructor(store: PodStore, options: ApprovalEngineOptions = {}) {
    this.store = store
    this.clock = options.clock ?? (() => Date.now())
    this.idFn = options.idFn ?? (() => `A-${this.clock()}-${Math.floor(Math.random() * 1e6)}`)
    this.staleAfterMs = options.staleAfterMs ?? APPROVAL_STALE_MS
  }

  private requireMission(missionId: string): Mission {
    const mission = this.store.getMission(missionId)
    if (mission === undefined) throw new NotFoundError('mission', missionId)
    return mission
  }

  /** 发起审批（模式 1）：持久化 pending 审批卡 + 设置过期时刻。 */
  request(missionId: string, patch: ApprovalPatch): ApprovalRequest {
    const mission = this.requireMission(missionId)
    if (mission.approval_mode !== 1) {
      throw new UnsupportedError(`approval mode ${mission.approval_mode}`, 'MVP only implements mode 1 (write-before-confirm)')
    }
    const now = this.clock()
    const approval: ApprovalRequest = {
      id: this.idFn(),
      mission_id: missionId,
      patch: { ...patch },
      status: 'pending',
      created_at: now,
    }
    this.store.createApproval(approval)
    this.store.updateMission(missionId, { approval_stale_at: now + this.staleAfterMs })
    this.store.appendEvent(missionId, {
      id: `ev-approval-${approval.id}`,
      mission_id: missionId,
      ts: now,
      kind: 'approval_requested',
      payload: { approval_id: approval.id, patch: approval.patch },
    })
    return approval
  }

  /** 裁决审批卡。重复裁决 → ApprovalConflictError（防竞态/防误双击）。 */
  decide(id: string, decision: 'approved' | 'denied', by: string, reason?: string): ApprovalRequest {
    const approval = this.store.getApproval(id)
    if (approval === undefined) throw new NotFoundError('approval', id)
    if (approval.status !== 'pending') {
      throw new ApprovalConflictError(id, 'pending', approval.status)
    }
    const decided: ApprovalRequest = {
      ...approval,
      status: decision,
      decided_at: this.clock(),
      decided_by: by,
      deny_reason: decision === 'denied' ? reason : undefined,
    }
    this.store.updateApproval(id, decided)
    this.store.updateMission(approval.mission_id, { approval_stale_at: undefined })
    this.store.appendEvent(approval.mission_id, {
      id: `ev-approval-${id}-${decision}`,
      mission_id: approval.mission_id,
      ts: this.clock(),
      kind: decision === 'approved' ? 'approval_approved' : 'approval_denied',
      payload: { approval_id: id, by, reason },
    })
    return decided
  }

  pendingFor(missionId: string): ApprovalRequest[] {
    return this.store.listApprovals(missionId).filter((a) => a.status === 'pending')
  }

  /** 跨重启重建（DoD-11）：pending 审批卡全部来自磁盘，无内存态。 */
  rebuildAfterRestart(missionId: string): ApprovalRequest[] {
    return this.pendingFor(missionId)
  }

  /** CR-01-7：超期未处理的 pending 审批卡 → 标记 stale 并返回（调用方负责 pause mission）。 */
  staleCheck(missionId: string): ApprovalRequest[] {
    const now = this.clock()
    const stale: ApprovalRequest[] = []
    for (const approval of this.pendingFor(missionId)) {
      if (now - approval.created_at >= this.staleAfterMs) {
        this.store.updateApproval(approval.id, { status: 'stale' })
        stale.push({ ...approval, status: 'stale' })
      }
    }
    return stale
  }
}
