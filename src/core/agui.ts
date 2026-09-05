/**
 * AG-UI 协议映射层（后续计划 P3 · AG-UI 参考，2026-09-05 落地）。
 *
 * 项目的 SSE 帧（{kind, payload}）与 AG-UI 事件模型同构（调研 2026-08-29 §3.3 的判断）：
 * 第三方前端（AG-UI 生态客户端）接入时无需改前端事件源，经本映射层转换即可。
 *
 * 设计（与 A2A 对齐切片同口径：如实映射，不虚标）：
 *   - 有状态流转换器：worker_progress 的文本 chunk 按 reply_id 装配成
 *     TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT* → TEXT_MESSAGE_END（AG-UI 的
 *     增量文本语义）；tool_call 映射 TOOL_CALL_START/ARGS/END 三元组；
 *   - mission 生命周期映射 RUN_STARTED / RUN_FINISHED / RUN_ERROR；
 *   - 任务生命周期映射 STEP_STARTED / STEP_FINISHED；
 *   - 无对应语义的事件（如账本/审计类）→ 不产出（映射是有损的、方向是 Pod → AG-UI）；
 *   - 断线重连从缓冲重放时，先到的文本 chunk 会自动补 START（消息态自愈）。
 */

import type { PodEvent } from './types.js'

/** AG-UI 事件（v1 协议子集：本项目事件流可如实表达的形态）。 */
export type AgUiEvent =
  | { type: 'RUN_STARTED'; threadId: string; runId: string }
  | { type: 'RUN_FINISHED'; threadId: string; runId: string }
  | { type: 'RUN_ERROR'; message: string; code?: string }
  | { type: 'STEP_STARTED'; stepName: string }
  | { type: 'STEP_FINISHED'; stepName: string }
  | { type: 'TEXT_MESSAGE_START'; messageId: string; role: 'assistant' }
  | { type: 'TEXT_MESSAGE_CONTENT'; messageId: string; delta: string }
  | { type: 'TEXT_MESSAGE_END'; messageId: string }
  | { type: 'TOOL_CALL_START'; toolCallId: string; toolCallName: string }
  | { type: 'TOOL_CALL_ARGS'; toolCallId: string; delta: string }
  | { type: 'TOOL_CALL_END'; toolCallId: string }
  | { type: 'CUSTOM'; name: string; value: Record<string, unknown> }

export interface AgUiStreamMapper {
  /** 单事件 → 0..n 个 AG-UI 事件（顺序即发出顺序）。 */
  convert(event: PodEvent): AgUiEvent[]
  /** 连接关闭时调用：冲刷所有未结束的文本消息（TEXT_MESSAGE_END）。 */
  flush(): AgUiEvent[]
}


/** worker_progress 的 payload 文本/工具形态。 */
interface ProgressPayload {
  reply_id?: unknown
  kind?: unknown
  text?: unknown
  tool?: unknown
}

export function createAgUiStreamMapper(): AgUiStreamMapper {
  /** 已发出 START 未发出 END 的文本消息（reply_id → messageId）。 */
  const openMessages = new Map<string, string>()

  function closeOpen(messageId: string): AgUiEvent {
    openMessages.delete(messageId)
    return { type: 'TEXT_MESSAGE_END', messageId }
  }

  return {
    convert(event: PodEvent): AgUiEvent[] {
      const out: AgUiEvent[] = []
      const threadId = event.mission_id
      switch (event.kind) {
        case 'mission_created': {
          out.push({ type: 'RUN_STARTED', threadId, runId: threadId })
          break
        }
        case 'mission_done': {
          out.push(...drainAll(openMessages, closeOpen))
          out.push({ type: 'RUN_FINISHED', threadId, runId: threadId })
          break
        }
        case 'mission_aborted':
        case 'mission_denied': {
          out.push(...drainAll(openMessages, closeOpen))
          out.push({ type: 'RUN_FINISHED', threadId, runId: threadId })
          break
        }
        case 'mission_run_error':
        case 'mission_paused_budget': {
          const message = typeof event.payload.error === 'string' ? event.payload.error : event.kind
          out.push({ type: 'RUN_ERROR', message, code: event.kind })
          break
        }
        case 'task_dispatched': {
          out.push({ type: 'STEP_STARTED', stepName: event.task_id ?? event.id })
          break
        }
        case 'task_done':
        case 'task_blocked':
        case 'task_escalated':
        case 'task_rejected': {
          if (event.task_id !== undefined) out.push({ type: 'STEP_FINISHED', stepName: event.task_id })
          break
        }
        case 'worker_progress': {
          const payload = event.payload as ProgressPayload
          const replyId = typeof payload.reply_id === 'string' && payload.reply_id.length > 0 ? payload.reply_id : `${event.slot_id ?? 'unknown'}:${event.task_id ?? 'unknown'}`
          if (payload.kind === 'tool_call') {
            // 工具调用三元组：先关掉在途文本消息（AG-UI 要求消息内不穿插工具调用）
            if (openMessages.has(replyId)) out.push(closeOpen(replyId))
            const toolId = `${replyId}:${event.id}`
            out.push({ type: 'TOOL_CALL_START', toolCallId: toolId, toolCallName: typeof payload.tool === 'string' && payload.tool.length > 0 ? payload.tool : 'tool' })
            out.push({ type: 'TOOL_CALL_ARGS', toolCallId: toolId, delta: typeof payload.text === 'string' ? payload.text : '' })
            out.push({ type: 'TOOL_CALL_END', toolCallId: toolId })
            break
          }
          if (payload.kind === 'text' && typeof payload.text === 'string' && payload.text.length > 0) {
            if (!openMessages.has(replyId)) {
              // 重放中途接入：先补 START（消息态自愈）
              openMessages.set(replyId, replyId)
              out.push({ type: 'TEXT_MESSAGE_START', messageId: replyId, role: 'assistant' })
            }
            out.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: replyId, delta: payload.text })
          }
          break
        }
        default: {
          // 账本/审计/审批等无 AG-UI 对应语义 → 不产出（CUSTOM 噪音会污染第三方前端流）
          break
        }
      }
      return out
    },
    flush(): AgUiEvent[] {
      return drainAll(openMessages, closeOpen)
    },
  }
}

function drainAll(
  openMessages: Map<string, string>,
  closeOpen: (messageId: string) => AgUiEvent,
): AgUiEvent[] {
  const out: AgUiEvent[] = []
  for (const messageId of [...openMessages.keys()]) out.push(closeOpen(messageId))
  return out
}

/** 便捷封装：SSE 帧文本（`data: {json}\n\n`）。 */
export function formatAgUiSseFrame(events: AgUiEvent[]): string {
  if (events.length === 0) return ''
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
}
