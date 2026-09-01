/**
 * IM webhook HTTP 交付层 —— 把 `channel-im.ts`（Slack/飞书 vendor adapter）接到真实
 * HTTP 服务面（审计 P2「channel-im 服务面零集成」闭环）。
 *
 * 此前 `scripts/channel-http-server.mjs` 只接通用 `channel.ts`（裸 `{text}`，无 vendor 验签、
 * 无重放去重、无挑战握手）——真要把 Slack/飞书 webhook 挂上去，vendor 签名校验这条安全
 * 链路根本没入口。本模块补上这一半：
 *
 *   - 入站：POST /webhook/slack 或 /webhook/lark，读**原始 body**（验签依赖原始字节，不能
 *     先 JSON.parse），交 `verifyAndParseIm` 做 HMAC 验签 + 时间窗防重放 + 飞书明文模式
 *     verification token 鉴权；挑战握手（url_verification）原样回显 challenge。
 *   - 路由：`handleImRequest`（复用 handleChannelCommand，审批仍走 pod_approve 门，不绕过状态机）；
 *     事件 id 重放去重（ImReplayGuard）。
 *   - 出站：`send` 注入式投递（真实 Slack/Lark 回帖需 bot token，缺省仅 stderr 打印 + 回 ack）。
 *
 * fail-closed 不变量保持：验签失败/时间窗过期/缺凭据/解析不出指令 → 401，不降级放行。
 * 默认 loopback + Host 白名单（DNS rebinding 防线）；出站凭据永不出会话。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { PodService } from './pod-service.js'
import {
  ImReplayGuard,
  handleImRequest,
  type ImCredentials,
  type ImSender,
  type ImVendor,
} from './core/channel-im.js'
import { bearerTokenEquals, isLocalHostHeader, isLoopbackBindHost } from './core/http-guard.js'

export interface ImHttpOptions extends ImCredentials {
  /** 传输层可选 Bearer（反向代理共享密钥；vendor 签名才是主鉴权，此为额外一层）。 */
  token?: string
  /** 出站投递（缺省仅打印到 stderr，真实回帖需 bot token）。 */
  send?: ImSender
  /** 时钟注入（测试用；缺省 Date.now）。 */
  nowMs?: () => number
  /** 重放守卫（缺省新建一个；跨实例共享去重状态时注入）。 */
  replayGuard?: ImReplayGuard
}

export interface ImHttpHandle {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  close(): Promise<void>
  token: string
}

/** webhook body 上限（IM 事件体量小，64KB 足够且防灌爆内存）。 */
const MAX_IM_BODY_BYTES = 64 * 1024

class BodyTooLargeError extends Error {}

/** 读原始 body（bytes → utf8 字符串），不做 JSON 解析（验签需要原始字节）。 */
function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > MAX_IM_BODY_BYTES) {
        chunks.length = 0
        reject(new BodyTooLargeError('body exceeds 64KB limit'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 从路径解析 vendor；非 webhook 路径/未知 vendor → undefined。 */
function vendorFromPath(pathname: string): ImVendor | undefined {
  if (pathname === '/webhook/slack') return 'slack'
  if (pathname === '/webhook/lark') return 'lark'
  return undefined
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function createImHttpHandler(service: PodService, opts: ImHttpOptions = {}): ImHttpHandle {
  const token = (opts.token ?? '').trim()
  const nowMs = opts.nowMs ?? (() => Date.now())
  const send = opts.send
  const replayGuard = opts.replayGuard ?? new ImReplayGuard()
  const target = service.channelTarget('channel')

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/health') {
      writeJson(res, 200, { ok: true, name: 'dsh-pod-im', transport: 'http-webhook' })
      return
    }
    const vendor = vendorFromPath(url.pathname)
    if (vendor === undefined) {
      writeJson(res, 404, { error: 'not found' })
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method not allowed' })
      return
    }
    // 传输层鉴权：token 为空 → 信任 loopback 但叠加 Host 白名单（DNS rebinding 防线）。
    // 主鉴权（vendor 签名）在 verifyAndParseIm 内完成，此处不重复也不放行未验签请求。
    if (token.length > 0) {
      if (!bearerTokenEquals(token, req)) {
        writeJson(res, 401, { error: 'unauthorized' })
        return
      }
    } else if (!isLocalHostHeader(req)) {
      writeJson(res, 403, { error: 'forbidden: non-local Host header (DNS rebinding guard)' })
      return
    }

    let rawBody: string
    try {
      rawBody = await readRawBody(req)
    } catch (error) {
      const tooLarge = error instanceof BodyTooLargeError
      writeJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'body too large (64KB limit)' : 'invalid body' })
      return
    }

    // 完整处理：验签 → 挑战/解析 → 重放去重 → 指令路由 → 出站。
    let result
    try {
      result = await handleImRequest(
        { vendor, headers: req.headers, rawBody },
        target,
        { ...pickCredentials(opts), nowMs: nowMs(), replayGuard },
        send,
      )
    } catch (error) {
      // ChannelTarget 动作（approve/deny/steer 等）在无 active mission 时会抛错；
      // async handler 的 rejection 无人接 = unhandledRejection 打崩进程（Node 22 默认退出）。
      console.error('[dsh-pod-im] command failed:', error instanceof Error ? error.message : error)
      writeJson(res, 500, { error: 'command failed', detail: error instanceof Error ? error.message : String(error) })
      return
    }

    if (!result.handled) {
      // fail-closed：验签失败/时间窗过期/缺凭据等一律 401，不降级放行
      writeJson(res, 401, { error: 'verification failed', reason: result.reason })
      return
    }
    if (result.challenge !== undefined) {
      // 挑战握手：Slack/飞书配置订阅 URL 时下发，必须原样回显
      writeJson(res, 200, { challenge: result.challenge })
      return
    }
    if (result.outbound !== undefined && send === undefined) {
      // 无出站投递：只打印（真实回帖需配置 send/bot token），ack 里仍回可读摘要供联调观测
      console.error('[dsh-pod-im] outbound (not delivered, no sender configured):', result.outbound.text)
    }
    writeJson(res, 200, {
      ok: true,
      ...(result.outbound !== undefined ? { outbound: { text: result.outbound.text } } : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    })
  }

  return {
    handle,
    token,
    close: async () => {},
  }
}

function pickCredentials(opts: ImCredentials): ImCredentials {
  const out: ImCredentials = {}
  if (opts.slackSigningSecret !== undefined) out.slackSigningSecret = opts.slackSigningSecret
  if (opts.larkEncryptKey !== undefined) out.larkEncryptKey = opts.larkEncryptKey
  if (opts.larkVerificationToken !== undefined) out.larkVerificationToken = opts.larkVerificationToken
  return out
}

export interface StartedImHttp {
  url: string
  port: number
  close(): Promise<void>
}

/** 绑定监听（供脚本层薄启动；库层 fail-closed：非 loopback 需 token）。 */
export async function listenImHttp(
  service: PodService,
  opts: ImHttpOptions & { host?: string; port?: number } = {},
): Promise<StartedImHttp> {
  const handler = createImHttpHandler(service, opts)
  const host = opts.host ?? '127.0.0.1'
  if (!isLoopbackBindHost(host) && (opts.token ?? '').trim().length === 0) {
    throw new Error('refusing to bind IM webhook on non-loopback host without token (set POD_IM_TOKEN)')
  }
  const server: Server = createServer((req, res) => {
    void handler.handle(req, res).catch(() => {
      try {
        if (!res.headersSent) writeJson(res, 500, { error: 'internal error' })
        else res.end()
      } catch {
        // 响应已不可写：放弃该连接
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : (opts.port ?? 0)
  return {
    url: 'http://' + host + ':' + port + '/webhook',
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await handler.close()
    },
  }
}

export default createImHttpHandler
