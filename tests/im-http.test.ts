/**
 * im-http（channel-im 服务面接线）—— 审计 P2「channel-im 服务面零集成」闭环。
 *
 * 此前 scripts/channel-http-server.mjs 只接通用 channel.ts（裸 {text}，无 vendor 验签 /
 * 重放去重 / 挑战握手）。本测试锁定新交付层 src/im-http.ts 的安全不变量：
 *   - vendor 签名是主鉴权（Slack HMAC-SHA256 / 飞书 sha256），验签失败一律 401 fail-closed；
 *   - 挑战握手原样回显 challenge；事件 id 重放去重；
 *   - 指令路由仍走 channelTarget（pod_approve 门不绕过）；
 *   - 出站凭据不出会话；无 send 配置时只 ack；
 *   - 库层 fail-closed：非 loopback 无 token 拒绝启动。
 */
import { describe, expect, it, vi } from 'vitest'
import { listenImHttp } from '../src/im-http.js'
import { slackExpectedSignature, larkExpectedSignature } from '../src/core/channel-im.js'
import type { PodService } from '../src/pod-service.js'
import type { ChannelTarget } from '../src/core/channel.js'

const NOW = 1_700_000_000_000
const SLACK_SECRET = 'slack-signing-secret'
const LARK_KEY = 'lark-encrypt-key'

function fakeTarget(): ChannelTarget {
  return {
    status: vi.fn(() => ({ mission: null, pendingApprovalIds: [] })),
    launch: vi.fn(() => ({ mission_id: 'M-1', status: 'planning' })),
    approve: vi.fn(async () => ({ ok: true })),
    deny: vi.fn(async () => undefined),
    steer: vi.fn(() => undefined),
    pause: vi.fn(() => undefined),
    resume: vi.fn(() => undefined),
    abort: vi.fn(() => undefined),
  }
}

function fakeService() {
  const target = fakeTarget()
  return {
    channelTarget: vi.fn((_source: string) => target),
    target,
  } as unknown as PodService & { target: ChannelTarget }
}

const slackMention = (text: string): unknown => ({
  type: 'event_callback',
  event: { type: 'app_mention', text: `<@U123> ${text}`, user: 'U456', channel: 'C789', ts: '111.222' },
})

const slackChallenge = (challenge: string): unknown => ({ type: 'url_verification', challenge })

function slackSigned(body: unknown, secret = SLACK_SECRET, ts = Math.floor(NOW / 1000)) {
  const rawBody = JSON.stringify(body)
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': String(ts),
      'x-slack-signature': slackExpectedSignature(secret, String(ts), rawBody),
    },
  }
}

function larkSigned(body: unknown, key = LARK_KEY, ts = Math.floor(NOW / 1000)) {
  const rawBody = JSON.stringify(body)
  const nonce = 'n1'
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      'x-lark-request-timestamp': String(ts),
      'x-lark-request-nonce': nonce,
      'x-lark-signature': larkExpectedSignature(key, String(ts), nonce, rawBody),
    },
  }
}

async function post(url: string, rawBody: string, headers: Record<string, string>) {
  return fetch(url, { method: 'POST', headers, body: rawBody })
}

describe('im-http（channel-im 服务面接线）', () => {
  it('健康检查 GET /health → 200（不触 IM 处理）', async () => {
    const started = await listenImHttp(fakeService(), {})
    try {
      const res = await fetch(started.url.replace('/webhook', '/health'))
      expect(res.status).toBe(200)
      const json = (await res.json()) as { ok?: boolean; transport?: string }
      expect(json.ok).toBe(true)
      expect(json.transport).toBe('http-webhook')
    } finally {
      await started.close()
    }
  })

  it('未知路径 404 / 错误方法 405', async () => {
    const started = await listenImHttp(fakeService(), {})
    try {
      const notFound = await fetch(started.url + '/nope', { method: 'POST', body: '{}' })
      expect(notFound.status).toBe(404)
      const wrongMethod = await fetch(started.url + '/slack', { method: 'GET' })
      expect(wrongMethod.status).toBe(405)
    } finally {
      await started.close()
    }
  })

  it('Slack 挑战握手 → 原样回显 challenge，不进业务逻辑', async () => {
    const service = fakeService()
    const started = await listenImHttp(service, { slackSigningSecret: SLACK_SECRET, nowMs: () => NOW })
    try {
      const signed = slackSigned(slackChallenge('CH-1'))
      const res = await post(started.url + '/slack', signed.rawBody, signed.headers)
      expect(res.status).toBe(200)
      const json = (await res.json()) as { challenge?: string }
      expect(json.challenge).toBe('CH-1')
      expect(service.target.status).not.toHaveBeenCalled()
    } finally {
      await started.close()
    }
  })

  it('Slack 有效签名 status 指令 → 200 + 出站摘要（路由走 channelTarget 审批门）', async () => {
    const service = fakeService()
    const started = await listenImHttp(service, { slackSigningSecret: SLACK_SECRET, nowMs: () => NOW })
    try {
      const signed = slackSigned(slackMention('状态'))
      const res = await post(started.url + '/slack', signed.rawBody, signed.headers)
      expect(res.status).toBe(200)
      const json = (await res.json()) as { ok?: boolean; outbound?: { text?: string } }
      expect(json.ok).toBe(true)
      expect(json.outbound?.text).toContain('无 active mission')
      expect(service.channelTarget).toHaveBeenCalledWith('channel')
      expect(service.target.status).toHaveBeenCalled()
    } finally {
      await started.close()
    }
  })

  it('Slack 签名错误 → 401 fail-closed（不降级放行）', async () => {
    const service = fakeService()
    const started = await listenImHttp(service, { slackSigningSecret: SLACK_SECRET, nowMs: () => NOW })
    try {
      const signed = slackSigned(slackMention('状态'))
      const res = await post(started.url + '/slack', signed.rawBody, {
        ...signed.headers,
        'x-slack-signature': 'v0=deadbeef',
      })
      expect(res.status).toBe(401)
      const json = (await res.json()) as { error?: string }
      expect(json.error).toBe('verification failed')
      expect(service.target.status).not.toHaveBeenCalled()
    } finally {
      await started.close()
    }
  })

  it('Slack 未配置 signing secret → 401（凭据缺失不静默放行）', async () => {
    const started = await listenImHttp(fakeService(), { nowMs: () => NOW })
    try {
      const signed = slackSigned(slackMention('状态'))
      const res = await post(started.url + '/slack', signed.rawBody, signed.headers)
      expect(res.status).toBe(401)
    } finally {
      await started.close()
    }
  })

  it('飞书加密模式 → 有效签名可路由，挑战可回显', async () => {
    const service = fakeService()
    const started = await listenImHttp(service, { larkEncryptKey: LARK_KEY, nowMs: () => NOW })
    try {
      const challenge = larkSigned({ schema: '2.0', header: { event_type: 'url_verification' }, event: { challenge: 'CH-2' } })
      const res = await post(started.url + '/lark', challenge.rawBody, challenge.headers)
      expect(res.status).toBe(200)
      expect(((await res.json()) as { challenge?: string }).challenge).toBe('CH-2')

      const msg = larkSigned({
        schema: '2.0',
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_abc' } },
          message: { message_type: 'text', content: JSON.stringify({ text: '状态' }), chat_id: 'oc_123' },
        },
      })
      const res2 = await post(started.url + '/lark', msg.rawBody, msg.headers)
      expect(res2.status).toBe(200)
      expect(service.target.status).toHaveBeenCalled()
    } finally {
      await started.close()
    }
  })

  it('重放去重：同一事件二次投递 → 200 + reason（非幂等指令不被二次执行）', async () => {
    const service = fakeService()
    const started = await listenImHttp(service, { larkEncryptKey: LARK_KEY, nowMs: () => NOW })
    try {
      const eventId = 'evt-1'
      const body = {
        schema: '2.0',
        header: { event_type: 'im.message.receive_v1', event_id: eventId },
        event: {
          sender: { sender_id: { open_id: 'ou_abc' } },
          message: { message_type: 'text', content: JSON.stringify({ text: '暂停' }), chat_id: 'oc_123' },
        },
      }
      const signed = larkSigned(body)
      const first = await post(started.url + '/lark', signed.rawBody, signed.headers)
      const second = await post(started.url + '/lark', signed.rawBody, signed.headers)
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      const json = (await second.json()) as { reason?: string }
      expect(json.reason).toContain('duplicate')
      expect(service.target.pause).toHaveBeenCalledTimes(1)
    } finally {
      await started.close()
    }
  })

  it('传输层 token 鉴权：设 token 后无/错 Bearer → 401，正确 Bearer + 验签 → 200', async () => {
    const service = fakeService()
    const started = await listenImHttp(service, { token: 's3cret', slackSigningSecret: SLACK_SECRET, nowMs: () => NOW })
    try {
      const signed = slackSigned(slackMention('状态'))
      const noAuth = await post(started.url + '/slack', signed.rawBody, signed.headers)
      expect(noAuth.status).toBe(401)
      const wrong = await post(started.url + '/slack', signed.rawBody, { ...signed.headers, authorization: 'Bearer nope' })
      expect(wrong.status).toBe(401)
      const ok = await post(started.url + '/slack', signed.rawBody, { ...signed.headers, authorization: 'Bearer s3cret' })
      expect(ok.status).toBe(200)
      expect(service.target.status).toHaveBeenCalled()
    } finally {
      await started.close()
    }
  })

  it('body 超 64KB → 413（验签前先拒，防灌爆内存）', async () => {
    const started = await listenImHttp(fakeService(), {})
    try {
      const big = 'x'.repeat(65 * 1024)
      const res = await fetch(started.url + '/slack', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: big,
      })
      expect(res.status).toBe(413)
    } finally {
      await started.close()
    }
  })

  it('listenImHttp 非 loopback 无 token → 拒绝启动（库层 fail-closed）', async () => {
    await expect(listenImHttp(fakeService(), { host: '0.0.0.0', port: 0 })).rejects.toThrow(/without token/)
  })
})
