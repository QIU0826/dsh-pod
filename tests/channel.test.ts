/**
 * channel（外部协作通道 Berd-H）—— v0.3：指令解析、审批门复用、出站净化。
 */
import { describe, expect, it, vi } from 'vitest'
import { parseInstruction, handleChannelCommand, sanitizeOutboundSignal, type ChannelTarget } from '../src/core/channel.js'

function target(): ChannelTarget {
  return {
    status: () => ({ mission: { id: 'M-1' } as never, pendingApprovalIds: ['A-1'] }),
    launch: vi.fn(() => ({ mission_id: 'M-2', status: 'running' })),
    approve: vi.fn(() => ({ ok: true })),
    deny: vi.fn(),
    steer: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    abort: vi.fn(),
  }
}

describe('parseInstruction（入站指令白名单解析）', () => {
  it('状态/暂停/恢复/中止 关键词', () => {
    expect(parseInstruction('看板状态如何')).toMatchObject({ kind: 'status' })
    expect(parseInstruction('暂停')).toMatchObject({ kind: 'pause' })
    expect(parseInstruction('恢复')).toMatchObject({ kind: 'resume' })
    expect(parseInstruction('中止吧')).toMatchObject({ kind: 'abort' })
  })
  it('approve/deny 提取审批卡 id', () => {
    expect(parseInstruction('批准 A-1 合并')).toMatchObject({ kind: 'approve', approval_id: 'A-1' })
    expect(parseInstruction('驳回 A-7，理由不充分')).toMatchObject({ kind: 'deny', approval_id: 'A-7' })
  })
  it('steer 提取员工 id 与指令内容', () => {
    const cmd = parseInstruction('给 S-1 指令：加一层缓存')
    expect(cmd.kind).toBe('steer')
    if (cmd.kind === 'steer') {
      expect(cmd.slot_id).toBe('S-1')
      expect(cmd.instruction).toContain('缓存')
    }
  })
  it('未知指令 -> unknown', () => {
    expect(parseInstruction('今天天气')).toMatchObject({ kind: 'unknown' })
  })
})

describe('handleChannelCommand（动作执行，审批不绕过门）', () => {
  it('status：返回 mission 摘要', async () => {
    const r = await handleChannelCommand(target(), { kind: 'status' })
    expect(r.ok).toBe(true)
    expect(r.text).toContain('M-1')
  })
  it('approve：走 target.approve（pod_approve 唯一入口），如实回结果', async () => {
    const t = target()
    const ok = await handleChannelCommand(t, { kind: 'approve', approval_id: 'A-1', note: 'ok' })
    expect(t.approve).toHaveBeenCalledWith('A-1', 'ok')
    expect(ok.ok).toBe(true)
    const failT = target()
    ;(failT.approve as ReturnType<typeof vi.fn>).mockReturnValue({ ok: false, message: '卡不存在' })
    const fail = await handleChannelCommand(failT, { kind: 'approve', approval_id: 'A-9' })
    expect(fail.ok).toBe(false)
    expect(fail.text).toContain('卡不存在')
  })
  it('deny / steer / pause / abort 透传', async () => {
    const t = target()
    await handleChannelCommand(t, { kind: 'deny', approval_id: 'A-1', reason: 'r' })
    expect(t.deny).toHaveBeenCalledWith('A-1', 'r')
    await handleChannelCommand(t, { kind: 'steer', slot_id: 'S-1', instruction: 'i' })
    expect(t.steer).toHaveBeenCalledWith('S-1', 'i')
    await handleChannelCommand(t, { kind: 'pause' })
    expect(t.pause).toHaveBeenCalled()
    await handleChannelCommand(t, { kind: 'abort' })
    expect(t.abort).toHaveBeenCalled()
  })
})

describe('sanitizeOutboundSignal（出站净化：白名单字段）', () => {
  it('只保留白名单字段，剥离代码/diff/凭据', () => {
    const out = sanitizeOutboundSignal({
      kind: 'approval_pending', mission_id: 'M-1', approval_id: 'A-1', detail: '待审批',
      diff: '--- a/x +++ b/x', token: 'secret', api_key: 'k',
    })
    expect(out.kind).toBe('approval_pending')
    expect(out.diff).toBeUndefined()
    expect(out.token).toBeUndefined()
    expect(out.api_key).toBeUndefined()
  })
})
