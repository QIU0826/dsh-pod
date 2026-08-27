/**
 * mcp-http（Streamable HTTP 远程访问）—— v0.3：同一套 makeMcpServer 服务面暴露为 HTTP。
 * 端到端：真实 Node http server + StreamableHTTPClientTransport 走完整初始化 + 工具调用。
 */
import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { listenMcpHttp } from '../src/mcp-http.js'
import type { PodService } from '../src/pod-service.js'

function fakeService() {
  return {
    launch: vi.fn((input) => ({ id: 'M-http', status: 'planning', goal: input.goal, name: input.name })),
    status: vi.fn(() => ({ tasks: [], slots: [], pendingApprovals: [], mission: { id: 'M-http' } })),
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
  it('端到端：GET 健康检查 + MCP 初始化 + tools/list + callTool(pod_status)', async () => {
    const service = fakeService()
    const started = await listenMcpHttp(service, {})
    try {
      // 健康检查（非 MCP）
      const health = await fetch(started.url, { method: 'GET' })
      expect(health.status).toBe(200)
      const healthJson = await health.json() as { transport?: string }
      expect(healthJson.transport).toBe('streamable-http')
      // MCP 会话
      const client = await connectClient(started.url)
      const tools = await client.listTools()
      expect(tools.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['pod_status', 'pod_launch', 'pod_approve']))
      const res = await client.callTool({ name: 'pod_status', arguments: {} })
      expect(service.status).toHaveBeenCalled()
      const parsed = JSON.parse(textOf(res))
      expect(parsed.mission.id).toBe('M-http')
      await client.close()
    } finally {
      await started.close()
    }
  })

  it('鉴权：设 token 后无 token / 错 token 请求 → 401，正确 Bearer → 可访问', async () => {
    const service = fakeService()
    const started = await listenMcpHttp(service, { token: 's3cret' })
    try {
      // 无 token
      const noAuth = await fetch(started.url, { method: 'POST', body: '{}' })
      expect(noAuth.status).toBe(401)
      // 错 token
      const wrong = await fetch(started.url, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' })
      expect(wrong.status).toBe(401)
      // 正确 token → MCP 可连通
      const client = await connectClient(started.url, 's3cret')
      const tools = await client.listTools()
      expect(tools.tools.length).toBeGreaterThan(0)
      await client.close()
    } finally {
      await started.close()
    }
  })

  it('HTTP 方法守卫：POST 之外 → 405；非法 JSON → 400', async () => {
    const service = fakeService()
    const started = await listenMcpHttp(service, {})
    try {
      const put = await fetch(started.url, { method: 'PUT' })
      expect(put.status).toBe(405)
      const bad = await fetch(started.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })
      expect(bad.status).toBe(400)
    } finally {
      await started.close()
    }
  })
})