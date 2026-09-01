/**
 * MCP stdio bridge —— 独立进程入口（Claude Code / Codex 可经 MCP 反向驱动 Pod）。
 *
 * 用法（先 build）：
 *   node scripts/mcp-bridge.mjs
 * Claude Code 注册：
 *   claude mcp add pod -- node <dsh-pod>/scripts/mcp-bridge.mjs
 *
 * 设计（docs/mcp-bidirectional.md §5）：stdio transport 最易验证；
 * server 逻辑（makeMcpServer）与 transport 解耦，后续可换 Streamable HTTP。
 * 鉴权：stdio 由宿主导航拉起（进程边界即信任面）；审批/合并仍走原代码入口。
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createPodRuntime } from '../dist/plugin.js'
import { PodService } from '../dist/pod-service.js'
import { makeMcpServer } from '../dist/mcp-server.js'

async function main() {
  const dataDir = process.env.POD_DATA_DIR;
  const runtime = createPodRuntime(dataDir && dataDir.length > 0 ? dataDir : undefined)
  const service = new PodService({ store: runtime.store, memory: runtime.memory, dataDir: runtime.dataDir });
  // ADOL P2-1：POD_MCP_TOOL_LISTING=short 时 tools/list 只回一句话清单（省一次性下发字节），
  // 完整入参 schema 由 pod_expand_tool 按需展开；缺省 full（标准 MCP，客户端无感）。
  const listing = process.env.POD_MCP_TOOL_LISTING === 'short' ? 'short' : 'full';
  const server = makeMcpServer(service, { toolListing: listing });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[dsh-pod-mcp] connected (stdio, toolListing=" + listing + "). tools: pod_launch/pod_status/pod_dispatch/pod_steer/pod_approve/pod_deny/pod_pause/pod_resume/pod_abort");
  // 进程常驻：stdio transport 持续监听；宿主断开时退出
  const shutdown = async () => { await server.close(); process.exit(0) };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((error) => {
  console.error("[dsh-pod-mcp] fatal:", error);
  process.exit(1);
});
