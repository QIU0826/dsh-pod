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
import { CONTENT_DENSITY_REVIEW, CTX_RESET_REVIEW_THRESHOLD_PCT, CTX_RESET_THRESHOLD_PCT } from './types.js'

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
/**
 * P1-2 第二维：内容相似密度决定使用哪个阈值。
 * Context Rot 论点——diff 密集（相似干扰项高）的内容让模型提前退化，70% 是容量视角不是
 * 质量视角；review 场景（diff 注入占比高）应在 50% 即动作。返回该 slot 应触发的阈值。
 */
export function resetThresholdFor(slot: Pick<AgentSlot, 'content_density_pct'>): number {
  const density = slot.content_density_pct ?? 0
  return density >= CONTENT_DENSITY_REVIEW ? CTX_RESET_REVIEW_THRESHOLD_PCT : CTX_RESET_THRESHOLD_PCT
}

export function needsAutoReset(
  slot: Pick<AgentSlot, 'session_tier' | 'ctx_usage_pct' | 'content_density_pct'>,
): boolean {
  if (slot.session_tier === 'transient') return false
  const threshold = resetThresholdFor(slot)
  return slot.ctx_usage_pct >= threshold
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

/**
 * P1-3 重置后 verbatim 近期窗口（调研 §2.3，CaT 三层高保真短期交互）。
 * 重置摘要只给结构化事实（S5），但进行中任务的最近原始事件（steer 指令 / 工具结果 /
 * task_question 问答）可能在重置瞬间丢失 → 「重置后断片」。这里把该员工当前在途任务
 * 最近 N 条原始事件逐字注入，任务结束即清空（按 task_id 过滤，不跨任务不叙事，不违 S5）。
 */
export const RECENT_WINDOW_SIZE = 3

export function buildRecentWindow(store: PodStore, missionId: string, slotId: string, taskId: string): string {
  const events = store.listEvents(missionId).filter((e) =>
    e.slot_id === slotId && e.task_id === taskId &&
    (e.kind === 'worker_progress' || e.kind === 'steer_queued' || e.kind === 'task_question' || e.kind === 'agent_relay'),
  )
  const recent = events.slice(-RECENT_WINDOW_SIZE)
  if (recent.length === 0) return ''
  const lines: string[] = ['## 近期窗口（在途任务最近原始事件，逐字）', '']
  for (const e of recent) {
    const p = e.payload
    let body = ''
    if (e.kind === 'worker_progress') {
      const sub = typeof p.kind === 'string' ? p.kind : 'text'
      body = typeof p.text === 'string' ? p.text : (typeof p.tool === 'string' ? p.tool : (typeof p.file === 'string' ? p.file : ''))
      if (sub !== 'text') body = `[${sub}] ${body}`
    } else if (e.kind === 'steer_queued') {
      body = `[steer] ${typeof p.instruction === 'string' ? p.instruction : ''}`
    } else if (e.kind === 'task_question') {
      body = `[问答] ${typeof p.question === 'string' ? p.question : JSON.stringify(p)}`
    } else if (e.kind === 'agent_relay') {
      body = `[relay] ${typeof p.note === 'string' ? p.note : ''}`
    }
    if (body.length > 0) lines.push(`- ${body.slice(0, 300)}`)
  }
  return lines.length > 2 ? lines.join('\n') : ''
}
