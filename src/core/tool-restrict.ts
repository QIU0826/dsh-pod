/**
 * P0-1 宿主侧接线（待办清单 P0-1 剩余项，2026-09-05 落地）：stage → deny 掩码控制器。
 *
 * 宿主（@deepseek-ai/dsh-tools）的动态工具呈现原语是 `ctx.tools.restrict({allow?, deny?})`
 * ——只有硬隐藏，没有「一行索引」呈现模式，所以方案书 P0-1 的「非 stage 工具给索引行」
 * 需要宿主侧 index-presentation 支持（暂不存在）。本控制器取其中**语义零风险**的子集：
 *
 *   只 deny「当前阶段调用必然失败」的工具（fail-safe 方向：被 deny 的调用本来就会
 *   409/报错， deny 不改变任何合法调用的可见性），无 mission 时全量放行。
 *
 * 纪律说明（诚实标注）：
 *   - deny pod_plan 一类「跨阶段偶发可用」的工具不在表内——expand 后不可调用会造成
 *     「看得到 schema 打不通」的困惑面，等宿主 index-presentation 落地再做完整分层；
 *   - token 收益是边际的（pod_launch ≈1.4KB），本切片的主要价值是把 restrict 原语
 *     接进编排生命周期，为后续完整分层打底。
 */

import type { PodToolStage } from './tool-stages.js'

/** mission 状态 → 工具呈现阶段（deny 掩码的推导口径）。undefined = 无活跃 mission。 */
export type MissionStage =
  | 'none'
  | 'planning'
  | 'running'
  | 'awaiting_approval'
  | 'paused'
  | 'terminal'

/** 无 mission 时必然失败的 mission 域工具（调用会 NOT_INITIALIZED / NOT_FOUND）。 */
export const MISSION_SCOPED_TOOLS: readonly string[] = [
  'pod_dispatch',
  'pod_approve',
  'pod_steer',
  'pod_pause',
  'pod_resume',
  'pod_collect',
]

/**
 * 阶段 → deny 列表（只含「该阶段调用必然失败」的工具）：
 *   - none/terminal：mission 域工具全部不可用；launch/plan/status/cron/memory 正常。
 *   - planning/running：已有活跃 mission，pod_launch 必 409（单活跃锁）→ deny。
 *   - awaiting_approval/paused：不推进派发（dispatchTask 停摆守卫恒 false）→ 连 pod_dispatch 一起 deny。
 */
export function podDenyForStage(stage: MissionStage): readonly string[] {
  switch (stage) {
    case 'none':
    case 'terminal':
      return MISSION_SCOPED_TOOLS
    case 'planning':
    case 'running':
      return ['pod_launch']
    case 'awaiting_approval':
    case 'paused':
      return ['pod_launch', 'pod_dispatch']
  }
}

/**
 * mission 状态（store 里的 mission.status）→ 呈现阶段。undefined = 无活跃 mission。
 * planning 与 running 同掩码但分开建模（后续 index-presentation 落地时口径已就位）。
 */
export function missionStatusToStage(status: string | undefined): MissionStage {
  if (status === undefined) return 'none'
  switch (status) {
    case 'planning':
      return 'planning'
    case 'running':
      return 'running'
    case 'awaiting_approval':
      return 'awaiting_approval'
    case 'paused':
      return 'paused'
    default:
      return 'terminal'
  }
}

/**
 * deny 掩码应用器（差分驱动：掩码没变不重复 apply——restrict 会叠加 intersect，
 * 重复 apply 同掩码无害但浪费；掩码变化必须先 lift 旧约束再 apply 新的，
 * 否则相交语义会让 deny 集只增不减）。
 */
export class StageDenyController {
  private lift: (() => void) | undefined
  private applied: readonly string[] = []

  constructor(private readonly applyDeny: (deny: readonly string[]) => () => void) {}

  /** 推进到目标阶段；失败（宿主拒绝未知名等）→ 记录并保持上一掩码（fail-safe 全量可见）。 */
  sync(stage: MissionStage): { changed: boolean; denied: readonly string[] } {
    const target = podDenyForStage(stage)
    if (this.sameSet(target, this.applied)) return { changed: false, denied: this.applied }
    // 差分：先解除旧约束（可能为空 = 从未应用过），再应用新掩码
    if (this.lift !== undefined) {
      try {
        this.lift()
      } catch {
        /* 旧约束已失效（宿主重启/HMR）：静默，新约束照常应用 */
      }
      this.lift = undefined
    }
    this.applied = []
    if (target.length > 0) {
      try {
        this.lift = this.applyDeny(target)
        this.applied = target
      } catch {
        // 宿主拒绝（未知工具名等）：保持全量可见（fail-safe），本轮不重试
        this.lift = undefined
        this.applied = []
      }
    }
    return { changed: true, denied: this.applied }
  }

  /** 永久解除（插件卸载）。 */
  dispose(): void {
    if (this.lift !== undefined) {
      try {
        this.lift()
      } catch {
        /* best effort */
      }
      this.lift = undefined
    }
    this.applied = []
  }

  private sameSet(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false
    const set = new Set(b)
    return a.every((x) => set.has(x))
  }
}

/** PodToolStage 仅被类型引用保留（后续 index-presentation 分层的口径锚点）。 */
export type { PodToolStage }
