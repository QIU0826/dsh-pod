# dsh-pod 前端重设计简报

> 交给 UI/产品设计 agent 的需求文档。只描述产品事实、数据与功能要求，**不预设视觉方向**（明暗、配色、风格、布局范式全部由设计者决定，现有界面可以整个推翻）。

## 1. 这是什么产品

**dsh-pod** 是一个跑在开发者本机的「多智能体协作驾驶舱」：

用户用一句话描述一个可验收的目标（例如"给 README 增加安装章节并通过独立审查"），系统会：

1. 按用户预先配置的「员工名册」组建一个 AI agent 团队（每个 agent 是一个真实的 CLI 编码助手进程：Claude Code / Codex / OpenCode 等）
2. 若团队里有 planner 角色，先把目标分解成任务 DAG（依赖图）
3. 把任务派给合适的 agent 并行执行，各自在独立 git worktree 里改代码
4. 关键改动（合并回主分支）必须等待用户**人工审批**
5. agent 执行中如果有疑问，会向用户**提问**，用户点选答复
6. 全程有预算（美元/Token）熔断、账本、事件审计

单用户、本机使用（浏览器访问 127.0.0.1），桌面浏览器优先，中文界面。

## 2. 领域对象（UI 必须能呈现的概念）

| 对象 | 字段/含义 |
|---|---|
| **Mission**（一次任务委托） | goal（用户那句话）、status：planning / running / awaiting_approval / awaiting_dispatch / paused / done / aborted / escalated、budget_usd、已花费（tokens + 折算美元） |
| **Task**（任务，组成 DAG） | id（如 T-1）、title、type：implement / review / test / doc / research / plan、status：ready / dispatched / running / blocked / done / escalated、depends_on（依赖的其他任务 id）、attempts（重试次数）、commit_sha、fault（最近错误） |
| **Agent / 员工（槽位）** | id（S-1..n）、vendor：claude / codex / opencode / dsh、role：planner / implementer / reviewer / tester / researcher / docs、capabilities（能力标签：规划/编码/审查/测试/文档/调研）、status：idle / working / dispatched / waiting_approval / error / rate_limited / stopped、ctx_usage_pct（上下文占用） |
| **事件流** | 全量审计事件，含：mission_created、plan_delegation（交给 planner）、plan_expanded（DAG 就绪）、task_dispatched / task_started / task_done / task_blocked / task_reassigned / task_escalated、worker_progress（agent 的流式文本输出，type=text 的即聊天消息）、**task_question**（agent 提问）、approval_requested、steer_queued、budget 告警、mission 终态等 |
| **审批卡** | id、patch summary、worktree 路径；动作：批准合并 / 驳回（可填原因、可选"记住规则"） |
| **问题卡**（task_question 事件） | questions（问题列表）、summary；用户三选一：按你的判断继续 / 我来补充说明（文字）/ 保持转人工 |
| **账本** | 每条：slot、task、model、tokens_in/out、折算美元、时间 |
| **设置**（localStorage） | 目标仓库路径（本地 git 仓库，**点选本地目录**，已有点选器与后端接口）、预算上限、默认员工名册（**点选构建**：员工类型→职责→能力，无打字）、事件密度、启动默认视图等 |

## 3. 核心用户流程

1. **发射**：在设置里配好（仓库路径、预算、名册）→ 在对话框输入目标 → 组队发射。发射后 mission 进入 planning（若有 planner）或直接分配任务
2. **盯执行**：看 agent 消息流（对话形态）或任务看板（5 列：待办/执行中/受阻/完成/转人工）/ 任务 DAG 拓扑图；侧栏有预算消耗
3. **被要求介入**（UI 的关键责任，不能错过）：
   - agent 提问 → 选项卡/弹窗，点选答复
   - 合并审批 → 批准/驳回
   - 任务受阻/转人工 → 用户裁决后可恢复
4. **中途干预**：给某个 agent 发指令（steer，下次派单时注入）、手动派发、中止 mission
5. **多轮**：一个 mission 结束（完成/中止）后可以开下一个

## 4. 已知问题（用户明确反馈，重设计必须解决）

1. **没有「新建对话」／会话概念**（用户点名）：目前整个应用同时只有一个 active mission，对话流只是当前 mission 的事件渲染，mission 结束后历史无处安放，也不能像聊天产品那样开新会话、翻旧会话。重设计需要把「会话」作为一等概念：会话列表、新建会话、切换/回看历史会话（历史会话里的对话流、任务、账本可回看）。
   - ⚠ 后端现状：只暴露当前 mission 的 status/events，没有「历史 mission 列表 / 按 mission 取事件」的 API。设计时可以假设这些数据存在（磁盘上事件已按 mission 落盘），后端会按设计补接口。
2. **整体太简陋**（用户原话）：需要完整的视觉与信息架构升级，而不是局部修补。

## 5. 可用数据接口（同源 REST + SSE，全部 loopback，2s 轮询 + 事件流）

- `GET /api/dsh-pod/status` → mission / tasks / slots / pending_approvals / ledger / experiments
- `GET /api/dsh-pod/events?after=ts`、`GET /api/dsh-pod/events/stream`（SSE，先 replay 后增量）
- `POST /api/dsh-pod/launch`（goal + cwd + budget + slots）
- `POST /api/dsh-pod/steer`（slot_id + instruction）
- `POST /api/dsh-pod/approve` / `deny`（审批）
- `POST /api/dsh-pod/dispatch`（手动派发）/ `abort`（中止）
- `POST /api/dsh-pod/resolve`（转人工任务的裁决）
- `POST /api/dsh-pod/plan`（规划层 list/add/replan）
- `GET /api/dsh-pod/fs/browse?path=`（本地目录点选数据源：目录名列表、盘符、主目录）

## 6. 技术约束（客观事实，非设计偏好）

- 前端：React 18，**createElement 写法（无 JSX）**、无 CSS 框架、无图标库；样式是运行时注入的一份 CSS 字符串（`src/web/console-css.ts`），设计稿需可落成纯 CSS 类
- 同一套 UI 挂载在两个宿主：① 独立浏览器页（standalone server 直出 HTML）；② DSH 桌面端内嵌面板。均中文
- 实时性：status 2s 轮询 + 事件 SSE；agent 文本消息是事件流里的增量文本
- 设置存 localStorage；不引入后端账号体系

## 7. 代码位置（供设计 agent 对照现状）

仓库：`dsh-pod-audit/`（本地克隆，端口 3930 的 demo 正在跑）

- `src/web/PodPanel.ts` — 壳：侧栏导航（对话/看板/设置）+ 视图切换 + 设置页（目录点选器、名册点选构建器）
- `src/web/chat-view.ts` — 对话视图：事件流→对话条目、问题弹窗、composer
- `src/web/console-css.ts` — 全部样式（单一 CSS 字符串）
- `src/web/api.ts` — 全部接口客户端与类型
- `src/web/TopologyCanvas.ts` — 任务 DAG 拓扑/画布（SVG）
- `src/routes.ts` — 全部 HTTP 路由（接口行为的事实源）

## 8. 设计任务

对整个控制台做信息架构 + 交互 + 视觉的重新设计，覆盖第 3 节全部流程，必须解决第 4 节两个问题（新建对话/会话历史是最高优先级缺失功能）。交付物建议：信息架构图 + 关键屏（对话/会话列表/看板/设置/审批与问答）的布局与视觉方案 + 组件清单与状态定义（可映射到现有数据字段）。
