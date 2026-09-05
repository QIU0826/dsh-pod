/**
 * AG-UI 协议映射层测试（后续计划 P3 · AG-UI 参考，2026-09-05）：
 *   - mission 生命周期 → RUN_STARTED / RUN_FINISHED / RUN_ERROR
 *   - worker_progress 文本 chunk → TEXT_MESSAGE START/CONTENT/END 装配（含重放中途补 START）
 *   - tool_call → TOOL_CALL 三元组（先关在途文本）
 *   - 任务生命周期 → STEP_STARTED / STEP_FINISHED
 *   - 无对应语义的事件不产出；flush 冲刷未结束消息
 */
import { describe, expect, it } from 'vitest'
import { createAgUiStreamMapper, formatAgUiSseFrame, type AgUiEvent } from '../src/core/agui.js'
import type { PodEvent } from '../src/core/types.js'

function podEvent(over: Partial<PodEvent> = {}): PodEvent {
  return {
    id: 'ev-1',
    mission_id: 'M-1',
    ts: 1_700_000_000_000,
    kind: 'worker_progress',
    slot_id: 'S-1',
    task_id: 'T-1',
    payload: {},
    ...over,
  }
}

describe('AG-UI mission 生命周期映射', () => {
  it('mission_created → RUN_STARTED；mission_done → RUN_FINISHED', () => {
    const m = createAgUiStreamMapper()
    expect(m.convert(podEvent({ kind: 'mission_created' }))).toEqual([
      { type: 'RUN_STARTED', threadId: 'M-1', runId: 'M-1' },
    ])
    expect(m.convert(podEvent({ kind: 'mission_done' }))).toEqual([
      { type: 'RUN_FINISHED', threadId: 'M-1', runId: 'M-1' },
    ])
  })
  it('mission_run_error / mission_paused_budget → RUN_ERROR（code 带原 kind）', () => {
    const m = createAgUiStreamMapper()
    expect(m.convert(podEvent({ kind: 'mission_run_error', payload: { error: 'boom' } }))).toEqual([
      { type: 'RUN_ERROR', message: 'boom', code: 'mission_run_error' },
    ])
  })
  it('终态前冲刷在途文本：done 事件产出 TEXT_MESSAGE_END + RUN_FINISHED', () => {
    const m = createAgUiStreamMapper()
    m.convert(podEvent({ payload: { reply_id: 'r-1', kind: 'text', text: '第一段' } }))
    const out = m.convert(podEvent({ kind: 'mission_done' }))
    expect(out).toEqual([
      { type: 'TEXT_MESSAGE_END', messageId: 'r-1' },
      { type: 'RUN_FINISHED', threadId: 'M-1', runId: 'M-1' },
    ])
  })
})

describe('AG-UI 文本消息装配（reply_id 粒度）', () => {
  it('chunk 流：首个 chunk 补 START，后续只发 CONTENT，reply 结束事件触发 END', () => {
    const m = createAgUiStreamMapper()
    const out1 = m.convert(podEvent({ payload: { reply_id: 'r-1', kind: 'text', text: '你好' } }))
    expect(out1).toEqual([
      { type: 'TEXT_MESSAGE_START', messageId: 'r-1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'r-1', delta: '你好' },
    ])
    const out2 = m.convert(podEvent({ payload: { reply_id: 'r-1', kind: 'text', text: '世界' } }))
    expect(out2).toEqual([{ type: 'TEXT_MESSAGE_CONTENT', messageId: 'r-1', delta: '世界' }])
  })
  it('工具调用穿插：先关在途文本，再发三元组，后续文本重新 START', () => {
    const m = createAgUiStreamMapper()
    m.convert(podEvent({ payload: { reply_id: 'r-1', kind: 'text', text: '执行命令' } }))
    const out = m.convert(podEvent({ id: 'ev-tool-1', payload: { reply_id: 'r-1', kind: 'tool_call', tool: 'shell', text: 'ls' } }))
    expect(out).toEqual([
      { type: 'TEXT_MESSAGE_END', messageId: 'r-1' },
      { type: 'TOOL_CALL_START', toolCallId: 'r-1:ev-tool-1', toolCallName: 'shell' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'r-1:ev-tool-1', delta: 'ls' },
      { type: 'TOOL_CALL_END', toolCallId: 'r-1:ev-tool-1' },
    ])
    const after = m.convert(podEvent({ payload: { reply_id: 'r-1', kind: 'text', text: '完成' } }))
    expect(after[0]).toEqual({ type: 'TEXT_MESSAGE_START', messageId: 'r-1', role: 'assistant' })
  })
  it('重放中途接入（无 START 历史）：自动补 START 再发 CONTENT', () => {
    const m = createAgUiStreamMapper()
    const out = m.convert(podEvent({ payload: { reply_id: 'r-9', kind: 'text', text: '断线前的内容' } }))
    expect(out).toEqual([
      { type: 'TEXT_MESSAGE_START', messageId: 'r-9', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'r-9', delta: '断线前的内容' },
    ])
  })
  it('非文本/无文本的 progress 不产出', () => {
    const m = createAgUiStreamMapper()
    expect(m.convert(podEvent({ payload: { reply_id: 'r-1', kind: 'system', text: 'x' } }))).toEqual([])
    expect(m.convert(podEvent({ payload: { reply_id: 'r-1', kind: 'text' } }))).toEqual([])
  })
})

describe('AG-UI 任务生命周期与噪音过滤', () => {
  it('task_dispatched → STEP_STARTED；task_done → STEP_FINISHED', () => {
    const m = createAgUiStreamMapper()
    expect(m.convert(podEvent({ kind: 'task_dispatched', task_id: 'T-1' }))).toEqual([{ type: 'STEP_STARTED', stepName: 'T-1' }])
    expect(m.convert(podEvent({ kind: 'task_done', task_id: 'T-1' }))).toEqual([{ type: 'STEP_FINISHED', stepName: 'T-1' }])
  })
  it('账本/审计类事件不产出（映射有损、防污染第三方流）', () => {
    const m = createAgUiStreamMapper()
    expect(m.convert(podEvent({ kind: 'pod_tool_called', payload: {} }))).toEqual([])
    expect(m.convert(podEvent({ kind: 'task_context', payload: {} }))).toEqual([])
  })
  it('flush 冲刷所有未结束消息并清空状态', () => {
    const m = createAgUiStreamMapper()
    m.convert(podEvent({ payload: { reply_id: 'r-1', kind: 'text', text: 'a' } }))
    m.convert(podEvent({ payload: { reply_id: 'r-2', kind: 'text', text: 'b' } }))
    const out = m.flush()
    expect(out).toEqual([
      { type: 'TEXT_MESSAGE_END', messageId: 'r-1' },
      { type: 'TEXT_MESSAGE_END', messageId: 'r-2' },
    ])
    expect(m.flush()).toEqual([])
  })
})

describe('formatAgUiSseFrame', () => {
  it('每事件一个 data: 帧；空数组 → 空串', () => {
    const events: AgUiEvent[] = [
      { type: 'RUN_STARTED', threadId: 'M-1', runId: 'M-1' },
      { type: 'STEP_STARTED', stepName: 'T-1' },
    ]
    const frame = formatAgUiSseFrame(events)
    expect(frame).toContain('data: {"type":"RUN_STARTED"')
    expect(frame.split('data: ').length - 1).toBe(2)
    expect(formatAgUiSseFrame([])).toBe('')
  })
})
