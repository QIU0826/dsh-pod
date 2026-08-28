# dsh-pod 独立控制台开发计划（standalone 模式，CR-38）

> 目标：对标 block/berd（Tauri+React 桌面壳控 Goose）——dsh-pod 以**独立 Web 控制台**运行，
> 浏览器打开即管理全部 harness（claude/codex/ark/opencode/dsh-subagent），不再依赖 DSH 宿主注入。
> 本文档为执行基线；完成一项勾一项，偏差如实记录。

## 现有资产盘点（2026-08-28，复用度评估）

| 层 | 文件 | 规模 | DSH 耦合 | 独立化成本 |
|---|---|---|---|---|
| core 域层 | store/mission/task-machine/approvals/ledger/dispatcher/orchestrator/watchdog/verifier/memory/cron/apply-patch/backends-lock/permission-rules 等 22 文件 | ~6000 行 | **零**（纯注入式，无 dsh-* import） | 零 |
| workers 后端 | claude/codex/ark/opencode headless + dsh-subagent + remote/satellite | ~1500 行 | 仅 dsh-subagent 依赖宿主 agent 抽象（独立模式不注册） | 零 |
| HTTP API | routes.ts（12 条 exact 路由：status/events/events.stream(SSE)/launch/steer/approve/deny/dispatch/resolve/rules/abort/ping/assets） | 528 行 | 仅 `WebRoute` type import（编译期擦除）；handler 为纯 (req,res) | 极小 |
| MCP HTTP | mcp-http.ts | — | 零依赖 | 零 |
| UI | PodPanel(497)+TopologyCanvas(248)+api(143)+event-stream(55) | ~1184 | PodPanel 零 props 零 dsh 值依赖 ✓；client.ts 深耦合宿主槽位（弃用） | 中（新 standalone 入口） |
| 插件壳 | plugin.ts(215)+pod-tools.ts(641) | 857 | 纯宿主面（inject/defineTool） | 独立模式不带走（HTTP API 已覆盖 pod_* 能力） |
| PodService 装配 | plugin.ts 的 createPodRuntime | — | **零 dsh 依赖**（搬 core 即解耦） | 极小 |
| Commander | commander.ts | 66 | **dsh-agent/llm/session/cordis 值导入**（pod-service 静态 import） | 见 P2 决策 |

## 阶段

### P0 独立 server 入口（约 0.5–1 天）—— ✅ 完成（2026-08-28）
- [x] `src/core/pod-runtime.ts`：`createPodRuntime`/`PodRuntime` 自 plugin.ts 搬入（零 dsh 依赖域）；plugin.ts re-export 保持兼容
- [x] `src/standalone/server.ts`：node:http + makePodRoutes 12 路由 exact 分发 + 静态托管 + guard 守卫（loopback-only 默认 + 非 loopback 必须 Bearer token，CR-29 纪律）
  - 偏差：路由清单无独立 /ping（宿主健康路由属 plugin.ts），测试以 `/api/dsh-pod/status` 为健康探针
- [x] `src/web/standalone.ts`：createRoot(#root) 直挂 PodPanel（无 DSH 槽位探测）
- [x] 壳页——偏差：不做独立 index.html 文件，改为 `src/web/standalone-shell.ts` 导出 HTML 字符串常量（server 内嵌返回，单一事实源防漂移）
- [x] tsdown 三入口：client（宿主 CJS 包装，原样）/ standalone（UI，**esm 非 iife**，`deps.alwaysBundle: [/^react/, /^scheduler/]` 全量内联——浏览器解析不了 bare import）/ standalone-server（node esm bin，shebang 取自 cli.ts 首行，deps 外置保 better-sqlite3 原生模块）；package.json `bin` + `serve` script；CLI 参数解析在 `src/standalone/cli.ts`（--port/--host/--data-dir/--token/--opencode-bin/--help）
- [x] tests/standalone.test.ts：13 用例全绿（壳 HTML/随机端口回填/status 走真 SQLite runtime/404 矩阵/静态托管含缺失提示/未监听 close 不抛/guard 六例/CLI 解析含非法值）
- [x] 验收（自动化部分）：`node dist/standalone-server.js --port 0` 真启动 → 壳 200 + standalone.js 804KB 服务 + status mission:null + 404 + --help + token 守卫拒绝（exit 2）。**浏览器人工过面板 + launch 真实 mission 走完审批 → 移入 P1 前人工验收**

### P1 独立 UI 打磨（0.5–1 天）
- [ ] PodPanel 独立渲染视觉核验（DSH CSS 变量缺失的降级样式）
- [ ] 事件流 SSE 断线重连在独立页的表现核验
- [ ] README「独立运行」章节（与 DSH 插件形态并列）

### P2 Commander 决策（二选一）
- A（零开发，v0 先行）：独立模式手动驱动——mission 经 HTTP API 直传 plan，orchestrator 手动派发/审批全可用；
  pod_launch 的自动编排（commander）在独立模式返回明确错误提示「需 DSH 宿主」
- B（+1–2 天）：CommanderSession 抽接口，新增 headless 实现（claude -p 当编排 LLM：
  goal → 生成 plan JSON → orchestrator），对齐 berd 的对话式驱动
- **建议**：A 先上线，B 按需跟进

### P3 打磨（0.5–1 天）
- [ ] serve CLI 参数完善（--open 自动开浏览器、--host、--token 强制条件）
- [ ] 多 mission 并存 UI 核验（mission 切换/看板刷新）
- [ ] Windows 实测（路径/防火墙弹窗）

### 后续（不阻塞独立化）
- [ ] Tauri 桌面壳（berd 同款形态；Web loopback 已满足核心诉求，二期评估）
- [ ] Grok/Kimi/ACP adapter（Berd-G 管线照 opencode 首验模式）
- [ ] 记忆评测扩 30+ 对（当前 10 对，符号检验 p≈0.17 方向性证据）

## 难点与解法

| 难点 | 解法 | 状态 |
|---|---|---|
| routes.ts 的 WebRoute 类型来自宿主包 | type-only import 编译期擦除；运行时 handler 是纯 (req,res)——独立 server 直接按 kind:'exact' 分发 | 已验证（读源确认） |
| PodService 构造拖入 commander→dsh-* 运行时依赖 | createPodRuntime 搬 core（零依赖）；PodService 的 commanderLauncher 本就是可选注入（不注入=手动派发模式） | 已验证（读源确认） |
| client.js 是 DSH ModuleLoader 包装格式，独立页无法加载 | 新 standalone 入口（esbuild iife 内联 react），不复用 client.js | P0 实现 |
| PodPanel 的 DSH 槽位挂载（data-pane 选择器） | standalone.ts 直接 createRoot(#root)，绕过槽位探测 | P1 核验 |
| opencode/claude worker 的 git cwd 逃逸（CR-37 补记：4f7cca7 污染事件） | eval 脚本 worktree add 失败即 fail-fast（不 fallback cwd）；adapter --dir 显式（已修） | 已修复（opencode）/待加断言（eval 脚本） |

## 不变式（沿方案书）
审批/合并只走三入口；事件流磁盘唯一事实源；路径白名单；预算熔断；loopback-only 默认——全部在 core/routes 层，独立模式自动继承。