/**
 * MCP HTTP 真实数据端到端验证（CR-29 补充）：SDK 客户端（与 Claude Code 同款传输层）
 * 直连 HTTP server -> initialize -> tools/list（9 工具）-> callTool pod_status（真实 pod.db 数据）。
 * 只读验证，不消耗 LLM 配额。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const url = 'http://127.0.0.1:3947/mcp'
const transport = new StreamableHTTPClientTransport(new URL(url))
const client = new Client({ name: 'e2e-verify', version: '1.0.0' })
await client.connect(transport)
console.log('[1] connected:', url)

const tools = await client.listTools()
console.log('[2] tools/list:', tools.tools.length, 'tools =', tools.tools.map((t) => t.name).join(','))

const res = await client.callTool({ name: 'pod_status', arguments: {} })
const payload = JSON.parse(res.content[0].text)
console.log('[3] pod_status 真实数据:', JSON.stringify({
  has_mission: payload.mission !== null,
  mission_id: payload.mission?.id ?? null,
  mission_status: payload.mission?.status ?? null,
  tasks: Array.isArray(payload.tasks) ? payload.tasks.length : 'n/a',
  pending_approvals: Array.isArray(payload.pending_approvals) ? payload.pending_approvals.length : 'n/a',
  budget: payload.budget ?? null,
}))
await client.close()
console.log('[OK] MCP Streamable HTTP 端到端验证通过（真实数据）')
