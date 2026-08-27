# MCP 双向暴露（v0.3 方向性设计）—— 方案书 594/797 行

> 状态：**stdio 已实现（CR-28，2026-08-27）**；Streamable HTTP / IM 通道仍为 v0.3 后续。
> 实现：`src/mcp-server.ts`（makeMcpServer，pod_* 工具面映射）+ `scripts/mcp-bridge.mjs`（stdio 入口，`claude mcp add pod -- node <path>/scripts/mcp-bridge.mjs`）。
> 技术参照：MCP（Anthropic, 2024）与 A2A（Google, 2025）协议，方案书 797 行。

## 1. 一句话目标

把 Pod 暴露为 MCP server：Claude Code / Codex 等外部 agent 可**反向驱动 Pod**（发起 mission、查看看板、裁决审批），实现双向联邦——
Pod 的 worker 可以调用外部模型（正向），外部 agent 也能编排 Pod（反向）。

## 2. 双向联邦的四个面

| 方向 | 谁 → 谁 | 协议 | 载体 |
|---|---|---|---|
| 正向（现有） | Pod worker → claude/codex/dsh 后端 | headless-cli / native | WorkerBackend 接口 |
| 反向（v0.3） | 外部 agent → Pod | MCP server（stdin/SSE 传输） | pod_* 工具面复用 |
| 内联（v0.3） | Pod 内部跨 mission | 进程内 | orchestrator 直连 |
| 扩展（v0.3） | 外部协作通道 | MCP Gateway / IM Channel | 与 Berd-H 合并实施 |

## 3. MCP server 暴露面（复用 pod_* 工具，零新编排逻辑）

MCP 的 tool 就是 pod_* 工具面的包装：

| MCP tool | 绑定 pod_* | 语义 |
|---|---|---|
| `pod_launch` | pod_launch | 发起 mission（含 plan DAG） |
| `pod_status` | pod_status | 看板/员工/审批卡/账本快照 |
| `pod_dispatch` | pod_dispatch | 手动派发（commander 降级） |
| `pod_approve` / `pod_deny` | pod_approve | 裁决审批卡（合并唯一放行入口不变） |
| `pod_steer` | pod_steer | 排队指令 |
| `pod_collect` | pod_collect | 收集产物（Verifier 已校验事实） |
| `pod_pause` / `pod_resume` / `pod_abort` | 同名 | 生命周期 |
| `pod_mem_*` | 同名 | 记忆策展 |

**关键不变式**：反向驱动的审批/合并仍只走三个代码入口（pod_approve / pod_collect / apply_patch）——
MCP 只是传输层包装，不新增任何绕过状态机的通道（架构不变量 3 保持）。

## 4. 鉴权与信任面（沿用 loopback-only 纪律）

- 默认只绑 127.0.0.1（与现有 HTTP 路由一致，CR-08 Berd-C 的 isLoopback 校验复用）。
- MCP server 连接需凭据（本机 token / 显式启用的 API key），杜绝局域网任意进程编排。
- 与遥测立场一致（telemetry.md）：MCP 不采集代码/diff/凭据，只暴露白名单字段。

## 5. 实施现状（CR-28 已落地）

1. ✅ 依赖：`@modelcontextprotocol/sdk@^1.30.0`（运行时依赖）。
2. ✅ `src/mcp-server.ts`：`makeMcpServer(service)` 把 pod_* 工具面（launch/status/dispatch/steer/approve/deny/pause/resume/abort 共 9 个）映射为 MCP tools，zod inputSchema + 结构化输出。
3. ✅ `scripts/mcp-bridge.mjs`：stdio transport 入口（Claude Code `claude mcp add pod -- node <path>/scripts/mcp-bridge.mjs`）；server 逻辑与 transport 解耦，后续可换 Streamable HTTP。
4. ✅ 验收：stdio 真实冒烟（initialize 握手 + tools/list 返回 9 工具）；in-memory 单测 4 条（tools 注册 + 薄壳调用 + approve 唯一入口语义）。
5. ⬜ SSE/Streamable HTTP（远程访问）：v0.3 后续；IM 通道与 Berd-H 合并另排。

## 6. 边界

- 本文件是**设计预留**：v0.2 不实现 MCP（无依赖、无代码、无测试变更）。
- A2A（Google 2025）作为跨组织 agent 联邦的参照记录于此，不承诺实现。
- IM 通道（Slack/飞书）与 Berd-H 合并实施，不在本文件范围。
