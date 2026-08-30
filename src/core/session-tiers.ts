/**
 * 会话生命周期三档制 —— 方案书 3.2 节 / 3.6 节 S5（裁决 v1 矛盾，D2）。
 *
 *   A · 瞬时：每任务新进程，无跨任务上下文（codex 默认，或 exec resume 不可用的降级档）
 *   B · per-mission 持久：同员工同 mission 复用会话（claude 默认，--resume/--session-id）
 *   C · 自动重置：上下文占用 ≥ 70%（tokens_in+out / 窗口估算）→ 销毁会话，
 *       从磁盘结构化交接文档重建，注入摘要后继续
 *
 * 原始对话永不持久化进 commander 上下文：任务层原始日志只落磁盘与 Canvas。
 */

import type { PodStore } from './store.js'
import type { AgentSlot, SessionTier, Vendor } from './types.js'
import { CTX_RESET_THRESHOLD_PCT } from './types.js'

/** 默认档位（2.3 节⑤ / O7）。 */
export function tierDefaults(vendor: Vendor): SessionTier {
  switch (vendor) {
    case 'claude':
      return 'per-mission'
    case 'codex':
      return 'transient'
    case 'dsh':
      return 'transient'
    case 'ark':
      return 'transient'
    case 'opencode':
      return 'transient'
  }
}

/** 上下文占用估算（tokens_in+out / 窗口大小，封顶 100%）。 */
export function estimateCtxUsage(tokensIn: number, tokensOut: number, windowTokens: number): number {
  if (windowTokens <= 0) return 0
  const pct = ((tokensIn + tokensOut) / windowTokens) * 100
  return Math.min(Math.max(pct, 0), 100)
}

/**
 * 当前会话的上下文占用估算（扣除会话基线后的增量 / 窗口大小，封顶 100%）。
 *
 * 与 `estimateCtxUsage` 的区别：后者算的是**累计** token 占比，而会话重建后
 * 上下文实际归零——累计消耗是成本事实不能清零，所以靠 `session_base_tokens` 做差。
 * 少了这一步，档位 C 重置后下一次算占用率会立刻反弹回高位，变成每次派发都重置。
 */
export function sessionCtxUsage(
  slot: Pick<AgentSlot, 'tokens_in' | 'tokens_out' | 'window_tokens' | 'session_base_tokens'>,
): number {
  const base = slot.session_base_tokens ?? 0
  const sessionTokens = Math.max(0, slot.tokens_in + slot.tokens_out - base)
  // 复用 estimateCtxUsage 的封顶与除零处理：增量作为 in，out 传 0
  return estimateCtxUsage(sessionTokens, 0, slot.window_tokens)
}

/**
 * 档位 C 判定：会话被复用（非 transient）且当前会话占用达阈值。
 *
 * 2026-08-30 行为变更：原实现要求 `session_tier === 'auto-reset'`，但这个档位在
 * 前端 / routes / pod-tools 都没有设置入口 → 判定恒为假，刹车从未真正装过。
 * 改为「凡复用会话的槽位达阈值即重置」：占用率是运行时事实，不该依赖用户
 * 预先选对一个连入口都不存在的配置项。transient 每次都是新进程，无累积可言。
 */
export function needsAutoReset(slot: Pick<AgentSlot, 'session_tier' | 'ctx_usage_pct'>): boolean {
  return slot.session_tier !== 'transient' && slot.ctx_usage_pct >= CTX_RESET_THRESHOLD_PCT
}

/**
 * 档位 C 重置后的结构化摘要（S5：任务书层只存结构化状态）。
 * 只含该员工已完成任务的事实：标题 / commit / 测试结果，不含原始对话与叙事。
 */
export function buildResetSummary(store: PodStore, missionId: string, slotId: string): string {
  const done = store.listTasks(missionId).filter((t) => t.owner_slot_id === slotId && t.status === 'done')
  const active = store.listTasks(missionId).filter(
    (t) => t.owner_slot_id === slotId && (t.status === 'dispatched' || t.status === 'running'),
  )
  const lines = [
    `# 会话重置摘要（slot ${slotId}，mission ${missionId}）`,
    '',
    `> 本摘要由 Pod 在上下文占用达到 ${CTX_RESET_THRESHOLD_PCT}% 时自动生成；原始对话不入新会话。`,
    '',
    '## 已完成任务',
  ]
  if (done.length === 0) lines.push('（无）')
  for (const task of done) {
    lines.push(`- ${task.id} ${task.title}: commit ${task.commit_sha ?? '(无)'}，状态 ${task.status}`)
  }
  lines.push('', '## 进行中任务')
  if (active.length === 0) lines.push('（无）')
  for (const task of active) {
    lines.push(`- ${task.id} ${task.title}: ${task.status}`)
  }
  lines.push('', '## 继续条件', '继续执行进行中任务；新任务以交接消息为准（指针与意图，磁盘传内容）。')
  return lines.join('\n')
}
