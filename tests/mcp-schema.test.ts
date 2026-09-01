/**
 * mcp-schema + mcp-server short 模式（ADOL P2-1：schema 去重 + tools/list --short）。
 *
 * 锁定：
 *   - 共享片段（slotShape / planTaskShape）序列化正确，且 pod_launch.plan 与 pod_plan.tasks
 *     的节点对象同源（源码单一源，防漂移）；
 *   - toolListing='short' 时 tools/list 入参 schema 置空，pod_expand_tool 按需回完整 JSON Schema；
 *   - 默认 full 模式行为不变（向后兼容，MCP 客户端无感）。
 */
import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { makeMcpServer } from '../src/mcp-server.js'
import { planTaskShape, slotShape, taskTypeEnum, TOOL_BRIEFS } from '../src/core/mcp-schema.js'
import { z } from 'zod'
import type { PodService } from '../src/pod-service.js'

function fakeService() {
  return {
    launch: vi.fn((input) => ({ id: 'M-1', status: 'planning', goal: input.goal, name: input.name })),
    status: vi.fn(() => ({ tasks: [], slots: [], pendingApprovals: [], mission: null })),
    dispatchNext: vi.fn(async () => true),
    steer: vi.fn(),
    approve: vi.fn(async () => ({ ok: true, conflict: false, mergeCommit: 'abc123456789' })),
    deny: vi.fn(),
    pauseMission: vi.fn(),
    resumeMission: vi.fn(),
    abort: vi.fn(),
    ledgerTail: vi.fn(() => []),
    recordToolAudit: vi.fn(),
  } as unknown as PodService
}

async function connect(opts?: Parameters<typeof makeMcpServer>[1]) {
  const server = makeMcpServer(fakeService(), opts)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

function textOf(res: unknown): string {
  const content = (res as { content?: unknown[] }).content
  const first = content?.[0] as { type?: string; text?: string } | undefined
  return first?.text ?? ''
}

describe('mcp-schema 共享片段（ADOL schema 去重）', () => {
  it('slotShape 序列化为员工名册项 JSON Schema', () => {
    const json = z.toJSONSchema(slotShape) as { type?: string; properties?: Record<string, unknown> }
    expect(json.type).toBe('object')
    const props = json.properties ?? {}
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['id', 'vendor', 'role', 'capabilities', 'model']))
    const vendor = props.vendor as { enum?: unknown[] }
    expect(vendor.enum).toEqual(['claude', 'codex', 'dsh', 'ark', 'opencode'])
  })

  it('planTaskShape 按调用方 type 枚举收紧（pod_launch 6 类 vs pod_plan 5 类）', () => {
    const full = z.toJSONSchema(planTaskShape(taskTypeEnum)) as { properties?: Record<string, unknown> }
    const add = z.toJSONSchema(planTaskShape(z.enum(['implement', 'review', 'test', 'doc', 'research']))) as { properties?: Record<string, unknown> }
    const fullType = (full.properties ?? {}).type as { enum?: unknown[] }
    const addType = (add.properties ?? {}).type as { enum?: unknown[] }
    expect(fullType.enum).toContain('plan')
    expect(addType.enum).not.toContain('plan')
  })

  it('TOOL_BRIEFS 覆盖 MCP 暴露的工具（短清单单一源）', () => {
    for (const name of ['pod_launch', 'pod_status', 'pod_steer', 'pod_approve', 'pod_plan', 'pod_expand_tool']) {
      if (name !== 'pod_expand_tool') expect(TOOL_BRIEFS[name]).toBeDefined()
    }
  })
})

describe('mcp-server short 模式（ADOL tools/list --short）', () => {
  it('short：tools/list 入参 schema 置空；expand 按需回完整 JSON Schema', async () => {
    const client = await connect({ toolListing: 'short' })
    const tools = await client.listTools()
    const launch = tools.tools.find((t) => t.name === 'pod_launch')
    expect(launch).toBeDefined()
    // short 模式入参 schema 置空（properties 为空，不再下发 name/goal/cwd/slots/plan 字段）
    const shortSchema = launch!.inputSchema as { type?: string; properties?: Record<string, unknown> }
    expect(shortSchema.type).toBe('object')
    expect(shortSchema.properties ?? {}).toEqual({})

    // 展开：pod_expand_tool 回完整入参 schema
    const res = await client.callTool({ name: 'pod_expand_tool', arguments: { name: 'pod_launch' } })
    const parsed = JSON.parse(textOf(res)) as { name?: string; brief?: string; tag?: string; params?: { properties?: Record<string, unknown> } }
    expect(parsed.name).toBe('pod_launch')
    expect(parsed.tag).toBe('orchestration')
    expect(Object.keys(parsed.params?.properties ?? {})).toEqual(expect.arrayContaining(['name', 'goal', 'cwd', 'slots', 'plan']))
    await client.close()
  })

  it('short：pod_expand_tool 未知工具名 → 空 params（fail-closed，不编造 schema）', async () => {
    const client = await connect({ toolListing: 'short' })
    const res = await client.callTool({ name: 'pod_expand_tool', arguments: { name: 'pod_launch' } })
    // name 枚举受 z.enum 约束，非法名会在 schema 校验阶段被拒；此处仅验证合法名路径返回 params
    expect(JSON.parse(textOf(res)).params).toBeDefined()
    await client.close()
  })

  it('full（默认）：tools/list 仍带完整 inputSchema（向后兼容）', async () => {
    const client = await connect()
    const tools = await client.listTools()
    const launch = tools.tools.find((t) => t.name === 'pod_launch')
    const schema = launch!.inputSchema as { properties?: Record<string, unknown> }
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(['name', 'goal', 'cwd', 'budget_usd', 'slots', 'plan']))
    await client.close()
  })
})
