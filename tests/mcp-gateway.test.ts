import { describe, expect, it, vi } from 'vitest'
import { McpGateway, gatewayRef, makeMcpGateway, type McpServerConnection } from '../src/core/mcp-gateway.js'

const NOW = 1_700_000_000_000

function conn(
  id: string,
  tools: Array<{ name: string; description?: string }>,
  impl?: (name: string, args: Record<string, unknown>) => unknown,
): McpServerConnection {
  return {
    id,
    listTools: async () => tools.map((t) => ({ ...t })),
    callTool: async (name, args) => ({ ok: true, output: impl !== undefined ? impl(name, args) : `${id}:${name}` }),
  }
}

describe('MCP Gateway（AgentScope-J）', () => {
  it('listTools 聚合多个下游 server，工具名带命名空间前缀', async () => {
    const gw = makeMcpGateway({
      servers: [{ id: 'fs' }, { id: 'db' }],
      connections: [conn('fs', [{ name: 'read' }]), conn('db', [{ name: 'query' }])],
      now: () => NOW,
    })
    const tools = await gw.listTools()
    expect(tools.map((t) => t.ref).sort()).toEqual(['db__query', 'fs__read'])
  })

  it('跨 server 同名工具互不覆盖（命名空间隔离）', async () => {
    const gw = makeMcpGateway({
      servers: [{ id: 'a' }, { id: 'b' }],
      connections: [conn('a', [{ name: 'search' }]), conn('b', [{ name: 'search' }])],
      now: () => NOW,
    })
    const tools = await gw.listTools()
    expect(tools).toHaveLength(2)
    expect(tools.every((t) => t.name === 'search')).toBe(true)
    expect(new Set(tools.map((t) => t.ref)).size).toBe(2)
  })

  it('callTool 按前缀路由到正确的 server', async () => {
    const gw = makeMcpGateway({
      servers: [{ id: 'fs' }, { id: 'db' }],
      connections: [conn('fs', [{ name: 'read' }]), conn('db', [{ name: 'query' }])],
      now: () => NOW,
    })
    expect((await gw.callTool('db__query', { sql: 'select 1' })).output).toBe('db:query')
    expect((await gw.callTool('fs__read', { path: 'x' })).output).toBe('fs:read')
  })

  it('写类工具未获审批 → 不执行（审批门不绕过）', async () => {
    const spy = vi.fn(async (_n: string, _a: Record<string, unknown>) => 'written')
    const gw = makeMcpGateway({
      servers: [{ id: 'fs', gatedTools: ['write'] }],
      connections: [conn('fs', [{ name: 'write' }], spy)],
      beforeCall: async () => false,
      now: () => NOW,
    })
    const r = await gw.callTool('fs__write', { path: 'a.txt' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('审批')
    expect(spy).not.toHaveBeenCalled()
  })

  it('gated 工具在未接线审批钩子时拒绝执行（fail-closed，不静默放行）', async () => {
    const gateway = new McpGateway({
      servers: [{ id: 'fs', gatedTools: ['write'] }],
      connections: [conn('fs', [{ name: 'write' }, { name: 'read' }])],
    })
    const result = await gateway.callTool('fs__write', { path: 'x' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('fail-closed')
    // 非 gated 工具不受影响（无钩子仍可执行只读调用）
    const ok = await gateway.callTool('fs__read', {})
    expect(ok.ok).toBe(true)
  })

  it('serverId 含 __ 或为空 → 构造即失败（命名空间解析错位防护）', () => {
    expect(() => new McpGateway({
      servers: [{ id: 'a__b' }],
      connections: [conn('a__b', [])],
    })).toThrow(/非法 MCP server id/)
    expect(() => new McpGateway({
      servers: [{ id: '' }],
      connections: [conn('', [])],
    })).toThrow(/非法 MCP server id/)
  })

  it('写类工具获审批 → 正常执行；非 gated 工具不触发审批钩子', async () => {
    const gate = vi.fn(async () => true)
    const gw = makeMcpGateway({
      servers: [{ id: 'fs', gatedTools: ['write'] }],
      connections: [conn('fs', [{ name: 'write' }, { name: 'read' }])],
      beforeCall: gate,
      now: () => NOW,
    })
    expect((await gw.callTool('fs__write', {})).ok).toBe(true)
    expect(gate).toHaveBeenCalledTimes(1)
    await gw.callTool('fs__read', {})
    expect(gate).toHaveBeenCalledTimes(1)
  })

  it('未知 server / 非法引用 → 抛错（fail-closed，不静默成功）', async () => {
    const gw = makeMcpGateway({ servers: [{ id: 'fs' }], connections: [conn('fs', [{ name: 'read' }])], now: () => NOW })
    await expect(gw.callTool('nope__read')).rejects.toThrow(/未知 MCP server/)
    await expect(gw.callTool('read')).rejects.toThrow(/非法工具引用/)
  })

  it('声明了 server 却没有连接 → 构造即失败（配置错误显式暴露）', () => {
    expect(() => makeMcpGateway({ servers: [{ id: 'fs' }], connections: [] })).toThrow(/无连接/)
  })

  it('大输出被截断（防灌爆上下文与事件流）', async () => {
    const gw = makeMcpGateway({
      servers: [{ id: 'fs' }],
      connections: [conn('fs', [{ name: 'read' }], () => 'x'.repeat(20_000))],
      maxOutputChars: 100,
      now: () => NOW,
    })
    const output = String((await gw.callTool('fs__read')).output)
    expect(output.length).toBeLessThan(200)
    expect(output).toContain('已截断')
  })

  it('下游抛异常 → 转为网关错误并落审计（ok=false 带原因）', async () => {
    const audits: Array<{ ok: boolean; error?: string }> = []
    const gw = makeMcpGateway({
      servers: [{ id: 'fs' }],
      connections: [{
        id: 'fs',
        listTools: async () => [{ name: 'read' }],
        callTool: async () => { throw new Error('EACCES') },
      }],
      audit: (e) => audits.push(e),
      now: () => NOW,
    })
    await expect(gw.callTool('fs__read')).rejects.toThrow(/EACCES/)
    expect(audits).toHaveLength(1)
    expect(audits[0]!.ok).toBe(false)
    expect(audits[0]!.error).toContain('EACCES')
  })

  it('审计条目带 gated / approved 标记（审批门行为可追溯）', async () => {
    const audits: Array<{ gated: boolean; approved: boolean }> = []
    const gw = makeMcpGateway({
      servers: [{ id: 'fs', gatedTools: ['write'] }],
      connections: [conn('fs', [{ name: 'write' }])],
      beforeCall: async () => true,
      audit: (e) => audits.push(e),
      now: () => NOW,
    })
    await gw.callTool('fs__write')
    expect(audits[0]).toMatchObject({ gated: true, approved: true })
  })

  it('gatewayRef 与解析互逆', async () => {
    const gw = new McpGateway({
      servers: [{ id: 's-1' }],
      connections: [conn('s-1', [{ name: 'tool_a' }])],
      now: () => NOW,
    })
    expect((await gw.callTool(gatewayRef('s-1', 'tool_a'))).ok).toBe(true)
    await gw.close()
  })
})
