/**
 * 事件→消息态重建 —— 方案书 3.3 节不变量 5 / CR-08 AgentScope-D（DoD-19）。
 *
 * worker 进度事件按 slot+reply_id 聚合，可重建员工完整回复（Canvas 重连/复盘不丢上下文）。
 * reply_id = 一次任务派发的完整回复标识（同任务内进度共享）；seq 保序（乱序重放可重排）。
 * 有界预览（3.6-S7）：tool_call 只存工具名 + 输入摘要，不序列化大对象全量进上下文。
 */

import type { PodEvent, WorkerProgressEvent } from './types.js'

/** 聚合段：text 或 tool_call（有界预览）。 */
export interface ReplySegment {
  kind: 'text' | 'tool_call'
  text?: string
  tool?: string
  summary?: string
  seq: number
  ts: number
}

export interface RebuiltReply {
  slot_id: string
  reply_id: string
  task_id: string
  /** 完整回复文本（text 顺序拼接 + [tool] 标记）。 */
  text: string
  segments: ReplySegment[]
}

/** 当前 reply 游标：slot_id → reply_id（同任务共享）。 */
const replyCursor = new Map<string, string>()

/**
 * worker 进度 → PodEvent（带 reply_id/seq 落盘，供聚合重建）。
 * 同 slot 同任务共享 reply_id；新任务重置游标（瞬时/跨任务语义）。
 */
export function emitWorkerProgress(
  progress: WorkerProgressEvent,
  append: (event: PodEvent) => void,
): PodEvent {
  const cursorKey = `${progress.slot_id}:${progress.task_id}`
  let replyId = replyCursor.get(cursorKey)
  if (replyId === undefined) {
    replyId = `reply-${progress.ts}-${progress.slot_id}-${progress.task_id}`
    replyCursor.set(cursorKey, replyId)
  }
  const seq = nextSeq(progress.slot_id)
  const event: PodEvent = {
    id: `ev-progress-${progress.ts}-${seq}`,
    mission_id: '',
    ts: progress.ts,
    kind: 'worker_progress',
    slot_id: progress.slot_id,
    task_id: progress.task_id,
    payload: {
      reply_id: replyId,
      seq,
      kind: progress.kind,
      text: progress.text,
      tool: progress.tool,
      file: progress.file,
      tokens_in: progress.tokens_in,
      tokens_out: progress.tokens_out,
    },
  }
  append(event)
  return event
}

/** 每次派发重置游标（新任务新 reply；任务结束销毁句柄）。 */
export function resetReplyCursor(slotId: string, taskId: string): void {
  replyCursor.delete(`${slotId}:${taskId}`)
}

const seqCounter = new Map<string, number>()

function nextSeq(slotId: string): number {
  const next = (seqCounter.get(slotId) ?? 0) + 1
  seqCounter.set(slotId, next)
  return next
}

/** 按 slot+reply_id 聚合重建员工完整回复（事件乱序时按 seq 重排）。 */
export function aggregateWorkerReply(
  events: PodEvent[],
  slotId: string,
  replyId: string,
): RebuiltReply {
  const mine = events
    .filter((e) => e.kind === 'worker_progress' && e.slot_id === slotId && e.payload.reply_id === replyId)
    .sort((a, b) => (a.payload.seq as number) - (b.payload.seq as number))

  const segments: ReplySegment[] = mine.map((e, index) => {
    const kind = e.payload.kind === 'tool_call' ? 'tool_call' : 'text'
    const segment: ReplySegment = {
      kind,
      seq: (e.payload.seq as number) ?? index,
      ts: e.ts,
    }
    if (kind === 'tool_call') {
      segment.tool = String(e.payload.tool ?? '')
      // 有界预览（S7）：输入摘要截断 120 字符
      segment.summary = String(e.payload.text ?? '').slice(0, 120)
    } else {
      segment.text = String(e.payload.text ?? '')
    }
    return segment
  })

  const text = segments
    .map((s) => (s.kind === 'tool_call' ? `[tool] ${s.tool}${s.summary ? `: ${s.summary}` : ''}` : s.text ?? ''))
    .join('\n')

  return {
    slot_id: slotId,
    reply_id: replyId,
    task_id: String(mine[0]?.task_id ?? ''),
    text,
    segments,
  }
}
