# DSH-Pod 代码 vs 方案书差距审计（重构检查）

> 审计日期：2026-08-25（首轮审计）
> 补齐日期：2026-08-25（P0/P1 模块落地，见「六、补齐记录」）
> 基线：DSH-Pod-项目方案书-v2.0.md（最终稿 + CR-01~08，含 v2.1 增量）
> 代码：D:\玩具\dsh-pod（main @ 9a5f9d2）
> 方法：对照 3.10 代码结构 + DoD-15~19 + CR-08 迁移表逐项核查

---

## 一、模块存在性（方案书 3.10 对照）

| 状态 | 模块 | 说明 |
|---|---|---|
| ✅ | core/{mission,task-machine,dispatcher,handoff,approvals,ledger,verifier,watchdog,store,apply-patch,session-tiers} | 核心域层完备 |
| ✅ | workers/{base,claude-headless,codex-headless,preflight} | 双后端 + 探测 |
| ✅ | commander.ts / pod-tools.ts / pod-service.ts / routes.ts | 工具与服务接线 |
| ✅ | web/PodPanel.ts（单文件承载 Canvas） | 与方案书 team-builder.tsx/canvas/ 分文件**实现方式差异**，功能已有 |
| ✅ | **core/report-schema.ts** | 本轮补齐（Berd-B / DoD-16） |
| ✅ | **core/permission-rules.ts** | 本轮补齐（AgentScope-A / DoD-18） |
| ✅ | **core/events.ts** | 本轮补齐（AgentScope-D / DoD-19） |
| ✅ | **core/model-cards.ts** | 本轮补齐（AgentScope-H） |
| ✅ | **core/middleware.ts** | 本轮补齐（AgentScope-E） |
| ✅ | **core/experiments.ts** | 本轮补齐（Berd-E） |
| ✅ | **core/skills.ts** | 本轮补齐（Berd-D） |
| ✅ | **workers/dsh-subagent.ts** | 本轮补齐（W2 三后端之一） |

## 二、DoD 1–19 状态

| DoD | 状态 | 证据 |
|---|---|---|
| 1–14 | ✅ 已达成 | docs/DoD-1-14-核对表.md（13 实证 + DoD-10 Bake-off 运行中） |
| 15 后端版本锁定（backends.lock.json pin/check） | ❌ 未实现 | preflight 有版本检测但无 lock 文件 pin/check/override 三态 |
| 16 报告契约单一事实源（report-schema.ts + 漂移测试） | ❌ 未实现 | MissionReport 类型在 types.ts，校验在 verifier.ts，提示词片段在 claude-headless.ts——三处手写 |
| 17 Canvas 资产读取白名单（makePathWhitelist + 穿越单测） | ❌ 未实现 | 无资产端点（Canvas 走 status/events 只读聚合，无文件读取路径） |
| 18 审批规则层 + HITL（规则命中/只读放行/记住规则/可编辑参数） | ❌ 部分 | approvals.ts 只有 decide；无 rules 层、无 suggested-rules、无 edited 参数 |
| 19 事件流重建完整消息态（slot+reply_id 聚合） | ❌ 未实现 | 事件流有 payload，无按 reply_id 聚合重建能力 |

## 三、CR-08 迁移表落地核查

| 迁移项 | 决策 | 状态 |
|---|---|---|
| Berd-A backends.lock.json | P0 → MVP Must（W3/W6） | ❌ |
| Berd-B report-schema.ts | P0 → MVP Must（W3） | ❌ |
| Berd-C Canvas 资产白名单 | P0 → MVP Must（W4） | ❌（无资产端点，需评估） |
| Berd-D pod skills add | P1 → Should（W5） | ❌ |
| Berd-E experiments | P1 → Should（W4） | ❌ |
| Berd-F 工程门禁（justfile/AGENTS.md） | P1 → Should（W6） | ❌ |
| AgentScope-A 审批规则层 | P0 → MVP Must（W5） | ❌ |
| AgentScope-B suggested-rules | P0 → MVP Must（W4/W5） | ❌ |
| AgentScope-C HITL 可编辑参数 | P0 → MVP Must（W5） | 部分（deny reason 有，edited 无） |
| AgentScope-D 事件重建消息态 | P0 → MVP Must（W4） | ❌ |
| AgentScope-E 工具 middleware | P1 → Should（W3） | ❌ |
| AgentScope-F 派发前预算短路 | P1 → Should（W5） | ❌ |
| AgentScope-G worker HITL 事件进 mission 流 | P1 → Should（W6） | 部分（事件已进流） |
| AgentScope-H model-cards | P1 → Should（W3） | ❌ |
| AgentScope-I SSE replay | P1 → Should（W4） | ❌（当前 2s 轮询） |

## 四、其他已发现的问题（重构候选）

1. **claude-headless 超时硬编码** → 已修复（CR-06-11，taskTimeoutMs 可配置，commit 2a56da0）
2. **permission-mode acceptEdits 不放行 Bash** → 已修复（CR-06-10，bypassPermissions，commit fa4fa0e）
3. **store tmp 残留 EPERM**：`store.json.tmp-<pid>` 崩溃残留可致后续 persist 失败——建议 open() 时清理孤儿 tmp（重构候选）
4. **dsh-subagent 后端缺失**：三 worker 后端契约（base.ts）已定义但无实现，MVP Must 项（W2 切片）需补
5. **web 面板单文件化**：PodPanel.ts 已 330+ 行，方案书建议拆 team-builder/canvas/debrief——P2 重构候选

## 五、执行顺序（按方案书 DoD 优先级）

```
P0（已完成）：report-schema ✅ → permission-rules ✅ → events ✅ → 审批规则接线（DoD-16/18/19 模块层）
P0（待做）：backends.lock.json（DoD-15）→ 资产白名单（DoD-17，若评估需要）→ 规则层接线进 approvals/routes
P1（已完成）：model-cards ✅ → experiments ✅ → middleware ✅ → skills ✅ → dsh-subagent ✅
P2：web 拆分 / AGENTS.md / justfile
```

## 六、补齐记录（2026-08-25）

| commit | 模块 | DoD | 测试 |
|---|---|---|---|
| 9c9ea3b | report-schema.ts（zod 单一事实源：类型/校验器/提示词片段同源 + Drift 哨兵） | DoD-16 | 9 + verifier 迁移 |
| be5ff1e | permission-rules.ts（规则命中优先/只读放行/模式默认）+ events.ts（reply_id 聚合重建） | DoD-18/19 | 13 + 5 |
| c5c8617 | model-cards.ts（Team Builder 数据契约） | AgentScope-H | 6 |
| f579eca | middleware.ts（onion 钩子）+ experiments.ts（灰度开关）+ skills.ts（可移植安装） | AgentScope-E / Berd-E / Berd-D | 21 |
| 9a5f9d2 | dsh-subagent.ts（宿主 agent 工厂后端） | W2 三后端 | 4 |

**接线待做**（模块已就绪，未接入运行时）：
- permission-rules → pod_approve/routes 的权限裁决路径
- events.ts → orchestrator 进度事件落盘改走 emitWorkerProgress
- middleware → pod_* 工具统一包 wrapTool
- experiments/skills → plugin 生命周期挂载
- backends.lock.json（Berd-A / DoD-15）尚未实现
