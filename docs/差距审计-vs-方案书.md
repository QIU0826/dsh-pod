# DSH-Pod 代码 vs 方案书差距审计（重构检查）

> 首轮审计：2026-08-25（P0/P1 模块落地）
> **复核：2026-08-29**（远端 59cf734 同步后，逐项对照代码复核；首轮标 ❌ 的项已全部落地）
> 基线：DSH-Pod-项目方案书-v2.0.md（最终稿 + CR-01~08，含 v2.1 增量）
> 代码：D:\玩具\dsh-pod（main @ 59cf734）
> 方法：对照 3.10 代码结构 + DoD-15~19 + CR-08 迁移表逐项核查，**以源码为准，不采信文档自述**

> ⚠️ 本文档在 2026-08-29 之前长期未更新，DoD-15/16/17/19 一直标「未实现」，
> 而代码里模块早已落地——造成了「文档说没做、代码早做了」的偏差。本次复核全部纠正。

---

## 一、模块存在性（方案书 3.10 对照）

| 状态 | 模块 | 说明 |
|---|---|---|
| ✅ | core/{mission,task-machine,dispatcher,handoff,approvals,ledger,verifier,watchdog,store,apply-patch,session-tiers} | 核心域层完备 |
| ✅ | workers/{base,claude-headless,codex-headless,opencode-headless,ark-headless,dsh-subagent,preflight} | 多后端 + 探测 |
| ✅ | core/{report-schema,permission-rules,events,model-cards,middleware,experiments,skills} | DoD-16/18/19 + AgentScope E/H + Berd D/E |
| ✅ | core/{backends-lock,asset-whitelist,notifier,cron,memory,sqlite-store,store-open,planner} | DoD-15/17 + v0.2/v0.3 切片 |
| ✅ | core/{channel,channel-im,mcp-gateway} | Berd-H 通道框架 + **IM vendor adapter（2026-08-29 落地）** + **MCP Gateway（2026-08-29 落地）** |
| ✅ | core/{fs-browse,http-guard} + workers/{argv-guard,kill-tree} | P1 安全加固（2026-08-29 远端同步带入） |
| ✅ | web/ 拆分为 PodPanel + chat/board/dag/sessions/settings/approval/avatars/icons/view-helpers/console-css/console-settings | 原「PodPanel 单文件」P2 重构项已完成 |

## 二、DoD 1–19 状态

| DoD | 状态 | 证据 |
|---|---|---|
| 1–14 | ✅ 已达成 | docs/DoD-1-14-核对表.md |
| 15 后端版本锁定（backends.lock.json pin/check） | ✅ 已实现 | `src/core/backends-lock.ts`：三态 `ok / mismatch / override`，preflight `--pin` 记录实况 / `--check` 对照锁定；`tests/backends-lock.test.ts` |
| 16 报告契约单一事实源（report-schema + 漂移测试） | ✅ 已实现 | `src/core/report-schema.ts`（zod 单一事实源：类型/校验器/提示词片段同源 + Drift 哨兵）；`tests/report-schema.test.ts` |
| 17 Canvas 资产读取白名单 | ✅ 已实现 | `src/core/asset-whitelist.ts`（makePathWhitelist/resolveAsset）+ `tests/asset-whitelist.test.ts`；路由 `/api/dsh-pod/assets`（**前端未接线**） |
| 18 审批规则层 + HITL | ✅ 已实现 | `src/core/permission-rules.ts`（tool+pattern → allow/deny/ask，只读命令自动放行）+ `approvals` 规则层 + `/api/dsh-pod/rules`（GET/POST/**DELETE**） |
| 19 事件流重建完整消息态 | ✅ 已实现 | `src/core/events.ts`：worker 进度按 slot+reply_id 聚合，seq 保序；orchestrator 走 `emitWorkerProgress` 落盘 |

## 三、CR-08 迁移表落地核查

| 迁移项 | 决策 | 状态 | 证据 |
|---|---|---|---|
| Berd-A backends.lock.json | P0 → MVP Must | ✅ | `core/backends-lock.ts` |
| Berd-B report-schema.ts | P0 → MVP Must | ✅ | `core/report-schema.ts` |
| Berd-C Canvas 资产白名单 | P0 → MVP Must | ✅ | `core/asset-whitelist.ts` + `/assets` 路由 |
| Berd-D pod skills add | P1 → Should | ✅ | `core/skills.ts` |
| Berd-E experiments | P1 → Should | ✅ | `core/experiments.ts` |
| Berd-F 工程门禁（justfile/AGENTS.md） | P1 → Should | ✅ | `justfile` + `AGENTS.md` + `scripts/pre-commit.mjs`（`just install-hooks`） |
| Berd-H 外部协作通道 adapter | P2 → v0.3 | ✅ 框架 + **vendor adapter** | `core/channel.ts`（框架）+ `core/channel-im.ts`（Slack/飞书，2026-08-29） |
| Berd-I 遥测立场文档 | P2 → v0.3 | ✅ | `docs/telemetry.md` |
| Berd-G 协议适配器层 | P2 → v0.3 | ✅ | `WorkerBackend.protocol` 元数据 + `docs/adapters.md` |
| AgentScope-A 审批规则层 | P0 → MVP Must | ✅ | `core/permission-rules.ts` |
| AgentScope-B suggested-rules | P0 → MVP Must | ✅ | `approvals.decide` 的 `rememberRule` + `/rules` |
| AgentScope-C HITL 可编辑参数 | P0 → MVP Must | ✅ | `pod_approve` 的 `edited` 参数（非字符串键值被过滤，防注入） |
| AgentScope-D 事件重建消息态 | P0 → MVP Must | ✅ | `core/events.ts`（reply_id/seq） |
| AgentScope-E 工具 middleware | P1 → Should | ✅ | `core/middleware.ts` + `wrapTool` |
| AgentScope-F 派发前预算短路 | P1 → Should | ✅ | 架构不变量 6：`estimateTaskCostUsd` 短路 + `budget_short_circuit` 事件 |
| AgentScope-G worker HITL 事件进 mission 流 | P1 → Should | ✅ | 架构不变量 2（tests 有 EV-3 不变量断言） |
| AgentScope-H model-cards | P1 → Should | ✅ | `core/model-cards.ts` |
| AgentScope-I SSE replay | P1 → Should | ✅ | `/api/dsh-pod/events/stream`：先 replay buffered history 再 live |
| AgentScope-J MCP Gateway / IM Channel / Cron | P2 → v0.3 | ✅ | `core/mcp-gateway.ts`（2026-08-29）+ `core/channel-im.ts`（2026-08-29）+ `core/cron.ts` |

## 四、其他已发现问题的现状

| # | 问题 | 状态 |
|---|---|---|
| 1 | claude-headless 超时硬编码 | ✅ 已修复（CR-06-11，taskTimeoutMs 可配置） |
| 2 | permission-mode acceptEdits 不放行 Bash | ✅ 已修复（CR-06-10，bypassPermissions） |
| 3 | store tmp 残留 EPERM | ⬜ 未做（重构候选，低优先级） |
| 4 | dsh-subagent 后端缺失 | ✅ 已补齐（`workers/dsh-subagent.ts`） |
| 5 | web 面板单文件化 | ✅ 已拆分（10+ 视图模块） |

## 五、执行顺序（已全部完成）

```
P0：report-schema ✅ → permission-rules ✅ → events ✅ → backends-lock ✅ → asset-whitelist ✅
P1：model-cards ✅ → experiments ✅ → middleware ✅ → skills ✅ → dsh-subagent ✅ → 预算短路 ✅
P2：web 拆分 ✅ / AGENTS.md ✅ / justfile ✅ / IM adapter ✅ / MCP Gateway ✅
```

## 六、补齐记录

### 6.1 首轮（2026-08-25）

| commit | 模块 | DoD | 测试 |
|---|---|---|---|
| 9c9ea3b | report-schema.ts（zod 单一事实源 + Drift 哨兵） | DoD-16 | 9 + verifier 迁移 |
| be5ff1e | permission-rules.ts + events.ts | DoD-18/19 | 13 + 5 |
| c5c8617 | model-cards.ts | AgentScope-H | 6 |
| f579eca | middleware.ts + experiments.ts + skills.ts | AgentScope-E / Berd-E / Berd-D | 21 |
| 9a5f9d2 | dsh-subagent.ts | W2 三后端 | 4 |

首轮列出的「接线待做」，复核后状态：

| 待接线项 | 状态 | 证据 |
|---|---|---|
| events.ts → orchestrator 进度事件走 emitWorkerProgress | ✅ | `orchestrator.ts` handleProgress 调用 `emitWorkerProgress` |
| middleware → pod_* 工具统一包 wrapTool | ✅ | `pod-tools.ts` + `recordToolAudit` |
| permission-rules → 审批/路由裁决路径 | ✅ | `/api/dsh-pod/rules` + `approvals` 规则层 |
| experiments/skills → 生命周期挂载 | ✅ | plugin.ts + maintenanceTick |
| backends.lock.json | ✅ | `core/backends-lock.ts` |

### 6.2 2026-08-29 复核补记

| 项 | 内容 |
|---|---|
| 文档纠正 | DoD-15/16/17/19 由 ❌ 改为 ✅（代码早已落地，文档未跟上） |
| `/rules` 补 DELETE | 规则此前只增不减；新增 DELETE 分支（缺 id → 422，不存在 → 404） |
| eventsTail 游标改造 | 游标 ts → 事件 id + 分页续读（见 `docs/远端同步实测-2026-08-29.md`） |
| ledgerTail 契约对齐 | 返回完整 `LedgerEntry[]`，与 `api.ts` 声明一致 |
| IM vendor adapter | `core/channel-im.ts`（Slack/飞书：验签 + 时间窗 + 挑战握手 + 出站净化），13 例单测 |
| MCP Gateway | `core/mcp-gateway.ts`（命名空间隔离 + 审批门 + 输出截断 + 审计），11 例单测 |

## 七、复核后仍待补的项（非功能缺失，属接线/体验）

| 优先级 | 项 | 说明 |
|---|---|---|
| P4 | 暂停/恢复、任务换人、记忆三件套、Cron 列表 | `pod_*` 工具齐全，HTTP 路由与 UI 无入口 |
| P4 | `/assets`、`/rules` 前端接线 | 路由完整，UI 未调用 |
| P5 | 会话删除 / 重命名 | 无 `deleteMission`，会话只增不减 |
| P5 | `fs-browse` 300 条上限无截断提示 | 用户会误以为目录不全 |
| P5 | `missionArchive` 全量事件无上限 | 长会话归档响应体膨胀 |
| P3 | `docs/adapters.md` 的 ACP 表述 | **已澄清（2026-09-01）**：此处 ACP = Zed 的 Agent Client Protocol（编辑器↔编码 agent），未被并入 A2A——并入 A2A 的是 IBM 的 Agent Communication Protocol（同名陷阱）。adapter 预留措辞保留，已加消歧义指针（[消歧义-ACP-2026-09-01.md](消歧义-ACP-2026-09-01.md)）。本条原审计结论（「ACP 已并入 A2A，需更新措辞」）**错误，已撤回** |
| P6 | 方案书未追加本轮 CR 记录 | 按方案书纪律「变更以设计变更记录追加文末」 |
