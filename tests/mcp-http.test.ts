/**
 * mcp-http（Streamable HTTP 远程访问）—— v0.3：同一套 makeMcpServer 服务面暴露为 HTTP。
 * 端到端：真实 Node http server + StreamableHTTPClientTransport 走完整初始化 + 工具调用。
 * CR-29 补充：按会话多实例（两客户端并发互不干扰）；健康检查 GET /health。
 */
import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { listenMcpHttp } from '../src/mcp-http.js'
import type { PodService } from '../src/pod-service.js'

function fakeService() {
  return {
    launch: vi.fn((input) => ({ id: 'M-http', status: 'planning', goal: input.goal, name: input.name })),
    status: vi.fn(() => ({ mission: null, tasks: [], slots: [], pendingApprovals: [], ledgerTail: [] })),
    dispatchNext: vi.fn(async () => true),
    steer: vi.fn(),
    approve: vi.fn(async () => ({ ok: true, conflict: false, mergeCommit: 'feedc0de1234' })),
    deny: vi.fn(),
    pauseMission: vi.fn(),
    resumeMission: vi.fn(),
    abort: vi.fn(),
    ledgerTail: vi.fn(() => []),
    recordToolAudit: vi.fn(),
  } as unknown as PodService
}

function textOf(res: unknown): string {
  const content = (res as { content?: unknown[] }).content
  const first = content?.[0] as { type?: string; text?: string } | undefined
  return first?.text ?? ''
}

async function connectClient(url: string, token?: string) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { authorization: 'Bearer ' + token } } : undefined,
  })
  const client = new Client({ name: 'http-test-client', version: '1.0.0' })
  await client.connect(transport)
  return client
}

describe('mcp-http（v0.3 Streamable HTTP 远程访问）', () => {
  it('健康检查 GET /health（不触 MCP 会话）+ 端到端 initialize/tools/callTool', async () => {
    const service = fakeService()
    const started = await listenMcpHttp(service, {})
    try {
      const health = await fetch(started.url.replace('/mcp', '/health'))
      expect(health.status).toBe(200)
      const healthJson = (await health.json()) as { transport?: string }
      expect(healthJson.transport).toBe('streamable-http')

      const client = await connectClient(started.url)
      const tools = await client.listTools()
      expect(tools.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['pod_status', 'pod_launch', 'pod_approve']))
      const res = await client.callTool({ name: 'pod_status', arguments: {} })
      expect(service.status).toHaveBeenCalled()
      const parsed = JSON.parse(textOf(res))
      expect(parsed.mission).toBeNull()
      await client.close()
    } finally {
      await started.close()
    }
  })

  it('多客户端并发：两个独立 client 各自会话互不干扰（单例 transport 回归）', async () => {
    const service = fakeService()
    const started = await listenMcpHttp(service, {})
    try {
      const c1 = await connectClient(started.url)
      const c2 = await connectClient(started.url)
      const r1 = await c1.callTool({ name: 'pod_status', arguments: {} })
      const r2 = await c2.callTool({ name: 'pod_status', arguments: {} })
      expect(JSON.parse(textOf(r1)).mission).toBeNull()
      expect(JSON.parse(textOf(r2)).mission).toBeNull()
      expect(started.sessionCount()).toBe(2)
      await c1.close()
      await c2.close()
    } finally {
      await started.close()
    }
  })

  it('鉴权：设 token 后无 token / 错 token 请求 → 401，正确 Bearer → 可访问', async () => {
    const service = fakeService()
    const started = await listenMcpHttp(service, { token: 's3cret' })
    try {
      const noAuth = await fetch(started.url, { method: 'POST', body: '{}' })
      expect(noAuth.status).toBe(401)
      const wrong = await fetch(started.url, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' })
      expect(wrong.status).toBe(401)
      const client = await connectClient(started.url, 's3cret')
      const tools = await client.listTools()
      expect(tools.tools.length).toBeGreaterThan(0)
      await client.close()
    } finally {
      await started.close()
    }
  })

  it('HTTP 方法守卫：未知路径 404、非法 JSON 400、未知 session 404', async () => {
    const service = fakeService()
    const started = await listenMcpHttp(service, {})
    try {
      const put = await fetch(started.url, { method: 'PUT' })
      expect([404, 405]).toContain(put.status)
      const bad = await fetch(started.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })
      expect(bad.status).toBe(400)
      const stale = await fetch(started.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'no-such-session' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      expect([404, 400]).toContain(stale.status)
    } finally {
      await started.close()
    }
  })
})

describe('mcp-http P1 加固（content-type + fail-closed）', () => {
  it('POST 非 application/json → 415（text/plain 是 CORS simple request 注入通道）', async () => {
    const service = fakeService()
    const started = await listenMcpHttp(service, {})
    try {
      const res = await fetch(started.url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
      })
      expect(res.status).toBe(415)
    } finally {
      await started.close()
    }
  })

  it('listenMcpHttp：非 loopback 无 token → 拒绝启动（库层 fail-closed）', async () => {
    await expect(listenMcpHttp(fakeService(), { host: '0.0.0.0', port: 0 })).rejects.toThrow(/without token/)
  })
})
