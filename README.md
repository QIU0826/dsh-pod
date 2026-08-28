# dsh-pod（Pod 鲸群）

> **在 DSH Web UI 里一键组队、看得见、管得住的多智能体驾驶舱。**
> 把本机已登录的 DSH / Claude Code / Codex 组成一个团队，各干各擅长的活、互相交接任务，
> 全程可视化，关键动作由人把关。驾驶舱是产品本体；多 agent 是按需启用的引擎。

开工基线：[DSH-Pod-项目方案书-v2.0.md](../../DSH-Pod-项目方案书-v2.0.md)（含 CR-01 设计变更记录）

## 当前状态（v0.1.0 MVP 发布候选）

| 切片 | 状态 | 产物 |
|---|---|---|
| W0 仓库骨架 + 插件注册 + Store 决策（JSON 原子写回退） | ✅ | 本仓库；`/api/dsh-pod/ping` 健康路由 |
| W1 WorkerBackend 抽象 + codex 验证 + claude 打通 | ✅ 全链路 | `src/workers/claude-headless.ts` / `codex-headless.ts`；双后端跨进程会话连续性实证；claude stream-json/报告/故障分类；CR-02 见方案书 |
| W2 交接协议 + 状态机 + Verifier + **Commander 编排器 + 最小可演示链** | ✅ | `src/core/orchestrator.ts`；`scripts/demo-chain.mjs` 真实跑通「claude 实现 → codex 独立 review → 审批卡」（CR-03-6） |
| W3 Team Builder / W4 Canvas 两栏 / W5 审批+worktree+账本 / W6 Bake-off+DoD | ✅ | Team Builder 预设阵型（DoD-9）+ Mission Canvas 两栏（看板/事件流/steer/审批/手动模式）+ apply_patch 串行合并 + 账本双列 + **DoD 1–19 全部达成**（见 docs/DoD-1-14-核对表.md + 差距审计-vs-方案书.md） |
| Bake-off（DoD-10） | ✅ 已发布 | 10/10 运行留档；[汇总报告](reports/bakeoff/SUMMARY.md)（9 done + 1 负向样本，含负向结果公开） |

> 环境注意（CR-02/03）：claude 已切至 api.deepseek.com/anthropic + deepseek-v4-pro；本机 codex = ChatGPT 桌面应用内置（模型名留空走默认 gpt-5.6-sol；缺 code-mode host → 审查任务走宿主机 diff 注入）。多模型配置采用 ccswitch 共存方案（进程级 env 覆盖，不改全局 settings.json）。

## 安装与挂载（沿 dsh-ssh 实证模式，零源码改动）

```bash
# 依赖 DSH rc 线（npm 官方 SDK 包，只走公开扩展点）
npm install && npm run verify

# 挂载到你的 profile（link 或 npm 包均可）
dsh plugin --profile web add link:<本仓库路径>
```

## 开发

```bash
npm test            # 全量单测（vitest，无真实 CLI/网络依赖）
npm run test:coverage  # 覆盖率门禁（lines/functions/statements 80%，branches 75%）
npm run typecheck   # tsc 严格模式
npm run build       # tsc（宿主 dist/plugin.js）+ tsdown（浏览器 dist/client.js）
npm run verify      # typecheck → coverage → build 一条龙
$env:POD_LIVE_PREFLIGHT='1'; npx vitest run tests/preflight.live.test.ts  # 真实 CLI 冒烟（可选）
```

## 最小可演示链（demo-chain）

```bash
npm run build
node scripts/demo-chain.mjs                # 审查者默认 codex（跨厂商异构）
node scripts/demo-chain.mjs --reviewer claude   # 同厂商异槽独立 review（DoD-5 仍满足：S-1 ≠ S-2）
node scripts/demo-chain.mjs --repo <dir>   # 自定义靶场仓库
```

⚠️ `--reviewer` 仅支持 `claude|codex`，传入其他值会警告并回落为 `codex`。
真实跑通「实现 → 独立 review → 审批卡」链；合并（apply_patch）属 W5 切片，本演示止于审批卡。

### 写码型 bake-off（真实 LLM）

```bash
node scripts/bakeoff-claude.mjs                 # claude 实现+测试+commit → claude 独立 review → 审批卡
ARK_API_KEY=<key> node scripts/bakeoff-cross-vendor.mjs   # claude 实现 + ark 跨 vendor 审查
```

产物留档 `reports/`（不入库）；审批卡裁决后合并回主树：

```bash
node scripts/approve-merge-verify.mjs <storeDir> <approvalId> <missionId> [note]
```

## v0.3 联邦入口（MCP 双向 / 多机 satellite / 外部通道）

### MCP stdio（Claude Code / Codex 反向驱动 Pod）

```bash
claude mcp add pod -- node <本仓库路径>/scripts/mcp-bridge.mjs
# 之后在 Claude Code 里即可调用 pod_launch / pod_status / pod_approve 等 9 个工具
```

### MCP Streamable HTTP（远程访问，CR-29）

```bash
# 本机（loopback，无 token 也可）
node scripts/mcp-http-server.mjs                    # 127.0.0.1:3947/mcp
# 远程（必须带 token，否则拒绝启动 fail-closed）
POD_MCP_HOST=0.0.0.0 POD_MCP_TOKEN=<token> node scripts/mcp-http-server.mjs
# 客户端接入（Claude Code）：
claude mcp add --transport http pod http://<host>:3947/mcp --header "Authorization: Bearer <token>"
```

GET `/mcp` 返回健康检查；POST 走 MCP 协议（tools/list、tools/call）。

### 多机 satellite（CR-30）

```bash
# 卫星机（跑真实后端的机器）：
POD_SATELLITE_PORT=3950 POD_SATELLITE_TOKEN=<共享密钥> node scripts/satellite-worker.mjs
POD_SATELLITE_BACKEND=ark ARK_API_KEY=<key> node scripts/satellite-worker.mjs   # 换 ark 后端

# 本机（Pod 侧）：环境变量指向卫星，launch 的 slot vendor 即走远程
POD_SATELLITE_URL=http://<卫星机>:3950 POD_SATELLITE_VENDOR=claude POD_SATELLITE_TOKEN=<共享密钥>
```

线协议：`/detect` `/start` `/events` `/kill` `/health`；本机仍是状态机唯一裁决者（satellite 只执行任务）。
多机真机部署需 worktree 共享（见 [docs/satellite.md](docs/satellite.md) 边界）。

### 外部协作通道 webhook（Berd-H，CR-31）

```bash
node scripts/channel-http-server.mjs               # 默认 127.0.0.1:3960
# 入站指令 -> 映射 pod_* 工具面；出站仅白名单信号（代码/diff/凭据不出会话）
curl -X POST -H "content-type: application/json" -d '{"text":"看板状态"}' http://127.0.0.1:3960/inbound
curl -X POST -H "content-type: application/json" -d '{"text":"批准 A-1 合并"}' http://127.0.0.1:3960/inbound
```

支持指令：状态/暂停/恢复/中止/批准 A-n/驳回 A-n/给 S-n 指令：…；审批动作仍走 `pod_approve` 门（不绕过状态机）。

### Cron 定时触发（AgentScope-J，CR-34）

`src/core/cron.ts` 的 `CronScheduler`：tick 驱动（与 watchdog 同风格）、节流防抖、默认关闭（Berd-H 显式启用）、gate 守卫、触发历史审计；命令复用同一 pod_* 工具面。宿主接线（maintenanceTick 同源驱动）进行中。

## v0.2 切片（灰度项经 `~/.dsh/pod/experiments.json` 开关，默认全关；非灰度项默认生效）

| 切片 | 状态 | 说明 |
|---|---|---|
| 审批模式 2/3 经 experiments 灰度接入（Berd-E） | ✅ | `launch approvalMode` 校验：模式 2（交接确认，跨 agent 派活前弹卡）/ 模式 3（全自动，质量门通过即 done）需对应 `approval-mode-2`/`approval-mode-3` 开关开启；默认模式 1 行为不变；dispatch 卡经 `pod_approve` 分支裁决 |
| 记忆子系统 2.8.1（CR-07 / NOOA 借鉴） | ✅ | `src/core/memory.ts`：MemoryStore（`~/.dsh/pod/memory.json` 原子写）+ 类型化图谱（supports/contradicts/derived-from）+ 三工具 `pod_mem_write/query/correct` + 后台 reflection（合并/补边/剪枝，接入 maintenanceTick） |
| 记忆收益验收（方案书 258 行） | ✅ | `scripts/memory-eval.mjs`：同一任务集（项目特定经验）记忆组 vs 基线组 + LLM 自评三维。真实 Ark 运行：三维均值记忆 4.667 vs 基线 4.000（**+0.667**，准确性 +1.00）；负向记录：知识型问题平局（记忆价值在经验复用非百科）。Debrief 见 reports/memory-eval/ |
| Ledger→路由权重（历史成功率，2.7 节） | ✅ | `dispatcher.routeTask` 增 `slotSuccess` 因子：能力 > 负载 > 单任务成本 > 历史成功率（降序），无数据视为中性 0.5 不劣化；orchestrator 按槽位统计 done/(done+blocked+escalated) 注入 |
| 并行执行强化（双路+，4.3） | ✅ | `LaunchInput.parallel`（默认 2，clamp 1-8，pod_launch 可传）+ `run()` 用 `dispatchBatch` 每轮填满 maxParallel 而非单路派 1 即等；依赖链仍串行不破坏拓扑；FakeBackend 增 delayMs/并发峰值验证 peakActive |
| 任务中途换人正式化（4.3） | ✅ | `reassignTask`（kill 旧进程 + 交接四件套落盘 + 事件 task_reassigned 审计 + owner 转移 + 置 ready 由 dispatchBatch 重派）；`pod_reassign` 工具；done 终态/目标槽位不可用拒绝 |
| mission 崩溃恢复 UI 完善（4.3） | ✅ | PodPanel 顶栏加「恢复/需人工动作」横幅：跨重启重建（DoD-11 审批卡）/ 模式 2 派发门待放行 / paused 暂停提示；dist/client.ts 重建 |
| cross-review / bake-off 阵型强化（4.3） | ✅ | PodPanel capabilities 改多能力解析（`'编码 审查'`→`['编码','审查']`）+ 双实现互审预设（claude/codex 异构、审查者≠实现者，防 R5 假共识）；orchestrator 增互审端到端测试（双实现并行 + 交叉审查 + 质量门后进审批） |
| SQLite 迁移（R12/O12，替代 JSON 回退） | ✅ | `SqliteStore implements PodStore`（`~/.dsh/pod/pod.db`，WAL+事务，全表 JSON 行）；`openPodData` 默认 sqlite、better-sqlite3 加载失败回退 JSON；存量 `store.json`/`memory.json` → `pod.db` 非破坏迁移（旧文件转 `.migrated`）；MemoryStore 持久化抽 `MemoryPersistence` 接口（JSON/SQLite 双实现共享算法） |
| 拓扑动画 + 自由画布（4.3，Berd-E 灰度 `topology-animation`） | ✅ | `TopologyCanvas` 组件：任务 DAG 分层布局 + SVG 状态着色 + 运行中流动虚线/脉冲光晕动画；自由画布模式可拖拽节点 + 手画 DAG（添加/删除草稿节点）；status API 暴露 `depends_on` 与 `experiments.topology_animation`；PodPanel 视图切换（看板/拓扑动画/自由画布）。**开启**：`~/.dsh/pod/experiments.json` 加 `"topology-animation": true` |
| Canvas 第三栏·员工详情（W4/Berd-E 灰度 `canvas-third-column`） | ✅ | 员工状态灯（idle/working/waiting_approval/error/stopped/rate_limited 六色）+ 上下文占用 % + 账本（tokens 实测 + 等效美元 + 无价目标注）；status API 暴露 `canvas_third_column`。**开启**：`~/.dsh/pod/experiments.json` 加 `"canvas-third-column": true` |
| 桌面通知（CR-01-10 Should） | ✅ | `src/core/notifier.ts`：事件流提取需人工动作信号（审批待批/转人工/预算熔断/mission 暂停）→ 宿主送达；kind+mission 去重窗口（默认 5 分钟）防轮询刷屏；pod-service maintenanceTick 增量游标扫描 + `notified` 计数 |
| 暂停/恢复正式化（W4，方案书 113 行） | ✅ | `pod_pause`/`pod_resume` 工具：orchestrator 透传 mission 状态机（paused ↔ running/awaiting_approval，按 pending 审批卡决定恢复去向）；暂停后状态磁盘化，可恢复/复盘 |
| 审批卡「记住规则」入口（W4，AgentScope-B 显式化） | ✅ | `approvals.decide` 增 `rememberRule`（默认 true）；`pod_approve` 增 `remember_rule` 参数 + Canvas 审批卡 confirm 勾选；false 时批准不生成同类免弹卡规则（每次仍弹卡） |
| 协议适配器层前置（Berd-G，v0.3 排期） | ✅ | `WorkerBackend.protocol` 元数据（family/version/capabilities 四能力位）；claude/codex/dsh 三后端声明（codex usage_audit=false 诚实化）；[docs/adapters.md](docs/adapters.md) 新后端接入流程 + ACP 预留 |
| 工具级 middleware 审计钩子（AgentScope-E，Should） | ✅ | 每个 pod_* 工具 execute 包审计：调用后 `recordToolAudit`（`pod_tool_called` 事件，含 tool/ok/ms/error）；wrapTool 纯横切不改变返回值 |
| token 预算上限入口（2.3 节⑤） | ✅ | `budget_tokens` 全链路打通：pod_launch / routes / postLaunch / PodPanel 表单（留空=仅美元熔断）；orchestrator 双熔断（美元 + token）已有测试覆盖 |

## v0.3 设计预留（P2 方向性，不实现不改架构——方案书 934 行采纳原则）

| 方向 | 状态 | 设计文档 |
|---|---|---|
| MCP 双向暴露（方案书 594/797 行，CR-28 + CR-29） | ✅ stdio + Streamable HTTP | `src/mcp-server.ts`（pod_* 工具面 9 个映射 MCP tools，审批仍走三代码入口）；stdio：`scripts/mcp-bridge.mjs`（`claude mcp add pod -- node <path>/scripts/mcp-bridge.mjs`）；远程：`scripts/mcp-http-server.mjs`（默认 127.0.0.1:3947，POD_MCP_TOKEN 可选 Bearer，非 loopback 无 token 拒绝启动） |
| 多机 Satellite（方案书 594 行，CR-30） | ✅ 已实现 | `src/workers/remote-backend.ts`（RemoteBackend，protocol.family='remote'）+ `src/workers/satellite-server.ts`（卫星端点 /detect /start /events /kill /health + StubBackend）+ `scripts/satellite-worker.mjs`；[docs/satellite.md](docs/satellite.md)（多机真机部署仍属部署关注） |
| 外部协作通道（Berd-H / AgentScope-J，CR-31） | ✅ adapter 框架 | `src/core/channel.ts`（parseInstruction + handleChannelCommand + sanitizeOutboundSignal；审批不绕过门、凭据不出会话）+ `scripts/channel-http-server.mjs`（webhook 交付）；[docs/external-channels.md](docs/external-channels.md)（具体 IM vendor 集成仍后续） |

## 核心域层（src/core，全部纯逻辑 + 注入式副作用，可离线测试）

| 模块 | 职责 | 方案书落点 |
|---|---|---|
| `store.ts` | JSON + 原子写（tmp→bak→rename）+ 损坏恢复；SQLite 可替换接口 | 3.9/O12 |
| `task-machine.ts` | Task 状态机 + 故障分类全集 + 重试/退避/转人工；LLM 提议代码裁决 | 3.4 |
| `mission.ts` | Mission 状态机 + 质量门（独立 review 不可关）+ 跨重启恢复 | 3.4/DoD-5/11 |
| `approvals.ts` | 审批模式 1 持久化 + 超期 stale（CR-01-7） | 2.6 |
| `ledger.ts` | tokens 实测 + equiv_usd 标注估算（价目表版本号）+ 双熔断 | 2.7/D7 |
| `handoff.ts` | 交接四件套 + verify 清单 + 2×3 投递矩阵 | 2.5/3.2 |
| `verifier.ts` | 产物校验层（commit/parent/白名单/日志/叙事一致性），真实 git 集成测试 | 3.5/CR-01-3 |
| `dispatcher.ts` | 能力 > 负载 > 成本 路由 | 3.3 |
| `session-tiers.ts` | 三档会话生命周期 + 70% 重置摘要 | 3.2/CR-01-6 同源 |
| `watchdog.ts` | commander/任务空闲/墙钟，纯 tick 驱动，审批期挂起（CR-01-4） | 3.3/3.4 |
| `experiments.ts` | 灰度开关框架（~/.dsh/pod/experiments.json，默认关、fail-closed） | 3.4 Experiment/Berd-E |
| `memory.ts` | 长期记忆子系统（主动策展 + 图谱 + reflection） | 2.8.1/CR-07 |

`src/workers/`：preflight 环境探测（附录 D 十项，`.cmd` 包装器 shell 回退——Windows 专项）+ 进程注册表。
`src/charters/`：内置角色章程（数据不是代码，可被用户 `~/.dsh/pod/charters/` 覆盖）。

## 架构不变量（代码强制执行）

1. **LLM 提议，代码裁决**：状态迁移只走状态机入口，非法迁移抛 `INVALID_TRANSITION`；
2. **原始事件永不进 commander 上下文**：只进磁盘与 Canvas；
3. **审批/收集/合并只走三个代码入口**：`pod_approve` / `pod_collect` / `apply_patch`；
4. **员工进程是沙箱边界**：charter 约束 + `--allowedTools` 白名单 + 路径校验 hook，三道防线全开。

## 插件表面（v0.1 W0）

- 宿主：`src/plugin.ts` —— PodRuntime（Store/审批/账本）+ 系统提示播报 + `/api/dsh-pod/ping`；初始化失败只降级（503），绝不拖垮宿主（R6/R10）。
- 浏览器：`src/web/client.ts` —— locale 注册；Team Builder / Canvas 界面随 W3/W4 切片开放。
- `cordis.patch.yml`：bundle patch（`dsh.bundle.patch` manifest），`dsh plugin add` 一键挂载。

## Bake-off（DoD-10：有效性自证）

> 完整报告：[reports/bakeoff/SUMMARY.md](reports/bakeoff/SUMMARY.md)（10/10 运行原始数据 + 负向结果公开）
> 运行器：`scripts/bakeoff-all.mjs` / `bakeoff-run.mjs`；任务集：`tasks/bakeoff-tasks.json`

**一句话结论**：本批 5 任务 × 2 条件的实测数据**不支持「多 agent 无条件更强」**，支持 **cockpit-first** 定位——
小任务编排开销吞噬收益（成本 +37~95%）；medium-1 上 Pod 节省 13% wall-clock（成本 +74%）；
长任务（long-1）的独立 review 因本机 codex 审查者缺 code-mode host（命令执行不可用）转人工（负向样本，
见 NEGATIVE-FINDING-codex-code-mode-host.md）。「何时该用 Pod」的可执行阈值详见报告 §4。

## 许可证

MIT
