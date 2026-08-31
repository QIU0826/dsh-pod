# 借鉴决策：从 ReAct 到 Agent Teams（2026-08-31）

> 来源：微信文章《从 ReAct 到 Agent Teams》（阿里千问平台，2026-08-31）。
> 本文是**决策文档**，不是文章复述。所有「现状」结论均经对照 dsh-pod 真实代码核实
> （2026-08-31，commit `5da8bab` 前后）；只收录会影响「做/不做/怎么做」的事实。
> 完整机制逐条对照见第 2、3 节，动手项见第 5 节。

## 1. 文章核心（30 秒版）

1. **Agent 的本质**：ReAct 里能工程化的是「行动（工具）」与「观察（环境信息）」，不是「思考」。
2. **「上下文即记忆」**：模型无状态，不把经验持久化到外部 = 什么都没发生；RAG/记忆压缩/Skill 注入都是在替模型做「存经验、塞回有限 context window」。
3. **Leader-Worker 五大缺陷**：Leader 只是分发器不是兜底专家 / 任务直接拆分无讨论共识 / Worker 间完全隔离 / 无进度管理 / 方案变更无审查。
4. **两条消融警句**（作者实证）：9 个手工多 Agent 系统有 6 个不如单个 Agent；去掉协作机制后 20 个 Agent = 1 个 Agent。**多 Agent 价值 100% 来自协作机制**。
5. **七项机制**：Leader 能力差 / 启发式管理 / 讨论→共识→执行 / Worker 横向通信 / OKR 进度 / Mission/宗旨 / 集体复盘。
6. **措辞观察**（作者个体观察，非严格实验，需 A/B 验证）：命令式/负面暗示的任务描述激活保守、免责分布；探索式措辞激活高质量分布。

## 2. 文章机制 → dsh-pod 现状（已核实）

| 文章缺陷/机制 | dsh-pod 现状 | 核实依据 |
|---|---|---|
| Worker 完全隔离 | **部分踩中**：无横向自由通信，但有 commander 中介的结构化 handoff + review 的宿主注入 diff/spec/summary | `src/core/handoff.ts`（五件套交接）；`orchestrator.ts:606-617`（`MAX_REVIEW_DIFF_CHARS=40000` 分级注入，审查者「勿访问仓库」） |
| 规划自上而下、Worker 不参与 | **踩中**：planner 单向产出 + 代码裁决，无 worker feedback 环 | `planner.ts:114`「你不写实现、不读实现者工作区」；`validatePlanProposal` 全确定性裁决 |
| 经验停留个体、未成团队资产 | **踩中**：记忆按 `owner_slot_id` 归属，无 team 层 | `memory.ts:42` `MemoryWriteInput.owner_slot_id` 必填 |
| 命令式 prompt 激活保守分布 | **踩中且更尖锐**：见第 3 节 N1 | `planner.ts:107`「必须全部满足，违例=提案被拒」；`claude-headless.ts:192` `COMMIT_DISCIPLINE` |
| Leader 只是分发器 | **未踩中（部分具备）**：commander 是宿主内 agent（可思考/读文件），非纯分发器 | `src/commander.ts`（ctx.agents.create + pod_* 工具作用域） |
| 方案变更无审查 | **未踩中（dsh-pod 更强）**：代码裁决 + 独立 review 质量门 + 审批卡 | `validatePlanProposal`；`approvals.ts` |
| 无进度管理 | **未踩中（dsh-pod 更强）**：状态机 + 看板 + Watchdog | `task-machine.ts`；`watchdog.ts` |
| 无成本意识（文章全程不谈钱） | **未踩中（dsh-pod 领先）**：预算账本 + 熔断 + 归因 | `ledger.ts`；`budget_short_circuit` |

## 3. 三条新发现（影响实现范围，本次核实得出）

- **N1 — charter 文本运行时未加载**：`buildTaskPrompt` 的 `charterText` 参数全仓库无调用方传值
  （`claude-headless.ts:365` 只传 `{task, worktreePath}`）。`src/charters/*.md` 实际是设计模板，
  worker 真实 prompt = 一行 fallback + `task.spec` + `COMMIT_DISCIPLINE` + 报告 schema。
  → 措辞改造的目标面是三层：`buildPlannerSpec` / `buildTaskPrompt` 通用脚手架 / **planner 自由生成的 spec（不可控，最大块）**。
- **N2 — worker 进程默认无 `pod_mem_*` 工具**：standalone 默认 `allowedTools=['Read','Write','Edit','Bash','Glob','Grep']`
  （`server.ts:124`）；记忆的主动策展目前主要服务 commander（宿主 agent）。
  → 团队复盘落地前必须先定「谁写 team 记忆」通道。
- **N3 — `buildPlannerSpec` 未注入 preflight/仓库上下文**：planner 有 Read/Glob/Grep 能自己读仓库，
  但 prompt 只给 goal + 名册 + 规则 + 输出契约。启发式管理还缺「喂上下文」这一半。

## 4. 迁移决策（按收益排序）

### P0-A · 启发式 prompt 措辞（本次动手，改动小、可 bakeoff 验证）
- **分层原则**：安全纪律靠代码（三道防线：charter 约束 / `--allowedTools` 白名单 / 路径校验 hook），
  **不依赖 prompt**；故 prompt 措辞可放心软化。
- 措辞改动分两类：
  - **硬（保留契约原文）**：id/type/依赖无环/能力覆盖/implement-review 配对/任务数上限——
    这些是代码真实校验的契约，必须如实陈述；
  - **软（改框架与引导）**：去威胁框架（「必须全部满足，违例=提案被拒」→「产出经代码裁决校验：
    符合形状即可通过」）、正面示例引导（「宁可多拆一层，也别让任务读全库」）、
    诚实纪律改正向动作（「不确定项写进 assumptions 并注明待验证」而非「禁止编造」）。
- **验证**：复用 `scripts/memory-eval-code.mjs` 同款 A/B 配对框架（同构任务 × 新旧措辞），
  指标 done-rate / tokens / 提案质量；不拍脑袋。
- **注意**：planner 自由生成的 spec 是最大块且不可控——bakeoff 要测「同一 spec 不同措辞」，
  先把可控制的 `buildPlannerSpec` / `buildTaskPrompt` 脚手架改完，再评估是否值得给 spec 加软性包装。

### P0-B · Mission 宗旨锚点（已完成，2026-08-31）
- 现状：Mission 模型无 values 字段；`permission-rules.ts` 是 enforce 层（git push deny / apply_patch ask），不是价值观。
- 落地：`Mission.tenets?`（3-5 条、每条一行）；`pod_launch` 工具/MCP/HTTP 三面透传；
  **orchestrator 派发时前置并入 spec**（与 review/steer 注入同一条路径，自动进 Context Builder 的
  `task_context` 事件，事件带 `tenets_injected` 标注）。
- 设计决策（避开 N1 死参数教训）：**不**给 `buildTaskPrompt` 加 `tenets` 参数——
  经 orchestrator 并入 spec 即可零后端接口改动，且注入内容自动进审计面。
- 未做：Web 启动表单的 tenets 输入（改 src/web/* 需重建 + GUI 验证，留待下一轮）。

### P1 · Worker feedback 轻量环（已完成，2026-08-31）
- 只在 `validatePlanProposal` 返回 `{ok:false}` 时按错误类别分流（`classifyPlanErrors`）：
  - **语义类（capability gap）** → 把执行侧约束写回失败任务 spec（`buildCapabilityFeedback`：
    能力缺口 + 名册实际能力），自动重试即带反馈——修掉「silent_failure 按原 spec 无反馈重试」的真 bug；
  - **结构类（id 冲突/环/自依赖/规模）** → 不写回，直接重试（纯形状问题无需反馈）。
- `plan_rejected` 事件新增 `semantic/structural/feedback_applied` 标注（审计）。
- **诚实范围**：语义类当前只含能力缺口（spec 含糊无代码级判定，spec 只要求非空）；
  反馈来自名册声明能力（确定性、零额外 LLM 调用）——真正的 LLM worker 咨询（执行侧约束超出声明标签）
  记为 v2 扩展，本批不烧钱（衔接 token 审计与措辞 bakeoff 结论）。

### P1 · Team 复盘资产（已完成，2026-08-31）
- 决策落地：team 归属用 `team:<mission_id>` 作为 owner（`teamOwnerId`/`isTeamOwner` 帮手，
  `owner_slot_id` 是不透明键，与槽位记录天然隔离）；commander（宿主 agent）经 `pod_mem_write`
  主动策展写入，工具描述已标注团队约定。
- 守住 CR-07-4：团队记录是 commander 主动策展输入，不做 mission 结束自动摘要。
- **未做（N2 相关，独立缺口）**：worker 进程默认无 `pod_mem_*` 工具，团队记忆的运行时注入
  仍不在 worker prompt 里——写/查走 commander，注入留待后续（见 BAKEOFF 6 节结论：先别为措辞烧钱）。

### P2 · 两项暂缓
- **Worker 横向 P2P**：突破沙箱边界 + context 指数爆炸（文章自认学术空白）。
  优先打磨已有的「受控结构化信息流」（review 宿主注入），暂不开自由通信。
- **OKR 量化 + Leader 能力差**：方向性建议；`slotSuccess`（dispatcher 已用）与 ledger 数据
  是现成底座，属增量非新架构。

## 5. 实施清单

- [x] 本决策文档落盘（2026-08-31）
- [x] P0-A 第一版：`buildPlannerSpec` 措辞软化（威胁框架 → 契约事实 + 正面引导；诚实纪律正向化）
- [x] P0-A 第二版：`buildTaskPrompt` 通用脚手架（fallback 行 / `COMMIT_DISCIPLINE`）软化
- [x] P0-B：`Mission.tenets` 字段 + 工具/MCP/HTTP 透传 + orchestrator 派发注入（`task_context` 标注）
- [x] P0-B 补充：Web tenets 入口（设置页「团队宗旨」卡片 + launch 透传 + 上下文查看器 `tenets_injected` 标记）
- [x] Web 第一批：tenets 入口 + 上下文查看器标记
- [x] Web 第二批：产物查看面（`Task` 落盘 `test_result/test_evidence/decisions/blockers` + 上下文模态产物区块）
- [x] Web 第三批：看板「重规划」按钮 + 记忆面板「写入表单 / owner 筛选（含 team:）」
- [x] P0-A bakeoff：`scripts/wording-eval.mjs`（自包含 old/new 措辞变体 + 交替指派）。5 对全 done/pass；
      符号检验不显著（wall 3/5、tokens 4/5，p>0.18）——软化无回归但无显著收益，不追加 spec 包装投入。
      详见 `docs/BAKEOFF.md` 第 6 节
- [x] P1：feedback 分流挂 `validatePlanProposal` 错误类别（语义类写回执行侧约束；v2 才做 LLM worker 咨询）
- [x] P1：team 级记忆（`team:<mission_id>` 归属 + commander 经 `pod_mem_write` 收口）

## 6. 决策记录

| 项 | 决策 | 理由 | 挂点 |
|---|---|---|---|
| 措辞软化 | 做（本次起步） | 安全靠代码不靠 prompt；可 A/B | `buildPlannerSpec` → `buildTaskPrompt` |
| Mission 宗旨 | 做（下一轮） | 语义锚点，与档位刹车同类 | Mission.tenets + 注入口 |
| Worker feedback | 做（错误类别分流） | 省 token，接审计结论 | `validatePlanProposal` |
| Team 复盘 | 做（commander 收口） | 守 CR-07-4 | team 粒度记忆 |
| Worker P2P | 暂缓 | 沙箱 + context 爆炸 | — |
| OKR 量化 | 暂缓 | 现成底座，增量做 | ledger/slotSuccess |
