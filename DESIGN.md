# Design — 控制台（深色任务控制台）

<!-- 记录自建成后的代码（ground truth over intention）；单一事实源为 src/web/console-css.ts -->

## 世界

深色任务控制台（seed: pod-dark-ops-2026-08-29）：挂在墙上的驾驶舱，不是 SaaS 仪表盘。
高饱和度只属于语义状态；层级由 1px 冷色描边与地面明度承担，不用阴影。

## Token

- 地面：`--bg #0B0E14` → 面板 `--bg-panel #151B29` → 凹陷 `--bg-inset #0D1119`；描边 `--border #232B3D` / `--border-soft #1A2130`
- 文字：`--text #E7ECF5` / `--text-2 #9AA3B8` / `--text-3 #7A8499`（深底全部 ≥4.5:1）
- 语义状态（页面上唯一的高饱和来源）：run `#2FD08C` · info `#46B4FF` · wait `#F5A623` · error `#F5555F` · block `#FF8A4C` · done `#3AC98F` · idle `#6B7590` · plan `#B48CFF`
- 动作色：`--accent #5B8DFF`（primary 按钮/选中态/focus ring），危险 = error 色淡底
- 字体：UI 一律系统栈（中文 Microsoft YaHei 兜底）；数据（id/时间/token/美元/名册语法）一律 `ui-monospace` 等宽

## 组件语法

- 面板 `.pod-panel`：12px 圆角、1px 边框、无阴影；头部小号大写字距标签 + 计数胶囊
- 徽章 `.pod-badge`：全圆角、10.5px、半透明同色底 + 同色描边（按语义着色）
- 按钮：default / primary（accent 实底深字）/ danger / ghost / sm，8px 圆角，150ms 过渡
- 表单：`.pod-input` 凹陷底 + 边框，focus 变 accent 边框；`.pod-textarea` 等宽
- 进度：4px `.pod-meter`，填充用 `transform: scaleX()`（不过渡布局属性），≥60% 转 wait 色、≥90% 转 error 色
- 状态灯 `.pod-dot`：8px 圆点；工作中的加 `pod-breathe` 呼吸动画（1.6s）
- 看板列 5 列：待办/执行中/受阻/完成/转人工；任务卡含 id + 类型徽章 + 标题 + owner/×attempts/commit 元信息 + 故障行

## 布局

- 顶栏 sticky：品牌标（26px SVG：三色节点 pod 群）｜mission 芯片（mono id + 状态徽章 + 目标截断）｜预算计量｜动作（手动派发/中止）
- 主网格 `250px / 1fr / 330px`：员工灯板+账本 ｜ 看板·拓扑（tab 切换）+ 折叠发射台 ｜ 审批+steer+事件流
- ≤1180px 侧栏落底；≤860px 单列
- 空态：单面板（max-width 860px 居中）= DAG 缩影示意 + 标题 + 一句话 + 完整发射表单（2 列，含预设阵型胶囊）

## 动效

仅状态性的：呼吸灯（工作中）、进度条 scaleX 过渡（300ms）、按钮 150ms 过渡、拓扑图运行边流光（既有 `pod-dash-flow`）。无入场编排。

## 纪律

- 设计系统单一事实源 `src/web/console-css.ts`：standalone 壳静态内联，DSH 宿主形态由 PodPanel 挂载注入同一份（id `pod-console-css`）
- 壳带启动错误可见化（`#boot-error`）：UI 挂载失败绝不黑屏
- 检测器基线：`detect.mjs` 对改动文件零告警（2026-08-29）

## 对话式形态（2026-08-29 增补，berd 借鉴）

berd（Block 的 Grounded Workbench）原则落地：对话是主界面，配置是一等公民，界面安静。

- 布局：`.pod-shell` = 228px 持久侧栏 + 主区。侧栏承载品牌 / 导航（对话·看板·设置）/ mission 状态（id+徽章 / 预算计量 / 任务计数芯片）/ experiments 脚注；主区按视图切换（≤900px 侧栏隐藏）
- 对话流（`.pod-thread`，max-width 780px 居中）：用户消息 = 右侧 accent 淡底气泡；agent 消息 = 平铺块（状态色圆点头像 + mono 署名 + 任务/时间），无气泡框——安静；系统事件 = 居中 mono 细线（精简/详细双密度）；问题卡与审批卡 = 内联琥珀卡
- Composer（签名组件）：玻璃胶囊（20px 圆角 + backdrop-blur + 渐变地台），上排上下文芯片（无 mission：仓库路径/预算/名册数；有 mission：指令目标槽位芯片），无框 textarea，Enter 发送 / Shift+Enter 换行
- 问题弹窗：仅阻塞决策用模态（`.pod-overlay` + 16px 圆角卡），三动作（按你的判断继续 / 我来补充说明 / 保持转人工），数据源为后端 `task_question` 事件
- 设置页（一等公民）：`.pod-settings` 三面板（发射默认值 / 对话行为 / 外观与运行信息），localStorage 即时保存，主界面零配置残留
- 检测器基线：detect.mjs 对 chat-view/PodPanel/console-css 零告警（2026-08-29）

## 点选化（2026-08-29 增补：拒绝打字）

用户反馈「不要输入文字这很麻烦」——发射默认值两处文本输入全部点选化。

- **目标仓库路径 = 本地目录点选器**：浏览器拿不到本地绝对路径，改为 loopback-only 的
  `GET /api/dsh-pod/fs/browse?path=…`（`src/core/fs-browse.ts`：只列目录名、隐藏 $ 系统目录、
  排除符号链接、条目上限 300、必须已存在的绝对路径）。点开头目录**保留**——否则
  `.zcode` 这类工作区路径下的仓库永远点不到（实测踩坑后放宽）。前端弹窗（`.pod-modal`）：
  路径面包屑 + 上一级/主目录 + 目录列表（Windows 根级 = 盘符列表），「选择此目录」回填
  只读输入框（原输入框保留为只读展示，不再接受打字）
- **默认员工名册 = 点选构建器**：settings 从 `slots: string` 改为 `roster: RosterMember[]`
  （vendor/role/capabilities 受控词表，chat-view.ts 导出 VENDOR_OPTIONS/ROLE_OPTIONS/
  CAPABILITY_OPTIONS）。成员卡（S-n + vendor 徽章 + 职责 + 能力胶囊 + 移除）；「＋添加员工」
  内联面板三段点选：员工类型（Claude/Codex/OpenCode/DSH = 壳实际接线的 backend）→ 职责
  （规划/实现/审查/测试/调研/文档，点选自动带默认能力）→ 能力多选；预设阵型改填构建器
- 旧 localStorage 的 slots 字符串在 loadSettings 里一次性迁移为结构化 roster；发射时
  rosterToSlots 生成 S-1..n 槽位（claude 指定 deepseek-v4-pro，其余走 CLI 默认）
- 测试：fs-browse.test（过滤/根级/上级/拒绝/上限）+ routes.test 浏览端点（200/400/405/403），
  全量 540 通过（2026-08-29）

## 重设计落地（2026-08-29 增补：外部设计稿 dark cockpit / cyan）

用户提供 7 屏设计稿（会话列表/对话视图/任务看板/DAG 拓扑/合并审批/Agent 问答/设置，
Tailwind + Lucide 原型），按「设计稿即契约」落地为纯 CSS + createElement（无运行时依赖）：

- **设计系统**（console-css.ts 全量重写）：token 1:1 对齐设计稿——地面 `#0b0b0f`、
  表面三级 `#13131a/#1c1c25/#252532`、线 `#272730`、主色青 `#22d3ee`（primary-ink `#071418`）、
  语义状态 success/warning/error/info；图标 = 内嵌 lucide 风格 stroke SVG（icons.ts，零 CDN）
- **壳**：64px 图标导航轨（会话/对话/看板/DAG + 底部设置，对话项带待审批角标）+ 52px 顶栏
  （当前任务目标 + 状态 pill + 预算计量 + mission id）
- **会话语义**（本轮核心补齐）：mission = 会话。`GET /missions`（列表：状态/预算%/token/
  任务数/槽位/最新事件）+ `GET /missions/detail?id=`（归档快照：对话流/任务/槽位/审批/账本）；
  选中历史会话 → 只读回放（composer 禁用）；「新建会话」对未终结活跃会话先确认中止
- **对话视图**：三栏（线程 + 288px 任务栏）。agent 消息署名 + 状态色头像；内联审批卡
  （查看完整补丁/批准/拒绝）；问题卡 + 「Agent 问答」choice-card 模态（继续/补充说明/转人工）；
  右栏预算/Token in-out/槽位点选（指令目标）/快捷操作（引导/派发/中止）
- **看板**：5 列 + 搜索 + 手动分派 + 列内添加任务（/plan add）；任务卡 Slot/Commit/依赖三列
  + 受阻/转人工 callout；右侧 280px Agent 槽位栏（状态点/能力标签/上下文计量）
- **DAG**：分层自动布局 SVG（箭头边/状态描边/运行脉动/点选检查器/图例浮卡）
- **合并审批页**：`GET /approvals/detail`（记录 + diff：落盘 diff_path 或 base..head 现算，
  白名单根内 + 64KB 上限）+ 变更预览（+/- 行着色与统计）+ 记住规则/驳回原因 + 最近审批历史
- **设置**：显式保存栏（保存/重置）+ 目录点选器 + 预算滑杆 + 名册表格（供应商/角色下拉 +
  能力标签多选）+ 密度三档（紧凑/标准/详细）+ 默认视图三选
- **引擎修复（实证发现）**：buildApprovalRequest 的合并单元过滤加 `commit_sha !== undefined`
  ——plan 任务（无 commit）被误选 primary 会导致审批卡 base/head 缺失（无 diff 可审）且
  merge 空合并；回归测试在 orchestrator.test 规划全链路用例中断言 base/head 必填
- **DemoBackend（--demo）**：脚本化后端（plan 提案 / 首任务 need_clarify 提问 / steer 注入后
  真实 git 提交 / review 通过），零 LLM 成本走通全部真实管线；端到端实测：发射 → 规划 →
  问答（steer_queued 落盘）→ 实现（真实 commit）→ 审查 → 审批（+8/-0 diff）→ 合并
  （主分支出现 agent commits + 审批 merge commit）→ 会话列表/归档回放（只读）
- 全量 543 测试通过（2026-08-29）

## Token 主计价 + Agent 形象（2026-08-29 增补）

- **预算以 Token 计价**（用户反馈：不用 USD 主计价）：设置页预算方式二选一——
  「无需关注预算」（budget_usd:0 → 落地 1e9 事实无限，只显示已用 token，不做熔断）/
  「Token 上限」（默认 2M，快捷档 500k/1M/2M/5M；budget_tokens 为主闸，美元闸放开）。
  validateLaunch：显式 0/负数 = 不限，缺省仍 $3 安全兜底（防误用烧钱）。顶栏/对话右栏/
  会话列表/会话详情全部 token 化（百分比或「不限/∞」），USD 从主 UI 退场
- **毕加索（立体主义）动物形象**（avatars.ts，8 种：猫/狐/鸮/熊/兔/狼/蛙/鹿）：
  纯几何多边形拼接 + 不对称错位双眼 + 撞色切面；每个员工在设置名册「形象」列点选
  （行内 8 宫格浮层，零打字）。全链路持久化：launch avatar（AGENT_AVATARS 白名单校验）
  → AgentSlot.avatar → status/归档快照返回 → 对话消息头像/右栏槽位/看板 Agent 栏/
  会话详情 chips 渲染（历史会话回放同样带形象）
- **状态动作**（avatarMotion → CSS keyframes）：working 敲击摇摆 / dispatched 前倾 /
  waiting_approval 左右张望 / error 抖动 / rate_limited 打盹 / idle 呼吸；
  prefers-reduced-motion 降级为静止
- 测试：validateLaunch 预算语义 + avatar 白名单（合法透传/非法剔除）+ summaries avatar
  断言，全量 544 通过；--demo 端到端实测：launch(budget_usd:0, budget_tokens:2M,
  owl/wolf/fox) → 规划/实现/审查 → 审批合并（merge 3b1d27d9），status/回放均返回形象

## P0 卡死修复 + 流式/传信/交互（2026-08-29 第四轮）

- **planning 僵尸修复（用户实证）**：launch 分流/run 任何崩溃此前只落事件、mission 停在
  planning/running 无人驱动，且永久占用单活跃锁（后续发射全 409）。三重修复：分流原子性
  （异常 → mission 落 aborted）、run 崩溃落终态、maintenanceTick 僵尸自愈（活跃 mission 无
  编排器归属 → abort + 事件）；路由 catch 补 console.error（这次没堆栈排查了很久）
- **流式输出**：worker_progress 文本按（agent × 任务）聚合成单一气泡增量追加（数据源=既有
  SSE/轮询事件流），执行中尾部打字光标；agentMsgMax 截断保留
- **agent 间传信（真实数据，非前端表面）**：task_dispatched 事件带 title/type/spec 摘要；
  新增 agent_relay 事件（审查上下文注入：实现者产物 → 审查者，含被审任务清单）；前端把
  派单/目标下发/审查注入/任务交接/用户指令注入渲染为「A → B」传信行
- **布局与缓存**：chat-grid 补 grid-template-rows:minmax(0,1fr)（thread 撑爆把 composer 推出
  视口的实证 bug）；standalone.js/HTML 加 cache-control:no-store（浏览器吃旧 bundle 导致
  代码与 UI 行为不一致的实证 bug）；PodPanel 括号层级修复（视图三元曾掉出 main-col）
- **任务面板**：拖拽调宽（232-480px）+ 折叠/展开；composer 换多行 textarea（Enter 发送/
  Shift+Enter 换行/自动长高/手动 resize）
- **动效**：视图切换 fadeUp、消息/模态入场、按钮 :active 缩放、导航选中弹跳；
  prefers-reduced-motion 全量降级
- 测试 546 通过（新增 launch-atomicity 2 例）

## 连续会话 P0 修复（2026-08-29 第五轮，用户实证「发送了没有回应」）

- **任务主键按 mission 复合（根因）**：slot 早已命名空间化而任务没有——第二个会话的规划任务
  P-1 与上一轮全局撞键（DUPLICATE_TASK），launch 立即失败。修复：store 任务键 = `mission::id`
  （JsonStore/sqlite 双实现 + 存量数据幂等迁移）；接口双重载 getTask/updateTask(missionId, id)
  精确查，单参旧签名按短 id 全表匹配（50+ 测试断言零改动）；生产调用点（orchestrator/
  task-machine/mission/handoff/pod-service）全部两参化；TaskMachine 注入 missionId
- **不限预算引擎层归一**：budgetUsd<=0 在引擎 launch 入口也归一为 UNLIMITED_BUDGET_USD(1e9，
  types.ts 常量与 HTTP 层同源)——0 真上限会锁死一切派发（实证：budget_short_circuit 死等）
- **停摆兜底（存储级 stall guard）**：maintenanceTick 发现 active 任务超过 3 分钟无落盘进展
  → kill + fail(idle_timeout) + 落事件 + 重驱。针对「驱动循环静默挂起」的运行态故障
  （实证一次：事件止于并行任务 done、重派未发生、无 crash 日志——重启必然自愈故无法留现场，
  兜底保证任何此类停摆 ≤ 一个巡检周期自愈）
- **updateTask 尊重显式 updated_at**（此前强制 clock 覆盖，使「任务陈旧度」不可伪造/不可判定）
- 回归测试：sequential-missions（JsonStore 两轮全链路）+ stall-guard（伪造挂起现场→自愈）；
  全量 548 通过；HTTP 端到端连续 3 轮（发射→问答→审批合并）全部 PASS，会话列表 3 会话共存
