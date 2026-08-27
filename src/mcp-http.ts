/**
 * MCP Streamable HTTP 传输 —— v0.3 远程访问最小闭环（docs/mcp-bidirectional.md §5）。
 *
 * stdio（CR-28）是本地最小验证；本模块把同一套 makeMcpServer 服务面暴露为
 * MCP Streamable HTTP（单一 /mcp POST 端点），让远程 agent / 其他机器经网络反向驱动 Pod。
 *
 * 架构不变量保持：审批/合并仍只走原代码入口（MCP 只是传输层包装）；
 * 本机默认 loopback-only + 可选 Bearer token（POD_MCP_TOKEN），无 token 时默认不开（fail-closed）。
 * server 逻辑（makeMcpServer）与 transport 解耦 —> 同一服务面任意换 stdio/HTTP。
 */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { PodService } from './pod-service.js'
import { makeMcpServer } from './mcp-server.js'

export interface McpHttpOptions {
  token?: string
  make?: (service: PodService) => McpServer
  dataDir?: string
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
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
}

export function createMcpHttpServer(service: PodService, opts: McpHttpOptions = {}): McpHttpHandle {
  const token = (opts.token ?? '').trim()
  const server = (opts.make ?? makeMcpServer)(service)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
  const ready = server.connect(transport)

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, name: 'dsh-pod-mcp', transport: 'streamable-http' }))
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    // 鉴权（Berd-H 纪律：外部入口显式启用 + 凭据不出会话）。token 为空 -> 信任 loopback 本身。
    if (token.length > 0) {
      const auth = (req.headers.authorization ?? '').trim()
      if (auth !== 'Bearer ' + token) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
    }
    let body: unknown
    try { body = await readBody(req) } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid json body' }))
      return
    }
    try {
      await transport.handleRequest(req as never, res as never, body)
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal mcp error' }))
      }
    }
  }

  return { handle, close: () => server.close(), ready, token }
}

export interface StartedMcpHttp {
  url: string
  port: number
  close(): Promise<void>
}

export async function listenMcpHttp(
  service: PodService,
  opts: McpHttpOptions & { host?: string; port?: number } = {},
): Promise<StartedMcpHttp> {
  const mcp = createMcpHttpServer(service, opts)
  await mcp.ready
  const host = opts.host ?? '127.0.0.1'
  const server: Server = createServer((req, res) => void mcp.handle(req, res))
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : (opts.port ?? 0)
  return {
    url: 'http://' + host + ':' + port + '/mcp',
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await mcp.close()
    },
  }
}

export default createMcpHttpServer
