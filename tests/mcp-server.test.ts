/**
 * mcp-server —— v0.3 MCP 双向暴露：pod_* 工具面映射为 MCP tools（薄壳调用 PodService）。
 */
import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { makeMcpServer } from '../src/mcp-server.js'
import type { PodService } from '../src/pod-service.js'

function textOf(res: unknown): string {
  const content = (res as { content?: unknown[] }).content
  const first = content?.[0] as { type?: string; text?: string } | undefined
  return first?.text ?? ''
}

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

async function makePair(service: ReturnType<typeof fakeService>) {
  const server = makeMcpServer(service)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "1.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, server }
}

describe("mcp-server（v0.3 MCP 双向暴露）", () => {
  it("pod_status：工具调用 → service.status() 薄壳返回快照", async () => {
    const service = fakeService()
    const { client } = await makePair(service)
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["pod_status", "pod_launch", "pod_approve"]))
    const res = await client.callTool({ name: "pod_status", arguments: {} })
    expect(service.status).toHaveBeenCalled()
    const parsed = JSON.parse(textOf(res))
    expect(parsed.tasks).toEqual([])
  })

  it("pod_launch：透传参数到 service.launch", async () => {
    const service = fakeService()
    const { client } = await makePair(service)
    await client.callTool({
      name: "pod_launch",
      arguments: {
        name: "m", goal: "g", cwd: "D:/x", budget_usd: 3,
        slots: [{ id: "S-1", vendor: "claude", role: "implementer", capabilities: ["编码"] }],
      },
    })
    expect(service.launch).toHaveBeenCalledWith(expect.objectContaining({ name: "m", goal: "g", cwd: "D:/x", budgetUsd: 3 }))
  })

  it("pod_approve：合并放行（唯一入口语义保持）", async () => {
    const service = fakeService()
    const { client } = await makePair(service)
    const res = await client.callTool({ name: "pod_approve", arguments: { approval_id: "A-1", edited: { merge_note: "ok" } } })
    expect(service.approve).toHaveBeenCalledWith("A-1", "mcp", { merge_note: "ok" }, true)
    expect(textOf(res)).toContain("abc12345")
  })

  it("pod_deny / pod_steer / pod_pause / pod_resume / pod_abort：薄壳透传", async () => {
    const service = fakeService()
    const { client } = await makePair(service)
    await client.callTool({ name: "pod_deny", arguments: { approval_id: "A-1", reason: "r" } })
    expect(service.deny).toHaveBeenCalledWith("A-1", "mcp", "r")
    await client.callTool({ name: "pod_steer", arguments: { slot_id: "S-1", instruction: "加缓存" } })
    expect(service.steer).toHaveBeenCalledWith("S-1", "加缓存")
    await client.callTool({ name: "pod_pause", arguments: {} })
    expect(service.pauseMission).toHaveBeenCalled()
    await client.callTool({ name: "pod_resume", arguments: {} })
    expect(service.resumeMission).toHaveBeenCalled()
    await client.callTool({ name: "pod_abort", arguments: { reason: "mcp stop" } })
    expect(service.abort).toHaveBeenCalledWith("mcp stop")
  })
})
