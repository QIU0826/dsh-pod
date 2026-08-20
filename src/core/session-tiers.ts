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
  }
}

/** 上下文占用估算（tokens_in+out / 窗口大小，封顶 100%）。 */
export function estimateCtxUsage(tokensIn: number, tokensOut: number, windowTokens: number): number {
  if (windowTokens <= 0) return 0
  const pct = ((tokensIn + tokensOut) / windowTokens) * 100
  return Math.min(Math.max(pct, 0), 100)
}

/** 档位 C 判定：auto-reset 且占用达阈值。 */
export function needsAutoReset(slot: AgentSlot): boolean {
  return slot.session_tier === 'auto-reset' && slot.ctx_usage_pct >= CTX_RESET_THRESHOLD_PCT
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
