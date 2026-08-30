# 架构总览 —— dsh-pod 多 agent 编排

> 本文回答两个问题：**一个 agent 是什么、怎么工作**（单 agent 架构）；**多个 agent 如何被组织、
> 协作与制衡**（多 agent 编排架构）。事实源是代码，本文是导览。

## 0. 模式矩阵

| 模式 | 启动 | agent 是什么 | 用途 |
|---|---|---|---|
| **真实模式**（默认） | `node dist/standalone-server.js --port 3930 --data-dir <dir>` | 真实 CLI 进程（Claude Code / Codex CLI / OpenCode），真实 LLM、真实提交、真实花费 | 生产/真实验证 |
| 演示模式 | 加 `--demo` | 脚本化 DemoBackend（固定剧本，零成本） | 管线演示与 UI 测试 |

UI 顶部有琥珀色「演示模式」横幅时即为后者；演示模式不执行你的真实目标。

**真实模式的环境要求**（LLM 凭据）：headless CLI 需要可用的 API 凭据才能调用 LLM——
`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`（或 CLI 登录态）。凭据失效的症状：
任务反复 `blocked(crash)` / `idle_timeout`，事件里可见 CLI 反复 api_retry。
失败根因现已直达 UI（stderr 尾随随 error_detail 附在任务故障信息里）。
排障顺序：`claude -p "hi"` 手动验证 → 检查 `~/.claude/settings.json` 的 env 块与
终端环境变量是否为有效 token → 更新后重启控制台。

## 1. 单 agent 架构（一个 Agent = 什么）

```
AgentSlot（员工槽位，S-1..n）
  ├─ 身份：vendor（claude/codex/opencode/dsh/ark）+ role（planner/implementer/…）+
  │        capabilities（能力标签）+ avatar（形象）
  ├─ 会话：session_tier（claude=per-mission 持久会话；codex 等=transient 瞬时）
  ├─ 隔离：独立 git worktree（<repo>/.pod-worktrees/<mission>-S-n），互不可见
  ├─ 状态机：idle → dispatched → working → (done|blocked|escalated)
  └─ 计量：tokens_in/out（账本权威列）、ctx_usage_pct（档位 C 自动重置判定）

WorkerBackend（vendor adapter，统一协议）
  ├─ detect()   安装/鉴权/模型/版本探测（launch 前版本锁校验）
  ├─ start()    以 headless 方式拉起 CLI 进程：
  │     claude -p <spec> --output-format stream-json --include-partial-messages --verbose
  │     逐行解析 stream-json：assistant 文本块 → kind:'text' 进度（流式）
  │     工具调用 → kind:'tool_call'；退出码 + 结构化 MISSION_REPORT 判定完成
  ├─ kill()     进程树终止（Windows taskkill /T /F；POSIX 进程组 SIGTERM）
  └─ 协议元数据 protocol（family/capabilities），新 vendor = 新 adapter，编排层零改动
```

要点：**agent 不是聊天机器人**。每个 agent 是「一个带独立文件系统视角（worktree）、
独立会话、被任务规格（spec）驱动、以结构化报告（MISSION_REPORT）交付的 CLI 进程」。
它不能直接合并任何东西——写盘前确认是引擎的硬边界。

## 2. 多 agent 编排架构（谁在指挥谁）

```
用户（对话视图输入目标）
   │  POST /launch（goal + cwd + budget + roster）
   ▼
PodService（宿主门面：版本锁 / 单活跃会话 / 原子发射）
   │
   ▼
MissionOrchestrator（编排器，每会话一个实例）
   │
   ├─ ①规划（任务拆解）
   │    roster 含 planner → createPlannerTask：目标交给 planner agent，
   │    LLM 提议任务 DAG（PlanProposal）→ 【代码裁决】validatePlanProposal
   │    （id 白名单/依赖存在/无环/能力覆盖）→ 通过才 expand 落盘，绝不落脏任务图
   │    无 planner → 默认「实现 + 独立审查」两步链
   │
   ├─ ②派发（驱动循环）
   │    driveLoop：每轮填满 maxParallel（默认 2，可调 ≤8）
   │    readyTasks（依赖就绪 + 重试期已到）→ routeTask 按 能力标签 + Ledger 历史
   │    成功率打分选槽 → 协商要约（§2.5 任务生命周期：健康/预算真实裁决，谢绝换人）
   │    → dispatchTask：规格增强（审查者只拿 diff+规格最小上下文；排队 steer 指令必带）
   │    → backend.start()（流式进度实时落事件）
   │
   ├─ ③质量门（完成裁决，LLM 提议、代码裁决）
   │    implement/test 的 done 报告必须通过 Verifier：
   │      commit 存在 + 报告 schema 完整 + files_changed 在白名单内 + 测试证据存在
   │      + 叙事与产物一致（mismatch → 直接转人工）
   │    失败 → 指数退避重试（429 不计次）→ attempts≥3 转人工
   │    need_clarify → 软失败 + task_question 事件（UI 弹问答卡）
   │
   ├─ ④审批门（合并前硬闸）
   │    全部实现任务 done → buildApprovalRequest（仅含有 commit 的产物任务）
   │    → 审批卡持久化（重启可恢复）→ mission awaiting_approval
   │    批准 → apply_patch 单入口合并回主分支（真实 git merge）
   │    驳回 → 带原因 steer 回实现者重跑
   │
   ├─ ⑤制衡与兜底
   │    Watchdog：task-idle（无流式输出）/ task-wall-clock（超时）→ 杀进程+故障化
   │    停摆兜底：active 任务 3min 无任何落盘进展（事件或状态）→ 重派
   │    预算双闸：token 上限（主）+ 美元上限；派发前预估短路；超限 pause
   │    僵尸自愈：活跃会话无编排器归属 → 中止释放锁（发射原子性兜底）
   │
   └─ ⑥可观测
        全量事件落盘（mission 维度）：plan_delegation / task_dispatched（含任务摘要）/
        worker_progress（流式文本）/ agent_relay（agent 间传信：审查上下文注入等）/
        task_question / approval_* / merge_completed / mission_done
        → SSE + HTTP 轮询（id 精确游标，同毫秒不丢）→ 对话流渲染
```

### 2.5 任务生命周期状态机（A2A 对齐）

```
 ● 创建任务
 ▼
 ready ──开始协商──▶ negotiating ──接受──▶ accepted ──派发──▶ dispatched → running
                       │                                            │
                       │拒绝（换人再协商）                            │暂停（杀进程，不计故障）
                       ▼                                            ▼
                    （回 ready）                                  paused ──恢复──▶ ready
                       │
                       │全员谢绝
                       ▼
                    rejected（终态，转人工/重规划）
 running ──▶ done（Completed） / blocked（Failed·可重试） / escalated（Failed·转人工）
```

**协商是真实裁决，不是仪式。** 任务 offer 给 agent 后，接受/拒绝由代码依据
agent 的实际状况判定：

- **接受基础** = vendor 健康（CLI 已安装 + 凭据有效，`backend.detect()`，结论
  TTL 10 分钟缓存，`auth_expired` 故障即刻失效重探）+ 剩余预算 ≥ 任务预估成本；
- **谢绝换人（failover）**：凭据失效/未安装的 agent 谢绝要约（事件留痕：谁、
  为什么），编排器把该槽位排除后重新路由协商——**死凭据在派发前拦截，不再烧
  一轮运行后才发现**；
- **全员谢绝** → `rejected` 终态 → 转人工/重规划（与 escalated 同列 needs_human）；
- **env 凭据兜底**：`claude auth status` 对 env-token 中转形态（ANTHROPIC_BASE_URL
  + token）可能如实报「未登录」但实际可用——环境里存在该 vendor 凭据时不得
  以「CLI 未登录」谢绝（`credentialHint` 注入，core 不读 process.env）。

**任务级暂停/恢复**：`POST /api/dsh-pod/task/pause|resume`。暂停先终止在途
进程再迁移（用户行为不是故障，不消费 attempts、killed 退出被吞掉）；恢复 =
`paused → ready` 重新走协商（可能换 agent，规格上下文由 Context Builder 完整重建）。
看板卡片与上下文抽屉都有暂停/恢复入口；对话流有 🤝 协商行与 ⏸/▶️ 暂停恢复行。

状态机全部迁移走 `task-machine.ts` 显式入口（offer/accept/rejectBySlot/
rejectTerminal/pause/resume/dispatch/start/report/fail/escalate），非法迁移抛
`InvalidTransitionError`——LLM 提议、代码裁决的同一纪律。

## 3. 协作方式（agent 之间不直接对话）

agent 之间**不点对点通信**——所有协作经由编排器以「规格注入 + 事件审计」进行：

1. **目标 → DAG**：planner 产出的任务图经代码裁决后成为所有 agent 的共享事实；
2. **实现 → 审查**：审查任务的 spec 由宿主注入被审任务的 diff 区间与产物摘要
   （最小上下文原则，审查者无需仓库权限），并以 `agent_relay` 事件留痕（对话可见）；
3. **人工 → agent**：用户答复/指令经 steer 队列在下一次派单时注入规格；
4. **交接**：任务换人（reassign）携带进度/产物/指令四件套上下文。

这是刻意选择：点对点自由对话不可审计、不可重放、不可预算化；编排器居中代理让
每一条跨 agent 信息都落盘、可视（对话流 A→B 行）、可回放。

## 4. 流式输出链路

```
CLI 进程（stream-json 逐行）
  → WorkerBackend.onProgress（text/tool_call 增量）
  → emitWorkerProgress（reply_id+seq 落盘，store.appendEvent）
  → SSE /api/dsh-pod/events/stream（id 精确游标 replay+增量）＋ /events 轮询兜底
  → 前端按（agent × 任务）聚合为单一气泡增量追加（打字光标，完成即止）
```

### 4.5 A2A 对外协议面（wire 协议）

Pod 以 A2A（Agent-to-Agent）风格对外暴露能力，外部 agent / 程序可以像调用一个
agent 一样驱动整个座舱：

```
外部 Client                    dsh-pod（A2A Server）
   │ ①发现  GET /.well-known/agent-card
   │ ◀──── Agent Card（名册即技能表，loopback NoAuth）
   │
   │ ②受理  POST /a2a/sendMessage
   │        { message: { parts: [{kind:'text', text: 目标}] },
   │          configuration: { cwd, parallel?, budget_usd?, slots? } }
   │ ◀──── A2A Task 快照（id=mission，state=submitted/working）
   │
   │ ③流式  POST /a2a/sendMessageStream（同体）
   │ ◀──── SSE：首帧 Task 快照 → status-update / artifact-update 增量 → 终态收口
   │        （🤝 协商、📦 派发、流式文本 ⚒ 工具、✅ 完成、input-required 待审批）
   │
   └─ 也可走 JSON-RPC 2.0：POST /a2a { method: 'message/send' | 'message/stream' }
```

- **任务粒度映射**：A2A Task = mission（一次 sendMessage = 一个目标）；座舱内部
  的单个 agent 任务（T-1/T-2…）作为 artifact 增量流出——外部看到的是「一个
  多 agent 作为一个 agent」；
- **状态映射**（`src/core/a2a.ts`，纯函数）：planning/running→working；
  awaiting_approval/paused→input-required；done→completed；denied→rejected；
  aborted→canceled；预算短路→failed(final)；
- **纪律**：loopback-only（与既有 HTTP 面同源信任边界）；凭据/内部路径不出
  协议面（securitySchemes 显式 NoAuth）；未知事件不映射不编造（fail-closed）。

## 5. 目录导览

| 路径 | 职责 |
|---|---|
| `src/core/orchestrator.ts` | 编排器：规划/派发/质量门/审批/兜底（本文 §2） |
| `src/core/task-machine.ts` `mission.ts` | 任务/会话状态机（非法迁移 fail-fast） |
| `src/core/planner.ts` `report-schema.ts` | 规划提案裁决；MISSION_REPORT 契约（单一事实源） |
| `src/core/verifier.ts` | 产物验证（commit/路径白名单/测试证据/叙事一致） |
| `src/core/approvals.ts` `apply-patch.ts` | 审批卡（持久化/过期）+ 合并单入口 |
| `src/core/ledger.ts` | 账本（总量/按员工/按模型/按阶段，by_stage） |
| `src/workers/*` | vendor adapters（claude/codex/opencode/ark/remote/demo） |
| `src/core/watchdog.ts` | 空闲/墙钟看门狗 |
| `src/web/*` | 控制台 UI（对话/看板/DAG/审批/设置/会话列表） |
| `src/routes.ts` `src/pod-service.ts` | HTTP 面 + 宿主门面 |
