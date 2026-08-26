/**
 * Dispatcher 任务路由 —— 方案书 3.3 节。
 *
 * 路由因子（保留顺序）：能力匹配（硬条件）> 当前负载 > 单任务成本 > 历史成功率。
 * 历史成功率字段 v0.2 起生效（Ledger→路由权重）；路由结果可被用户一键覆盖
 * （overrideRoute 只是纯函数，覆盖记录走任务 owner 字段 + 事件流）。
 *
 * 故障态槽位（error/stopped/rate_limited/waiting_approval）不可路由（3.4 节）。
 */

import type { AgentSlot, Task } from './types.js'

/** 不可接受新任务的槽位状态。 */
const UNAVAILABLE_STATUSES: ReadonlySet<AgentSlot['status']> = new Set([
  'error',
  'stopped',
  'rate_limited',
  'waiting_approval',
])

const ACTIVE_TASK_STATUSES: ReadonlySet<Task['status']> = new Set(['dispatched', 'running'])

export interface RouteContext {
  slots: AgentSlot[]
  tasks: Task[]
  /** 模型成本表（dispatcher 只关心相对序，传空对象则按模型名排序退化为稳定序）。 */
  modelCost?: Record<string, number>
  /**
   * 槽位历史成功率（0-1）：Ledger→路由权重（2.7 节 v0.2 起生效）。
   * 缺省/无数据视为中性 0.5，同序时回退稳定序，不劣化原路由。
   */
  slotSuccess?: Record<string, number>
}

export type RouteResult =
  | { slotId: string; reason: string }
  | { slotId: null; reason: string }

/** 能力匹配：任务标签 ⊆ 槽位能力（任务无标签 → 任意槽位）。 */
function capabilitiesMatch(slot: AgentSlot, task: Task): boolean {
  if (task.skill_tags.length === 0) return true
  const caps = new Set(slot.capabilities)
  return task.skill_tags.every((tag) => caps.has(tag))
}

function activeLoad(slotId: string, tasks: Task[]): number {
  return tasks.filter((t) => t.owner_slot_id === slotId && ACTIVE_TASK_STATUSES.has(t.status)).length
}

/**
 * 路由决策（纯函数）：能力硬过滤 → 负载升序 → 成本升序 → 稳定序。
 * 返回 null 时 reason 说明硬条件失败原因（覆盖性体检/告警的数据源）。
 */
export function routeTask(task: Task, context: RouteContext): RouteResult {
  const candidates = context.slots.filter((slot) => {
    if (UNAVAILABLE_STATUSES.has(slot.status)) return false
    if (slot.mission_id !== task.mission_id) return false
    if (!capabilitiesMatch(slot, task)) return false
    return true
  })
  if (candidates.length === 0) {
    return {
      slotId: null,
      reason:
        context.slots.length === 0
          ? 'no slots in roster'
          : 'no slot matches capabilities or all slots unavailable',
    }
  }
  const cost = context.modelCost ?? {}
  const success = context.slotSuccess ?? {}
  const scored = candidates
    .map((slot) => ({
      slot,
      load: activeLoad(slot.id, context.tasks),
      cost: cost[slot.model] ?? Number.MAX_SAFE_INTEGER,
      // 无历史成功率数据 → 中性 0.5（与未启用时同序，不劣化原路由）
      successRate: clamp01(success[slot.id]),
    }))
    .sort(
      (a, b) =>
        a.load - b.load || // 负载升序
        a.cost - b.cost || // 成本升序
        b.successRate - a.successRate || // 历史成功率降序（越高越优先）
        a.slot.id.localeCompare(b.slot.id) // 稳定序兜底
    )
  const best = scored[0]!
  return { slotId: best.slot.id, reason: `load=${best.load} cost-rank ok success=${best.successRate.toFixed(2)}` }
}

/** 成功率收敛到 [0,1]；undefined/越界 → 0.5（中性，与无数据等价的稳定序）。 */
function clamp01(v: number | undefined): number {
  if (v === undefined || Number.isNaN(v)) return 0.5
  return Math.max(0, Math.min(1, v))
}

/** 用户一键覆盖：绕过路由（记录覆盖事实，仍受状态机合法性约束）。 */
export function overrideRoute(taskId: string, slotId: string): { task_id: string; slot_id: string } {
  return { task_id: taskId, slot_id: slotId }
}
