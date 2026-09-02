/**
 * IM vendor adapter（Berd-H 收尾）—— Slack / 飞书（Lark）双向通道。
 *
 * 在 `channel.ts` 的「通道 adapter 框架」之上补上具体 vendor 的三件事：
 *   1. 入站鉴权（vendor 签名校验 + 时间窗防重放）；
 *   2. 入站解析（vendor envelope → 指令文本 + 会话定位 + 挑战握手）；
 *   3. 出站构造（回复体，文本已过净化白名单）。
 *
 * 继承 channel.ts 的 Berd-H 三约束：
 *   - 上下文只进：入站只取指令文本；任务上下文/代码/diff 不回通道；
 *   - 回复复用审批门：approve/deny 仍走 target.approve/deny（pod_approve 是唯一合并入口）；
 *   - 凭据永不出会话：secret/token 只由调用方从环境注入，不落事件流、不进记忆、不写日志；
 *     出站文本一律过 `sanitizeOutboundSignal`（代码/diff/凭据字段被白名单剔除）。
 *
 * fail-closed：验签失败、时间窗过期、缺凭据、解析不出指令 → 一律拒绝，不降级放行。
 * 飞书明文模式（无 encryptKey）必须配置 verification token 做入站鉴权；
 * vendor 重投递按事件 id 去重（ImReplayGuard），非幂等指令不会被二次执行。
 *
 * 纯逻辑 + 注入式副作用（clock 由调用方给），可离线单测；不硬编码任何网络调用。
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import {
  handleChannelCommand,
  parseInstruction,
  sanitizeOutboundSignal,
  type ChannelCommand,
  type ChannelReply,
  type ChannelTarget,
} from './channel.js'

export type ImVendor = 'slack' | 'lark'

/** Slack 签名时间窗（±5 分钟，vendor 官方建议值；超出即判重放）。 */
export const SLACK_TOLERANCE_MS = 5 * 60 * 1000
/** 飞书签名时间窗（vendor 未明确规定，取与 Slack 相同的保守值）。 */
export const LARK_TOLERANCE_MS = 5 * 60 * 1000

/** 入站请求的原始材料（避免本层依赖具体 HTTP 实现）。 */
export interface ImRequest {
  vendor: ImVendor
  headers: Record<string, string | string[] | undefined>
  rawBody: string
}

/** 解析后的入站消息（已通过验签）。 */
export interface ImInbound {
  vendor: ImVendor
  /** 指令文本（已去掉 @机器人 前缀与多余空白）。 */
  text: string
  userId: string
  channelId: string
  /** 线程 / 话题定位（回消息时保持在原会话上下文）。 */
  threadId?: string
}

/** 验签 + 解析结果。challenge 非空表示这是 vendor 的配置握手，不应走业务逻辑。 */
export interface ImVerification {
  ok: boolean
  reason?: string
  inbound?: ImInbound
  challenge?: string
  /** vendor 事件 id（Slack event_id / 飞书 header.event_id），重放去重键；可能缺失。 */
  eventId?: string
}

function extractEventId(vendor: ImVendor, body: Record<string, unknown>): string | undefined {
  if (vendor === 'slack') return typeof body.event_id === 'string' && body.event_id.length > 0 ? body.event_id : undefined
  const header = body.header
  if (header !== null && typeof header === 'object') {
    const eid = (header as Record<string, unknown>).event_id
    if (typeof eid === 'string' && eid.length > 0) return eid
  }
  return undefined
}

/** 取飞书 verification token（v1 顶层 token / schema 2.0 header.token）。 */
function extractLarkToken(body: Record<string, unknown>): string {
  if (typeof body.token === 'string') return body.token
  const header = body.header
  if (header !== null && typeof header === 'object') {
    const t = (header as Record<string, unknown>).token
    if (typeof t === 'string') return t
  }
  return ''
}

/**
 * 重放去重（审计 P2 修复）：vendor 会因超时重投递同一事件（Slack 官方明确会重试），
 * 暂停/恢复/派发这类非幂等指令会被重复执行。按 vendor 事件 id 做有界 TTL 去重，
 * TTL 与签名时间窗同量级——超出窗口的请求本就被验签拒绝，这里只兜窗口内的重放。
 */
export class ImReplayGuard {
  private readonly seen = new Map<string, number>()
  constructor(private readonly ttlMs: number = 10 * 60 * 1000) {}
  /** true = 首次见到（放行）；false = 窗口内的重复投递（拒绝）。 */
  firstSeen(eventId: string, nowMs: number): boolean {
    if (eventId.length === 0) return true
    for (const [k, ts] of this.seen) {
      if (nowMs - ts > this.ttlMs) this.seen.delete(k)
    }
    if (this.seen.has(eventId)) return false
    this.seen.set(eventId, nowMs)
    // 有界：异常洪峰下也不会无界增长
    if (this.seen.size > 10_000) {
      const oldest = [...this.seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, 1_000)
      for (const [k] of oldest) this.seen.delete(k)
    }
    return true
  }
}

/** vendor 凭据（由调用方从环境注入；本模块不读 process.env，便于测试与凭据隔离）。 */
export interface ImCredentials {
  slackSigningSecret?: string
  larkEncryptKey?: string
  /**
   * 飞书 verification token：明文模式（无 encryptKey）时**必配**——此时签名不可校验，
   * token 比对是唯一的入站鉴权手段（审计 P1 修复：此前明文模式完全跳过验签）。
   * 加密模式下作为挑战握手回显用（可选）。
   */
  larkVerificationToken?: string
}

export interface ImOptions extends ImCredentials {
  nowMs: number
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string {
  const raw = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(raw)) return raw[0] ?? ''
  return raw ?? ''
}

/** 恒时字符串比较（长度不等先短路）。 */
function constantEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

function withinWindow(timestamp: string, nowMs: number, toleranceMs: number): boolean {
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || ts <= 0) return false
  // vendor 传的是秒级时间戳，也有实现传毫秒；两者都接受
  const ms = ts < 1e12 ? ts * 1000 : ts
  return Math.abs(nowMs - ms) <= toleranceMs
}

/** Slack 期望签名：`v0=` + HMAC-SHA256(signingSecret, `v0:${ts}:${body}`)。 */
export function slackExpectedSignature(signingSecret: string, timestamp: string, rawBody: string): string {
  return 'v0=' + createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')
}

/**
 * 飞书期望签名（事件订阅）：sha256(timestamp + nonce + encryptKey + body)。
 * 明文模式下 encryptKey 为空串。
 */
export function larkExpectedSignature(encryptKey: string, timestamp: string, nonce: string, rawBody: string): string {
  return createHash('sha256').update(`${timestamp}${nonce}${encryptKey}${rawBody}`).digest('hex')
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 去掉消息里的 @机器人 提及前缀（Slack 形如 `<@U123> 状态`）。 */
function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/gi, ' ').replace(/\s+/g, ' ').trim()
}

function parseSlack(body: Record<string, unknown>): { inbound?: ImInbound; challenge?: string; reason?: string } {
  // 配置握手：Slack 首次订阅 URL 时下发，必须原样回显 challenge
  if (body.type === 'url_verification' && typeof body.challenge === 'string') {
    return { challenge: body.challenge }
  }
  if (body.type !== 'event_callback') return { reason: 'unsupported slack event type' }
  const event = body.event
  if (event === null || typeof event !== 'object') return { reason: 'missing slack event' }
  const e = event as Record<string, unknown>
  // 忽略机器人自身产生的消息，防回环
  if (typeof e.bot_id === 'string' && e.bot_id.length > 0) return { reason: 'ignore bot message' }
  const type = typeof e.type === 'string' ? e.type : ''
  if (type !== 'app_mention' && type !== 'message') return { reason: 'unsupported slack message type' }
  const text = stripMention(typeof e.text === 'string' ? e.text : '')
  if (text.length === 0) return { reason: 'empty instruction text' }
  const channelId = typeof e.channel === 'string' ? e.channel : ''
  if (channelId.length === 0) return { reason: 'missing slack channel' }
  return {
    inbound: {
      vendor: 'slack',
      text,
      userId: typeof e.user === 'string' ? e.user : '',
      channelId,
      ...(typeof e.thread_ts === 'string' ? { threadId: e.thread_ts } : {}),
    },
  }
}

function parseLark(body: Record<string, unknown>): { inbound?: ImInbound; challenge?: string; reason?: string } {
  // 飞书 v1 挑战握手
  if (body.type === 'url_verification' && typeof body.challenge === 'string') {
    return { challenge: body.challenge }
  }
  // 飞书 schema 2.0 挑战握手
  const header = body.header
  const headerType = header !== null && typeof header === 'object'
    ? String((header as Record<string, unknown>).event_type ?? '')
    : ''
  const event = body.event
  const ev = event !== null && typeof event === 'object' ? (event as Record<string, unknown>) : {}
  if (headerType === 'url_verification' && typeof ev.challenge === 'string') {
    return { challenge: ev.challenge }
  }
  if (headerType !== 'im.message.receive_v1') return { reason: 'unsupported lark event type' }
  const message = ev.message
  if (message === null || typeof message !== 'object') return { reason: 'missing lark message' }
  const m = message as Record<string, unknown>
  if (m.message_type !== 'text') return { reason: 'unsupported lark message type' }
  // 飞书文本消息体是 JSON 字符串：{"text":"..."}
  const content = parseJson(typeof m.content === 'string' ? m.content : '')
  const text = stripMention(typeof content.text === 'string' ? content.text : '')
  if (text.length === 0) return { reason: 'empty instruction text' }
  const channelId = typeof m.chat_id === 'string' ? m.chat_id : ''
  if (channelId.length === 0) return { reason: 'missing lark chat id' }
  const sender = ev.sender
  const senderId = sender !== null && typeof sender === 'object'
    ? ((sender as Record<string, unknown>).sender_id as Record<string, unknown> | undefined)
    : undefined
  return {
    inbound: {
      vendor: 'lark',
      text,
      userId: typeof senderId?.open_id === 'string' ? senderId.open_id : '',
      channelId,
      ...(typeof m.thread_id === 'string' ? { threadId: m.thread_id } : {}),
      ...(typeof m.root_id === 'string' ? { threadId: m.root_id } : {}),
    },
  }
}

/** 验签 + 解析（fail-closed：任何一步不通过都返回 ok:false）。 */
export function verifyAndParseIm(req: ImRequest, opts: ImOptions): ImVerification {
  const timestamp = header(req.headers, req.vendor === 'slack' ? 'x-slack-request-timestamp' : 'x-lark-request-timestamp')
  const tolerance = req.vendor === 'slack' ? SLACK_TOLERANCE_MS : LARK_TOLERANCE_MS

  if (req.vendor === 'slack') {
    const secret = opts.slackSigningSecret ?? ''
    if (secret.length === 0) return { ok: false, reason: 'slack signing secret not configured' }
    const signature = header(req.headers, 'x-slack-signature')
    if (signature.length === 0) return { ok: false, reason: 'missing slack signature' }
    if (!withinWindow(timestamp, opts.nowMs, tolerance)) return { ok: false, reason: 'slack timestamp out of window' }
    if (!constantEquals(signature, slackExpectedSignature(secret, timestamp, req.rawBody))) {
      return { ok: false, reason: 'slack signature mismatch' }
    }
    const raw = parseJson(req.rawBody)
    const eventId = extractEventId('slack', raw)
    const parsed = parseSlack(raw)
    if (parsed.challenge !== undefined) return { ok: true, challenge: parsed.challenge, eventId }
    if (parsed.inbound === undefined) return { ok: true, reason: parsed.reason, eventId }
    return { ok: true, inbound: parsed.inbound, eventId }
  }

  const encrypted = (opts.larkEncryptKey ?? '').length > 0
  if (encrypted) {
    const signature = header(req.headers, 'x-lark-signature')
    const nonce = header(req.headers, 'x-lark-request-nonce')
    if (signature.length === 0) return { ok: false, reason: 'missing lark signature' }
    if (!withinWindow(timestamp, opts.nowMs, tolerance)) return { ok: false, reason: 'lark timestamp out of window' }
    const expected = larkExpectedSignature(opts.larkEncryptKey ?? '', timestamp, nonce, req.rawBody)
    if (!constantEquals(signature, expected)) return { ok: false, reason: 'lark signature mismatch' }
  } else {
    // 明文模式（审计 P1 修复）：签名不可校验，verification token 比对是唯一入站鉴权——
    // 未配置 token 或请求不带/不匹配 → 一律拒绝（此前完全跳过验签，等于不设防）
    const configured = opts.larkVerificationToken ?? ''
    if (configured.length === 0) return { ok: false, reason: 'lark verification token not configured (plaintext mode)' }
    // 时间窗防重放（审计修复）：静态 token 不具备新鲜度——历史有效请求体（代理日志/
    // TLS 终结侧泄露）在重放去重 TTL 之外可无限重放非幂等指令；与加密分支同窗校验
    if (!withinWindow(timestamp, opts.nowMs, tolerance)) return { ok: false, reason: 'lark timestamp out of window (plaintext mode)' }
    const raw = parseJson(req.rawBody)
    const presented = extractLarkToken(raw)
    if (presented.length === 0) return { ok: false, reason: 'missing lark verification token' }
    if (!constantEquals(presented, configured)) return { ok: false, reason: 'lark verification token mismatch' }
    const parsed = parseLark(raw)
    if (parsed.challenge !== undefined) return { ok: true, challenge: parsed.challenge, eventId: extractEventId('lark', raw) }
    if (parsed.inbound === undefined) return { ok: true, reason: parsed.reason, eventId: extractEventId('lark', raw) }
    return { ok: true, inbound: parsed.inbound, eventId: extractEventId('lark', raw) }
  }

  const parsed = parseLark(parseJson(req.rawBody))
  if (parsed.challenge !== undefined) return { ok: true, challenge: parsed.challenge, eventId: extractEventId('lark', parseJson(req.rawBody)) }
  if (parsed.inbound === undefined) return { ok: true, reason: parsed.reason, eventId: extractEventId('lark', parseJson(req.rawBody)) }
  return { ok: true, inbound: parsed.inbound, eventId: extractEventId('lark', parseJson(req.rawBody)) }
}

/** 出站回复体（vendor 无关的中间表示，由 sender 转成具体 API 调用）。 */
export interface ImOutbound {
  vendor: ImVendor
  channelId: string
  threadId?: string
  text: string
}

/** 出站投递函数（由调用方实现真实 HTTP；本模块不内置网络调用）。 */
export type ImSender = (reply: ImOutbound) => Promise<void> | void

/** 把通道回复转成出站体；文本过净化白名单（代码/diff/凭据字段被剔除）。 */
export function buildImOutbound(inbound: ImInbound, reply: ChannelReply): ImOutbound {
  const cleaned = sanitizeOutboundSignal({ kind: 'channel_reply', detail: reply.text })
  const text = typeof cleaned.detail === 'string' ? cleaned.detail : reply.text
  return {
    vendor: inbound.vendor,
    channelId: inbound.channelId,
    ...(inbound.threadId !== undefined ? { threadId: inbound.threadId } : {}),
    text,
  }
}

export interface ImHandleResult {
  /** 是否已处理（挑战握手 / 忽略的消息也视为已处理）。 */
  handled: boolean
  challenge?: string
  outbound?: ImOutbound
  reason?: string
}

/**
 * 完整处理一条入站请求：验签 → 解析 → 指令路由 → 出站。
 *
 * 指令路由复用 `channel.ts`：合并/派发等需裁决的动作仍走 target 的审批门，
 * 通道只承载「指令进、摘要出」，不获得绕过状态机的能力。
 */
export async function handleImRequest(
  req: ImRequest,
  target: ChannelTarget,
  opts: ImOptions & { replayGuard?: ImReplayGuard },
  send?: ImSender,
): Promise<ImHandleResult> {
  const verified = verifyAndParseIm(req, opts)
  if (!verified.ok) return { handled: false, reason: verified.reason }
  if (verified.challenge !== undefined) return { handled: true, challenge: verified.challenge }

  // 重放去重（审计 P2 修复）：vendor 超时重投递同一事件 → 二次执行非幂等指令
  if (verified.inbound !== undefined && opts.replayGuard !== undefined && verified.eventId !== undefined) {
    if (!opts.replayGuard.firstSeen(verified.eventId, opts.nowMs)) {
      return { handled: true, reason: `duplicate event (replay): ${verified.eventId}` }
    }
  }

  const inbound = verified.inbound
  if (inbound === undefined) return { handled: true, reason: verified.reason ?? 'no instruction' }

  const cmd: ChannelCommand = parseInstruction(inbound.text)
  if (cmd.kind === 'unknown') {
    const outbound = buildImOutbound(inbound, { ok: false, text: '无法识别的指令：' + inbound.text.slice(0, 80) })
    if (send !== undefined) await send(outbound)
    return { handled: true, outbound, reason: 'unknown instruction' }
  }

  const reply = await handleChannelCommand(target, cmd)
  const outbound = buildImOutbound(inbound, reply)
  if (send !== undefined) await send(outbound)
  return { handled: true, outbound }
}
