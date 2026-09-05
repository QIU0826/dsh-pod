/**
 * 外部协作通道（Berd-H / AgentScope-J）—— v0.3 实现切片（docs/external-channels.md）。
 *
 * 设计约束落地：
 *   - 上下文只进：入站只接收指令文本（映射到 pod_* 工具面），任务上下文/代码/diff 不回通道；
 *   - 回复复用 pod_approve 门：需人工裁决的动作（合并/派发）不绕过状态机，仍走 service.approve；
 *   - 凭据永不出会话：通道不采集/不透传任何凭据，出站仅白名单信号；
 *   - 外部入口默认关闭，显式启用才开放（Berd-H 纪律）。
 *
 * 本模块是「通道 adapter 框架」：InstructionRouter 解析指令文本 -> ChannelCommand；
 * channelHandler 执行并返回净化后的回复。具体交付通道（IM/Slack/webhook）由脚本层接。
 */

import type { Mission } from './types.js'

/** 一条入站指令解析结果（白名单动作，其余 -> unknown）。 */
export type ChannelCommand =
  | { kind: 'status' }
  | { kind: 'launch'; name: string; goal: string; cwd: string; budgetUsd?: number; slots?: { id: string; vendor: 'claude' | 'codex' | 'dsh' | 'ark' | 'opencode'; role: string; capabilities: string[] }[] }
  | { kind: 'approve'; approval_id: string; note?: string }
  | { kind: 'deny'; approval_id: string; reason: string }
  | { kind: 'steer'; slot_id: string; instruction: string }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'abort'; reason?: string }
  | { kind: 'unknown'; text: string }

/** 通道可触达的 Pod 操作面（对齐 pod_* 工具，等价 mcp-server 的薄壳面）。 */
export interface ChannelTarget {
  status(): { mission: Mission | null; pendingApprovalIds: string[] }
  launch(input: {
    name: string; goal: string; cwd: string; budgetUsd?: number
    slots?: { id: string; vendor: 'claude' | 'codex' | 'dsh' | 'ark' | 'opencode'; role: string; capabilities: string[] }[]
  }): Promise<{ mission_id: string; status: string }> | { mission_id: string; status: string }
  approve(approval_id: string, note?: string): Promise<{ ok: boolean; message?: string }> | { ok: boolean; message?: string }
  deny(approval_id: string, reason: string): Promise<unknown> | unknown
  steer(slot_id: string, instruction: string): void
  pause(): void
  resume(): void
  abort(reason: string): void
}

export interface ChannelReply {
  ok: boolean
  /** 净化后的回复文本（不含代码/diff/凭据，只回通道可读摘要）。 */
  text: string
  /** 该动作是否触发了审批门（需用户在通道外/内走 pod_approve 入口）。 */
  gated?: boolean
}

/** 白名单：可识别的动作关键词（中文/英文）。 */
const KEYWORDS: Record<Exclude<ChannelCommand['kind'], 'unknown'>, string[]> = {
  status: ['状态', '看板', '进度', 'status'],
  launch: ['启动', '发起', '组队', 'launch'],
  approve: ['批准', '同意', '合并', 'approve'],
  deny: ['驳回', '拒绝', 'deny'],
  steer: ['指令', '指挥', 'steer'],
  pause: ['暂停', 'pause'],
  resume: ['恢复', 'resume'],
  abort: ['中止', '终止', 'abort'],
}

/** 把一条入站指令文本解析为 ChannelCommand（简单鲁棒的关键词匹配；未知 -> unknown）。 */
export function parseInstruction(text: string): ChannelCommand {
  const lower = (text ?? '').toLowerCase()

  if (KEYWORDS.approve.some((k) => lower.includes(k.toLowerCase()))) {
    const id = matchApprovalId(lower) ?? ''
    const note = text.length > 0 ? text.trim() : undefined
    return id ? { kind: 'approve', approval_id: id, note } : { kind: 'unknown', text }
  }
  if (KEYWORDS.deny.some((k) => lower.includes(k.toLowerCase()))) {
    const id = matchApprovalId(lower) ?? ''
    return id ? { kind: 'deny', approval_id: id, reason: text.trim() } : { kind: 'unknown', text }
  }
  if (KEYWORDS.steer.some((k) => lower.includes(k.toLowerCase()))) {
    const slot = matchSlotId(lower)
    const instr = stripKeyword(text, KEYWORDS.steer)
    return slot ? { kind: 'steer', slot_id: slot, instruction: instr } : { kind: 'unknown', text }
  }
  if (KEYWORDS.status.some((k) => lower.includes(k.toLowerCase()))) return { kind: 'status' }
  if (KEYWORDS.pause.some((k) => lower.includes(k.toLowerCase()))) return { kind: 'pause' }
  if (KEYWORDS.resume.some((k) => lower.includes(k.toLowerCase()))) return { kind: 'resume' }
  if (KEYWORDS.abort.some((k) => lower.includes(k.toLowerCase()))) return { kind: 'abort', reason: text.trim() }
  if (KEYWORDS.launch.some((k) => lower.includes(k.toLowerCase()))) {
    const name = text.trim()
    return { kind: 'launch', name: name.slice(0, 120), goal: name, cwd: '' }
  }

  return { kind: 'unknown', text }
}

function matchApprovalId(lower: string): string | undefined {
  // 完整 id（2026-09-05 修复）：生产审批 id 是 A-<clock毫秒>-<随机数>（approvals.ts idFn），
  // 旧 /a-\d+/ 在第一个连字符截断——IM 里回复「批准 A-1735680000000-123456」永远
  // approval not found（审批链路对生产 id 形同虚设）。可选第二段兼容旧短 id A-1。
  const m = lower.match(/a-\d+(?:-\d+)?/)
  return m ? m[0].toUpperCase() : undefined
}
function matchSlotId(lower: string): string | undefined {
  const m = lower.match(/s-\d+/)
  return m ? m[0].toUpperCase() : undefined
}
/** 去掉动作关键词，保留剩余指令文本。 */
function stripKeyword(text: string, kw: string[]): string {
  let out = text
  for (const k of kw) {
    const i = out.toLowerCase().indexOf(k.toLowerCase())
    if (i >= 0) out = out.slice(0, i) + ' ' + out.slice(i + k.length)
  }
  return out.trim()
}

export interface ChannelHandlerOptions {
  /** 入站认证已通过（调用方负责通道自身鉴权）。 */
  route(target: ChannelTarget, cmd: ChannelCommand): Promise<ChannelReply>
}

/** 执行一个指令并返回净化回复。合并仍只走 target.approve（pod_approve 门，不绕过）。 */
export async function handleChannelCommand(target: ChannelTarget, cmd: ChannelCommand): Promise<ChannelReply> {
  switch (cmd.kind) {
    case 'status': {
      const s = target.status()
      const mission = s.mission
      if (mission === null) return { ok: true, text: '（当前无 active mission）' }
      const ids = s.pendingApprovalIds.length > 0 ? '；待审批卡: ' + s.pendingApprovalIds.join(',') : ''
      return { ok: true, text: 'mission ' + mission.id + ' ' + mission.status + ids }
    }
    case 'approve': {
      const r = await target.approve(cmd.approval_id, cmd.note)
      // 回复复用审批门：无论成败都如实回，绝不编造合并成功
      if (!r.ok) return { ok: false, text: '审批未通过: ' + (r.message ?? 'unknown') }
      return { ok: true, text: '审批卡 ' + cmd.approval_id + ' 已通过（合并走 pod_approve 唯一入口）' }
    }
    case 'deny': {
      await target.deny(cmd.approval_id, cmd.reason)
      return { ok: true, text: '审批卡 ' + cmd.approval_id + ' 已驳回' }
    }
    case 'steer': {
      target.steer(cmd.slot_id, cmd.instruction)
      return { ok: true, text: '已向员工 ' + cmd.slot_id + ' 排队指令' }
    }
    case 'pause': { target.pause(); return { ok: true, text: 'mission 已暂停' } }
    case 'resume': { target.resume(); return { ok: true, text: 'mission 已恢复' } }
    case 'abort': { target.abort(cmd.reason ?? 'aborted via channel'); return { ok: true, text: 'mission 已中止' } }
    case 'launch': {
      if (cmd.cwd === '') return { ok: false, text: 'launch 需提供工作目录（cwd）' }
      const r = await target.launch(cmd)
      return { ok: true, text: '已发起 mission ' + r.mission_id + ' (' + r.status + ')' }
    }
    case 'unknown':
      return { ok: false, text: '无法识别的指令：' + cmd.text.slice(0, 80) }
  }
}

/** 出站通知净化（Berd-H：只放白名单信号字段，杜绝代码/diff/凭据出会话）。 */
export function sanitizeOutboundSignal(signal: Record<string, unknown>): Record<string, unknown> {
  const ALLOW = new Set(['kind', 'mission_id', 'title', 'detail', 'task_id', 'slot_id', 'status', 'approval_id'])
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(signal)) {
    if (ALLOW.has(key)) out[key] = value
  }
  return out
}
