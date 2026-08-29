/**
 * MCP Streamable HTTP 传输 —— v0.3 远程访问（docs/mcp-bidirectional.md §5）。
 *
 * stdio（CR-28）是本地最小验证；本模块把同一套 makeMcpServer 服务面暴露为
 * MCP Streamable HTTP（/mcp POST 端点 + /health 健康检查），多客户端并发
 * （每会话一个 transport 实例，Mcp-Session-Id 头路由——官方 stateful 模式）。
 *
 * 架构不变量保持：审批/合并仍只走原代码入口（MCP 只是传输层包装）；
 * 本机默认 loopback-only + 可选 Bearer token（POD_MCP_TOKEN），绑非 loopback 且无 token 拒绝启动（fail-closed）。
 * server 逻辑（makeMcpServer）与 transport 解耦 -> 同一服务面任意换 stdio/HTTP。
 *
 * CR-29 补充实测修复：单例 transport 在第二个客户端 initialize 时报
 * "Server already initialized" —— 改为按会话多实例 + onsessioninitialized 注册。
 */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { PodService } from './pod-service.js'
import { makeMcpServer } from './mcp-server.js'
import { allowsJsonBody, bearerTokenEquals, hasAllowedLoopbackOrigin, isLocalHostHeader, isLoopbackBindHost } from './core/http-guard.js'

export interface McpHttpOptions {
  token?: string
  make?: (service: PodService) => McpServer
  dataDir?: string
}

const MAX_MCP_BODY_BYTES = 1024 * 1024

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > MAX_MCP_BODY_BYTES) {
        // 立即拒绝但不 destroy 连接：后续 data 继续被本监听器消费（丢弃），
        // 既不缓冲（内存安全）也不回压死客户端（destroy 会让 fetch 直接断连拿不到 413）
        chunks.length = 0
        reject(new BodyTooLargeError('body exceeds 1MB limit'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw.length === 0 ? undefined : JSON.parse(raw))
      } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

export interface McpHttpHandle {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  close(): Promise<void>
  ready: Promise<void>
  token: string
  /** 当前活跃会话数（观测用）。 */
  sessionCount(): number
}

export function createMcpHttpServer(service: PodService, opts: McpHttpOptions = {}): McpHttpHandle {
  const token = (opts.token ?? '').trim()
  // 每会话一个 transport+server 实例（官方 stateful 模式）：多客户端并发互不干扰。
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>()

  function authorized(req: IncomingMessage): boolean {
    if (token.length === 0) return true
    return bearerTokenEquals(token, req)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // 健康检查（GET /health）：远程可探活，不触 MCP 会话。
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, name: 'dsh-pod-mcp', transport: 'streamable-http', sessions: sessions.size }))
      return
    }
    if (req.method !== 'POST' && req.method !== 'DELETE' && req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    // 鉴权（Berd-H 纪律：外部入口显式启用 + 凭据不出会话）。token 为空 -> 信任 loopback 本身。
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    // P1：无 token（loopback 信任模式）时叠加浏览器侧防线——Host 白名单堵 DNS rebinding
    // （否则攻击页同源可读响应），Origin 校验堵跨站写。带 token 的远程模式由 token 兜底。
    if (token.length === 0 && (!isLocalHostHeader(req) || !hasAllowedLoopbackOrigin(req))) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'forbidden: non-local Host header or cross-origin request' }))
      return
    }
    // P1：POST 带体强制 application/json（text/plain 属 CORS simple request，可被恶意网页无预检跨站提交）
    if (req.method === 'POST' && !allowsJsonBody(req)) {
      res.writeHead(415, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'content-type must be application/json' }))
      return
    }

    const rawSid = req.headers['mcp-session-id']
    const sessionId = Array.isArray(rawSid) ? rawSid[0] : rawSid
    let entry = sessionId !== undefined ? sessions.get(sessionId) : undefined

    // DELETE = 客户端显式关闭会话（MCP 规范）。
    if (req.method === 'DELETE') {
      if (entry !== undefined) {
        await entry.server.close()
        sessions.delete(sessionId as string)
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // POST 才有 JSON-RPC body；GET(SSE 流)/DELETE 无需解析。
    let body: unknown
    if (req.method === 'POST') {
      try {
        body = await readBody(req)
      } catch (error) {
        const tooLarge = error instanceof BodyTooLargeError
        res.writeHead(tooLarge ? 413 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: tooLarge ? 'body too large (1MB limit)' : 'invalid json body' }))
        return
      }
    }

    // 无 session id 且非 initialize -> 无法路由（400）；未知 session id -> 404。
    if (entry === undefined) {
      const isInit = req.method === 'POST' && body !== undefined && isInitializeRequest(body)
      if (!isInit) {
        res.writeHead(sessionId !== undefined ? 404 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: sessionId !== undefined ? 'session not found' : 'initialize request required' }))
        return
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
      const server = (opts.make ?? makeMcpServer)(service)
      await server.connect(transport)
      // initialize 请求本身必须交给该 transport 处理：session id 在此刻才生成并随响应头下发。
      try {
        await transport.handleRequest(req as never, res as never, body)
      } catch {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'internal mcp error' }))
        }
        return
      }
      // handleRequest 完成后 sessionId 已就绪，注册新会话供后续请求按头路由。
      const id = transport.sessionId
      if (id !== undefined) sessions.set(id, { server, transport })
      return
    }

    try {
      await entry.transport.handleRequest(req as never, res as never, body)
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal mcp error' }))
      }
    }
  }

  return {
    handle,
    ready: Promise.resolve(),
    token,
    sessionCount: () => sessions.size,
    close: async () => {
      for (const { server } of sessions.values()) await server.close()
      sessions.clear()
    },
  }
}

export interface StartedMcpHttp {
  url: string
  port: number
  sessionCount(): number
  close(): Promise<void>
}

export async function listenMcpHttp(
  service: PodService,
  opts: McpHttpOptions & { host?: string; port?: number } = {},
): Promise<StartedMcpHttp> {
  const mcp = createMcpHttpServer(service, opts)
  await mcp.ready
  const host = opts.host ?? '127.0.0.1'
  // 库层 fail-closed（P1，与 mcp-http-server.mjs 脚本层同款）：非 loopback 必须配 token
  if (!isLoopbackBindHost(host) && (opts.token ?? '').trim().length === 0) {
    throw new Error('refusing to bind MCP HTTP on non-loopback host without token (set POD_MCP_TOKEN)')
  }
  // async handler 的 rejection 无人接 = unhandledRejection 炸进程：统一兜底（headers 未发出时回 500）
  const server: Server = createServer((req, res) => {
    void mcp.handle(req, res).catch(() => {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'internal error' }))
        } else {
          res.end()
        }
      } catch {
        // 响应已不可写：放弃该连接
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : (opts.port ?? 0)
  return {
    url: 'http://' + host + ':' + port + '/mcp',
    port,
    sessionCount: () => mcp.sessionCount(),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await mcp.close()
    },
  }
}

export default createMcpHttpServer
