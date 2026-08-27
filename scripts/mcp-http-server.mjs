/**
 * MCP Streamable HTTP bridge —— 远程访问 MCP（v0.3，docs/mcp-bidirectional.md §5 落地）。
 *
 * 与 mcp-bridge.mjs（stdio）同套服务面（makeMcpServer），仅换 transport：
 *   本文件把 dsh-pod MCP 暴露为单一 HTTP 端点，供远程 agent / 其他机器反向驱动 Pod。
 *
 * 用法（先 build）：
 *   node scripts/mcp-http-server.mjs            # 默认 127.0.0.1:3947/mcp，loopback-only
 *   POD_MCP_PORT=3947 POD_MCP_TOKEN=<token> node scripts/mcp-http-server.mjs  # 显式启用 token 鉴权
 *   POD_MCP_HOST=0.0.0.0 ... # 显式绑所有网卡（危险，仅当明确需要远程时；仍建议 token）
 *
 * 鉴权纪律（Berd-H）：外部入口应显式启用。loopback 默认可信；绑非 loopback 时必须经
 *   环境变量显式放行（0.0.0.0 且无 token → 拒绝启动，fail-closed）。
 */

import { listenMcpHttp } from '../dist/mcp-http.js'
import { createPodRuntime } from '../dist/plugin.js'
import { PodService } from '../dist/pod-service.js'

async function main() {
  const host = (process.env.POD_MCP_HOST ?? '127.0.0.1').trim()
  const port = Number(process.env.POD_MCP_PORT ?? 3947)
  const token = (process.env.POD_MCP_TOKEN ?? '').trim()

  // fail-closed：绑非 loopback 且未设 token → 拒绝（外部入口须显式启用 + 鉴权）
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  if (!isLoopback && token.length === 0) {
    console.error('[dsh-pod-mcp] refusing to bind non-loopback host without POD_MCP_TOKEN (external entry must be explicitly enabled)')
    process.exit(1)
  }

  const dataDir = process.env.POD_DATA_DIR
  const runtime = createPodRuntime(dataDir && dataDir.length > 0 ? dataDir : undefined)
  const service = new PodService({ store: runtime.store, memory: runtime.memory, dataDir: runtime.dataDir })
  const started = await listenMcpHttp(service, { host, port, token })
  console.error('[dsh-pod-mcp] Streamable HTTP on ' + started.url + (token.length ? ' (token auth)' : ' (no token, loopback-only)'))

  const shutdown = async () => { await started.close(); process.exit(0) }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main().catch((error) => {
  console.error('[dsh-pod-mcp] fatal:', error)
  process.exit(1)
})