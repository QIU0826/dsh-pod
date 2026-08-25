import { describe, expect, it } from 'vitest'
import {
  aggregateWorkerReply,
  emitWorkerProgress,
  type ReplySegment,
} from '../src/core/events.js'
import type { PodEvent, WorkerProgressEvent } from '../src/core/types.js'

/**
 * AgentScope-D / DoD-19：事件→消息态重建。
 * worker 进度事件按 slot+reply_id 聚合，Canvas 重连/复盘可重建员工完整回复。
 */

function progress(over: Partial<WorkerProgressEvent> = {}): WorkerProgressEvent {
  return {
    slot_id: 'S-1',
    task_id: 'T-1',
    ts: 1_700_000_000_000,
    kind: 'text',
    text: 'hello',
    ...over,
  }
}

describe('emitWorkerProgress（进度事件带 reply_id 落盘）', () => {
  it('同一任务连续进度共享 reply_id；新任务新 reply_id', () => {
    const events: PodEvent[] = []
    emitWorkerProgress(progress({ task_id: 'T-1', kind: 'text', text: 'a' }), (e) => events.push(e))
    emitWorkerProgress(progress({ task_id: 'T-1', kind: 'text', text: 'b' }), (e) => events.push(e))
    emitWorkerProgress(progress({ task_id: 'T-2', kind: 'tool_call', tool: 'Read' }), (e) => events.push(e))
    const r1 = new Set(events.filter((e) => e.task_id === 'T-1').map((e) => e.payload.reply_id as string))
    const r2 = new Set(events.filter((e) => e.task_id === 'T-2').map((e) => e.payload.reply_id as string))
    expect(r1.size).toBe(1) // T-1 两次进度同一 reply
    expect(r2.size).toBe(1)
    expect([...r1][0]).not.toBe([...r2][0])
    // 事件按序带 seq
    expect((events[0]!.payload.seq as number) < (events[1]!.payload.seq as number)).toBe(true)
  })
})

describe('aggregateWorkerReply（按 slot+reply_id 重建完整回复）', () => {
  it('重建 = 原始文本顺序拼接（text + tool_call 标记）', () => {
    const events: PodEvent[] = []
    emitWorkerProgress(progress({ kind: 'text', text: '第一段' }), (e) => events.push(e))
    emitWorkerProgress(progress({ kind: 'tool_call', tool: 'Read' }), (e) => events.push(e))
    emitWorkerProgress(progress({ kind: 'text', text: '第二段' }), (e) => events.push(e))
    const replyId = events[0]!.payload.reply_id as string
    const rebuilt = aggregateWorkerReply(events, 'S-1', replyId)
    expect(rebuilt.text).toContain('第一段')
    expect(rebuilt.text).toContain('第二段')
    expect(rebuilt.text).toContain('[tool] Read')
    expect(rebuilt.segments.length).toBe(3)
  })

  it('tool_call 携带工具名与输入摘要（有界预览，S7）', () => {
    const events: PodEvent[] = []
    emitWorkerProgress(progress({ kind: 'tool_call', tool: 'Bash', text: 'npm test' }), (e) => events.push(e))
    const replyId = events[0]!.payload.reply_id as string
    const rebuilt = aggregateWorkerReply(events, 'S-1', replyId)
    const toolSegment = rebuilt.segments.find((s: ReplySegment) => s.kind === 'tool_call')
    expect(toolSegment?.tool).toBe('Bash')
    expect(toolSegment?.summary).toBe('npm test')
  })

  it('跨槽位隔离：只聚合目标 slot 的事件', () => {
    const events: PodEvent[] = []
    emitWorkerProgress(progress({ slot_id: 'S-1', kind: 'text', text: 'S1 内容' }), (e) => events.push(e))
    emitWorkerProgress(progress({ slot_id: 'S-2', kind: 'text', text: 'S2 内容' }), (e) => events.push(e))
    const s2ReplyId = events[1]!.payload.reply_id as string
    const rebuilt = aggregateWorkerReply(events, 'S-2', s2ReplyId)
    expect(rebuilt.text).toContain('S2 内容')
    expect(rebuilt.text).not.toContain('S1 内容')
  })

  it('事件乱序时按 seq 重排重建（replay 不丢上下文）', () => {
    const events: PodEvent[] = []
    emitWorkerProgress(progress({ kind: 'text', text: '第一' }), (e) => events.push(e))
    emitWorkerProgress(progress({ kind: 'text', text: '第二' }), (e) => events.push(e))
    emitWorkerProgress(progress({ kind: 'text', text: '第三' }), (e) => events.push(e))
    const replyId = events[0]!.payload.reply_id as string
    const shuffled = [events[2]!, events[0]!, events[1]!]
    const rebuilt = aggregateWorkerReply(shuffled, 'S-1', replyId)
    expect(rebuilt.text.indexOf('第一')).toBeLessThan(rebuilt.text.indexOf('第二'))
    expect(rebuilt.text.indexOf('第二')).toBeLessThan(rebuilt.text.indexOf('第三'))
  })
})
