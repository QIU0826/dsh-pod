import { describe, expect, it } from 'vitest'
import {
  handleImRequest,
  ImReplayGuard,
  larkExpectedSignature,
  slackExpectedSignature,
  verifyAndParseIm,
  type ImRequest,
} from '../src/core/channel-im.js'
import type { ChannelTarget } from '../src/core/channel.js'

const NOW = 1_700_000_000_000
const SLACK_SECRET = 'slack-signing-secret'
const LARK_KEY = 'lark-encrypt-key'

function slackReq(body: unknown, over: { ts?: number; secret?: string; signature?: string } = {}): ImRequest {
  const rawBody = JSON.stringify(body)
  const ts = String(over.ts ?? Math.floor(NOW / 1000))
  return {
    vendor: 'slack',
    headers: {
      'x-slack-request-timestamp': ts,
      'x-slack-signature': over.signature ?? slackExpectedSignature(over.secret ?? SLACK_SECRET, ts, rawBody),
    },
    rawBody,
  }
}

function larkReq(body: unknown, over: { ts?: number; nonce?: string; key?: string; signature?: string } = {}): ImRequest {
  const rawBody = JSON.stringify(body)
  const ts = String(over.ts ?? Math.floor(NOW / 1000))
  const nonce = over.nonce ?? 'n1'
  return {
    vendor: 'lark',
    headers: {
      'x-lark-request-timestamp': ts,
      'x-lark-request-nonce': nonce,
      'x-lark-signature': over.signature ?? larkExpectedSignature(over.key ?? LARK_KEY, ts, nonce, rawBody),
    },
    rawBody,
  }
}

function slackMention(text: string): unknown {
  return {
    type: 'event_callback',
    event: { type: 'app_mention', text: `<@U123> ${text}`, user: 'U456', channel: 'C789', ts: '111.222', thread_ts: '111.000' },
  }
}

function larkMessage(text: string): unknown {
  return {
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: 'ou_abc' } },
      message: { message_type: 'text', content: JSON.stringify({ text }), chat_id: 'oc_123', thread_id: 'om_t1' },
    },
  }
}

function fakeTarget(over: Partial<ChannelTarget> = {}): ChannelTarget {
  return {
    status: () => ({ mission: null, pendingApprovalIds: [] }),
    launch: () => ({ mission_id: 'M-1', status: 'planning' }),
    approve: () => ({ ok: true }),
    deny: () => undefined,
    steer: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    abort: () => undefined,
    ...over,
  }
}

describe('Slack adapter（Berd-H）', () => {
  it('签名正确 → 解析出指令文本（去 @提及）与会话定位', () => {
    const r = verifyAndParseIm(slackReq(slackMention('状态')), { slackSigningSecret: SLACK_SECRET, nowMs: NOW })
    expect(r.ok).toBe(true)
    expect(r.inbound?.text).toBe('状态')
    expect(r.inbound?.channelId).toBe('C789')
    expect(r.inbound?.threadId).toBe('111.000')
    expect(r.inbound?.userId).toBe('U456')
  })

  it('签名错误 / 时间窗过期 → fail-closed 拒绝（不降级放行）', () => {
    const bad = verifyAndParseIm(slackReq(slackMention('状态'), { signature: 'v0=deadbeef' }), {
      slackSigningSecret: SLACK_SECRET,
      nowMs: NOW,
    })
    expect(bad.ok).toBe(false)
    expect(bad.reason).toContain('signature')

    const stale = verifyAndParseIm(slackReq(slackMention('状态'), { ts: Math.floor(NOW / 1000) - 3600 }), {
      slackSigningSecret: SLACK_SECRET,
      nowMs: NOW,
    })
    expect(stale.ok).toBe(false)
    expect(stale.reason).toContain('window')
  })

  it('未配置 signing secret → 拒绝（凭据缺失不静默放行）', () => {
    const r = verifyAndParseIm(slackReq(slackMention('状态')), { nowMs: NOW })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('not configured')
  })

  it('url_verification 握手 → 回显 challenge，不进业务逻辑', () => {
    const r = verifyAndParseIm(slackReq({ type: 'url_verification', challenge: 'CH-1' }), {
      slackSigningSecret: SLACK_SECRET,
      nowMs: NOW,
    })
    expect(r.ok).toBe(true)
    expect(r.challenge).toBe('CH-1')
    expect(r.inbound).toBeUndefined()
  })

  it('机器人自身消息 → 忽略（防回环）', () => {
    const r = verifyAndParseIm(
      slackReq({ type: 'event_callback', event: { type: 'message', text: '状态', bot_id: 'B1', channel: 'C1', user: 'U1' } }),
      { slackSigningSecret: SLACK_SECRET, nowMs: NOW },
    )
    expect(r.ok).toBe(true)
    expect(r.inbound).toBeUndefined()
    expect(r.reason).toContain('bot')
  })
})

describe('飞书 adapter（Berd-H）', () => {
  it('schema 2.0 文本消息 → 解析出指令文本（content 是 JSON 字符串）', () => {
    const r = verifyAndParseIm(larkReq(larkMessage('状态')), { larkEncryptKey: LARK_KEY, nowMs: NOW })
    expect(r.ok).toBe(true)
    expect(r.inbound?.text).toBe('状态')
    expect(r.inbound?.channelId).toBe('oc_123')
    expect(r.inbound?.userId).toBe('ou_abc')
  })

  it('签名错误 → 拒绝', () => {
    const r = verifyAndParseIm(larkReq(larkMessage('状态'), { signature: 'bad' }), {
      larkEncryptKey: LARK_KEY,
      nowMs: NOW,
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('signature')
  })

  it('schema 2.0 挑战握手 → 回显 challenge', () => {
    const r = verifyAndParseIm(
      larkReq({ schema: '2.0', header: { event_type: 'url_verification' }, event: { challenge: 'CH-2', token: 't' } }),
      { larkEncryptKey: LARK_KEY, nowMs: NOW },
    )
    expect(r.challenge).toBe('CH-2')
  })

  it('非文本消息 → 忽略（不支持的类型不误判为指令）', () => {
    const r = verifyAndParseIm(
      larkReq({
        schema: '2.0',
        header: { event_type: 'im.message.receive_v1' },
        event: { sender: { sender_id: { open_id: 'ou' } }, message: { message_type: 'image', content: '{}', chat_id: 'oc' } },
      }),
      { larkEncryptKey: LARK_KEY, nowMs: NOW },
    )
    expect(r.inbound).toBeUndefined()
    expect(r.reason).toContain('message type')
  })
})

describe('端到端：入站 → 指令路由 → 出站（审批门不绕过）', () => {
  it('status 指令 → 回复文本经净化后投递', async () => {
    const sent: string[] = []
    const res = await handleImRequest(
      slackReq(slackMention('状态')),
      fakeTarget({ status: () => ({ mission: null, pendingApprovalIds: [] }) }),
      { slackSigningSecret: SLACK_SECRET, nowMs: NOW },
      (out) => { sent.push(out.text) },
    )
    expect(res.handled).toBe(true)
    expect(sent[0]).toContain('无 active mission')
    expect(res.outbound?.channelId).toBe('C789')
    expect(res.outbound?.threadId).toBe('111.000')
  })

  it('approve 指令 → 走 target.approve（pod_approve 门），不直连合并', async () => {
    const calls: string[] = []
    const res = await handleImRequest(
      slackReq(slackMention('批准 A-1')),
      fakeTarget({
        status: () => ({ mission: null, pendingApprovalIds: ['A-1'] }),
        approve: (id) => { calls.push(id); return { ok: true } },
      }),
      { slackSigningSecret: SLACK_SECRET, nowMs: NOW },
    )
    // 解析出的审批 id 形如 A-1（白名单匹配），实际 id 由 channel.ts 的 matchApprovalId 决定
    expect(calls.length).toBe(1)
    expect(res.outbound?.text).toContain('审批卡')
  })

  it('无 sender 时不投递（纯解析模式可用）', async () => {
    const res = await handleImRequest(slackReq(slackMention('状态')), fakeTarget(), {
      slackSigningSecret: SLACK_SECRET,
      nowMs: NOW,
    })
    expect(res.handled).toBe(true)
    expect(res.outbound).toBeDefined()
  })

  it('验签失败 → 不触达 target（fail-closed）', async () => {
    let touched = false
    const res = await handleImRequest(
      slackReq(slackMention('中止'), { signature: 'v0=forged' }),
      fakeTarget({ abort: () => { touched = true } }),
      { slackSigningSecret: SLACK_SECRET, nowMs: NOW },
    )
    expect(res.handled).toBe(false)
    expect(touched).toBe(false)
  })
})

describe('飞书明文模式验签 + 重放去重（审计修复）', () => {
  const TOKEN = 'lark-verification-token'
  const larkPlain = (over: { token?: string; eventId?: string } = {}): ImRequest => ({
    vendor: 'lark',
    headers: {},
    rawBody: JSON.stringify({
      header: { token: over.token ?? TOKEN, event_id: over.eventId, event_type: 'im.message.receive_v1' },
      event: {
        message: { message_type: 'text', chat_id: 'oc1', content: JSON.stringify({ text: '状态' }) },
        sender: { sender_id: { open_id: 'ou_1' } },
      },
    }),
  })

  it('明文模式未配置 verification token → 拒绝（不再不设防）', () => {
    const r = verifyAndParseIm(larkPlain(), { nowMs: NOW })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('not configured')
  })

  it('明文模式 token 缺失/不匹配 → 拒绝；匹配 → 放行', () => {
    expect(verifyAndParseIm(larkPlain({ token: '' }), { larkVerificationToken: TOKEN, nowMs: NOW }).ok).toBe(false)
    const bad = verifyAndParseIm(larkPlain({ token: 'wrong' }), { larkVerificationToken: TOKEN, nowMs: NOW })
    expect(bad.ok).toBe(false)
    expect(bad.reason).toContain('mismatch')
    const good = verifyAndParseIm(larkPlain(), { larkVerificationToken: TOKEN, nowMs: NOW })
    expect(good.ok).toBe(true)
    expect(good.inbound?.text).toBe('状态')
  })

  it('重放去重：同一 event_id 二次投递被拒，不同 id 放行；无 id 事件不受影响', async () => {
    const guard = new ImReplayGuard(10 * 60 * 1000)
    const target = { id: 't', status: () => ({ mission: null }), describe: async () => 'x', steer: async () => {}, approve: async () => ({ ok: true }), deny: async () => {} } as unknown as ChannelTarget
    const sent: unknown[] = []
    const opts = { nowMs: NOW, larkVerificationToken: TOKEN, replayGuard: guard }
    const first = await handleImRequest(larkPlain({ eventId: 'E1' }), target, opts, async (r) => { sent.push(r) })
    const dup = await handleImRequest(larkPlain({ eventId: 'E1' }), target, opts, async () => {})
    expect(first.handled).toBe(true)
    expect(dup.handled).toBe(true)
    expect(dup.reason).toContain('duplicate event')
    expect(sent).toHaveLength(1)
    const other = await handleImRequest(larkPlain({ eventId: 'E2' }), target, opts, async () => {})
    expect(other.reason).toBeUndefined()
  })
})
