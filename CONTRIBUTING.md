# Contributing to dsh-pod

欢迎贡献。本仓库是 **DSH Web 的多智能体驾驶舱插件**：一键组队、看得见、管得住。
开工唯一基线是 [DSH-Pod-项目方案书-v2.0.md](../../DSH-Pod-项目方案书-v2.0.md)（含 CR 设计变更记录）——
**一切改动不得静默改写历史决策**，新增切片以「设计变更记录」追加文末。

## 环境

- Node.js >= 22.5，npm
- 依赖 DSH rc 线（npm 官方 SDK 包，只走公开扩展点）
- 开发/测试不需要真实 agent CLI（单测用 fake 后端脚本化回放）；运行 bake-off/demo 才需要

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run verify` | **发布候选门**：typecheck → coverage → build 一条龙，改完代码默认要过它 |
| `npm run typecheck` | tsc --noEmit 严格模式 |
| `npm test` | vitest 全量单测（无真实 CLI/网络依赖） |
| `npm run test:coverage` | 覆盖率门禁（lines/functions/statements 80%，branches 75%） |
| `npm run build` | tsc（宿主 dist/plugin.js）+ tsdown（浏览器 dist/client.js） |

## 代码约定（摘自 AGENTS.md）

- TypeScript **erasable syntax only**：无 enum、无 namespace、无参数属性。
- 相对导入一律带 `.js` 后缀（NodeNext ESM）。
- 错误用 `PodError`（code 机器可读）与子类。
- 事件 payload 只放可 JSON 序列化的平面数据；大对象（diff、报告全文）不落事件，走文件指针。
- 新路由加入 `src/routes.ts` 的 `makePodRoutes`，loopback-only，配 `tests/routes.test.ts`。
- 新核心模块：注入式副作用（clock / store / fs / backend），配离线单测；不硬编码真实 CLI 调用。
- 提交信息按语义化前缀（feat/fix/docs/test/refactor + 范围 + CR/DoD/迁移项编号）。

## 架构不变量（代码强制执行，改动不得破坏）

1. **LLM 提议，代码裁决**：状态迁移只走状态机入口，非法迁移抛 `INVALID_TRANSITION`；
2. **原始事件永不进 commander 上下文**：只进磁盘与 Canvas；`store.appendEvent` 是唯一事件落盘通道；
3. **审批/收集/合并只走三个代码入口**：`pod_approve` / `pod_collect` / `apply_patch`；
4. **员工进程是沙箱边界**：charter 约束 + `--allowedTools` 白名单 + 路径校验 hook，三道防线全开；
5. **路径安全**：所有读/写进 worktree 的路径必须过白名单；
6. **预算**：记录走 ledger（tokens 实测 + equiv_usd 标注价目表版本）；派发前 `estimateTaskCostUsd` 短路。

## 测试注意

- `tests/orchestrator.test.ts` 的 FakeBackend：`start` 按任务 id 脚本化产出 progress/completion，完成信号必须在 microtask 回调；重试走 `next`。
- Windows 专项：execFile 直跑 .exe；codex 二进制候选含 `~/.codex/.sandbox-bin/codex.exe`。
- 改动提交前跑 `npm run verify`；只动测试/文档可只跑 `npm run typecheck` + `npm test`。
- 只改 src/core、src/routes、tests 时不需要重建浏览器包；改 src/web/* 才需要 `npm run build`。

## 提交流程

1. 本地分支 → 改代码 + 补测试 → `npm run verify` 全绿；
2. 提交（语义化前缀 + CR 编号）；
3. PR 到 `main`——CI 自动跑 verify（GitHub Actions，node 22/24）。

## 安全红线

- **绝不在仓库/文档/示例里提交真实 API key**（ARK / ANTHROPIC / DeepSeek 等）。
- key 只走环境变量或 `~/.claude/settings.json`（仓库外）。
- `reports/`、`dist/`、`node_modules/`、`.pod-worktrees/` 已在 .gitignore，不要手工 add。

## 文档

- `docs/`：DoD 核对表 / 协议适配器（adapters.md）/ MCP 双向（mcp-bidirectional.md）/ 卫星（satellite.md）/ 外部通道（external-channels.md）/ 遥测（telemetry.md）。
- `scripts/`：demo-chain / bakeoff-* / memory-eval* / mcp-* / satellite-worker / channel-http-server。