# AGENTS.md — dsh-pod（Pod 鲸群）开发约定

> 给 AI agent / 新开发者的仓库速览。完整产品文档见 README.md，
> 设计与变更史以开工基线 [DSH-Pod-项目方案书-v2.0.md](../../DSH-Pod-项目方案书-v2.0.md) 为准（含 CR-01~08）。

## 一句话

在 DSH Web UI 里一键组队、看得见、管得住的多智能体驾驶舱：LLM 组队、状态机裁决、
独立 review 质量门、审批后合并回主树。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run verify` | 发布候选门：typecheck → coverage → build 一条龙（改完代码默认要过它） |
| `npm run typecheck` | tsc --noEmit 严格模式 |
| `npm test` | vitest 全量单测（无真实 CLI/网络依赖，fake 后端脚本化回放） |
| `npm run test:coverage` | 覆盖率门禁（lines/functions/statements 80%，branches 75%） |
| `npm run build` | tsc（宿主 dist/plugin.js）+ tsdown（浏览器 dist/client.js） |
| `node scripts/demo-chain.mjs` | 真实最小可演示链（claude 实现 → codex 审查 → 审批卡），**需先 build** |
| `just verify / demo / bakeoff / install-hooks ...` | justfile 别名入口（见 justfile） |
| `just install-hooks` | 安装 pre-commit 门禁（暂存 src 变更先过 tsc，失败拒绝提交；EN-3 Berd-F） |

> 只改 src/core、src/routes、tests 时不需要重建浏览器包；改 src/web/* 才需要
> `npm run build`（tsdown）并在 DSH Web GUI 刷新验证。

## 目录地图

- `src/core/` —— 纯逻辑域层，注入式副作用，可离线单测（store / task-machine / mission /
  approvals / ledger / handoff / verifier / dispatcher / session-tiers / watchdog /
  orchestrator / events / asset-whitelist / apply-patch / backends-lock / permission-rules / ...）
- `src/workers/` —— 真实后端（claude-headless / codex-headless）+ preflight 环境探测（Windows 专项）
- `src/web/` —— 浏览器插件（client.ts / api.ts / event-stream.ts / PodPanel.ts）
- `src/pod-tools.ts` —— pod_* 工具注册（薄壳调用，状态机裁决一切迁移）
- `src/routes.ts` —— /api/dsh-pod/* HTTP 路由（loopback-only）
- `src/plugin.ts` —— 宿主入口（PodRuntime + 健康路由）
- `scripts/` —— demo-chain / bakeoff-all / bakeoff-run（产物留 reports/）
- `tests/` —— 与 src 同构的 vitest 单测；orchestrator 测试用 FakeBackend 脚本化回放 + 真实 git 仓库 fixture
- `docs/` —— DoD 核对表 / 验收记录 / 差距审计（**入库**）
- `reports/` —— bake-off 原始数据与汇总（**不入库**，.gitignore，按前序会话决策）
- `tasks/` —— bakeoff-tasks.json 任务集

## 架构不变量（代码强制执行，改动不得破坏）

1. **LLM 提议，代码裁决**：状态迁移只走状态机入口，非法迁移抛 `INVALID_TRANSITION`；
2. **原始事件永不进 commander 上下文**：只进磁盘与 Canvas；`store.appendEvent` 是唯一事件落盘通道，
   所有 HITL 事件（审批/转人工/预算告警）必须进 mission 事件流（tests 有 EV-3 不变量断言）；
3. **审批/收集/合并只走三个代码入口**：`pod_approve` / `pod_collect` / `apply_patch`（合并是唯一回主树通道）；
4. **员工进程是沙箱边界**：charter 约束 + `--allowedTools` 白名单 + 路径校验 hook，三道防线全开；
5. **路径安全**：所有读/写进 worktree 的路径必须过白名单（`makePathWhitelist` / `resolveAsset`），
   拒绝 `..`、绝对路径、盘符、符号链接、realpath 逃逸；
6. **预算**：记录走 ledger（tokens 实测 + equiv_usd 标注价目表版本）；派发前 `estimateTaskCostUsd`
   短路，剩余预算不足不派发并发 `budget_short_circuit` 事件。

## 代码约定

- TypeScript **erasable syntax only**：无 enum、无 namespace、无参数属性（const 枚举可拆字面量联合）。
- 相对导入一律带 `.js` 后缀（NodeNext ESM）。
- 错误用 `PodError`（code 机器可读）与 `BudgetExceededError` / `NotFoundError` 等子类。
- 事件 payload 只放可 JSON 序列化的平面数据；大对象（diff、报告全文）不落事件，走文件指针。
- 新路由：加入 `src/routes.ts` 的 `makePodRoutes` 数组，loopback-only，配 `tests/routes.test.ts` 用例。
- 新核心模块：注入式副作用（clock / store / fs / backend），配离线单测；不硬编码真实 CLI 调用。
- 提交信息按语义化前缀（feat/fix/docs/test/refactor + 范围 + CR/DoD/迁移项编号）。

## 测试注意

- `tests/orchestrator.test.ts` 的 FakeBackend：`start` 按任务 id 脚本化产出 progress/completion，
  完成信号必须在 microtask 回调（真实后端的进程退出语义）；重试走 `next`。
- Windows 专项：execFile 直跑 .exe；codex 二进制候选含 `~/.codex/.sandbox-bin/codex.exe`。
- 改动提交前跑 `npm run verify`；若只动测试/文档可只跑 `npm run typecheck` + `npm test`。
