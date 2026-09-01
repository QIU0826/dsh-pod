/**
 * 量化 MCP tools/list 下发体积（ADOL P2-1：tools/list --short）。
 *
 * 全量 vs short 两种模式下 tools/list 的 inputSchema 总字节；short 模式的完整 schema
 * 走 pod_expand_tool 按需展开（展开单个工具的字节数也一并报告）。
 *
 * 用法（先 build）：
 *   node scripts/measure-mcp-tools.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { makeMcpServer } from '../dist/mcp-server.js'

const fake = {
  launch: () => ({}), status: () => ({}), dispatchNext: async () => true, steer: () => {},
  approve: async () => ({ ok: true, conflict: false, mergeCommit: 'x' }), deny: () => {},
  pauseMission: () => {}, resumeMission: () => {}, abort: () => {},
  ledgerTail: () => [], recordToolAudit: () => {},
}

async function listBytes(mode) {
  const server = makeMcpServer(fake, { toolListing: mode })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'm', version: '1' })
  await Promise.all([server.connect(a), client.connect(b)])
  const tools = await client.listTools()
  let total = 0
  for (const t of tools.tools) total += JSON.stringify(t.inputSchema ?? {}).length
  const names = tools.tools.map((t) => t.name).length
  await client.close()
  return { total, names }
}

const full = await listBytes('full')
const short = await listBytes('short')

// 展开单个最大工具（pod_launch）的完整 schema 字节
const server = makeMcpServer(fake, { toolListing: 'short' })
const [a, b] = InMemoryTransport.createLinkedPair()
const client = new Client({ name: 'm', version: '1' })
await Promise.all([server.connect(a), client.connect(b)])
const res = await client.callTool({ name: 'pod_expand_tool', arguments: { name: 'pod_launch' } })
const expandBytes = res.content[0].text.length
await client.close()

console.log('full  mode inputSchema bytes:', full.total, '(', full.names, 'tools )')
console.log('short mode inputSchema bytes:', short.total, '(', short.names, 'tools )')
console.log('short 模式省去一次性下发:', full.total - short.total, 'bytes (', ((1 - short.total / full.total) * 100).toFixed(1), '% )')
console.log('按需展开 pod_launch 单个工具:', expandBytes, 'bytes')
