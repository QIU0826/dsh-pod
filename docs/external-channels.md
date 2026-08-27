# 外部协作通道（v0.3 方向性设计）—— Berd-H / AgentScope-J

> 状态：**设计预留**（v0.3 排期，P2 方向性，不实现不改架构——方案书 934 行采纳原则）。
> 落点：方案书 945 行 Berd-H + 956 行 AgentScope-J（IM 通道与 Berd-H 合并实施）。

## 1. 一句话目标

Slack / 飞书等外部协作通道可向 Pod 提交指令与接收通知，但**上下文只进、回复复用 pod_approve 门、凭据永不出会话**。

## 2. 通道设计（每个 adapter 一页）

### 2.1 IM adapter（Slack / 飞书）

| 环节 | 设计 |
|---|---|
| 入站 | 用户在 IM 发指令 → adapter 解析 → 映射到 pod_* 工具（复用工具面） |
| 上下文 | 指令文本进 Pod；**任务上下文（diff/报告/代码）不回 IM**（telemetry.md 排除清单：正文不出本机） |
| 审批 | 需人工裁决的动作（合并/派发）→ 仍生成审批卡，**由用户在 IM 触发 pod_approve**（回复复用审批门，不绕过） |
| 出站 | 仅通知（mission 状态/审批待办/预算告警），复用 Notifier 信号 |
| 凭据 | IM 凭据只在 adapter 进程内，**不出会话、不入库** |

### 2.2 Cron / 定时（AgentScope-J）

- 定时触发 mission（如每日 bake-off / 巡检）；复用 pod_launch 工具面。
- 与 Watchdog/maintenanceTick 共用节流纪律，避免重复触发。

### 2.3 MCP Gateway

- 外部 agent 经 MCP 反向驱动 Pod（见 docs/mcp-bidirectional.md），与 IM 通道共享 pod_* 工具面。
- Gateway 是统一入口：IM / MCP / Cron 全部映射到同一工具面，**无任何旁路状态机通道**（架构不变量 3）。

## 3. 信任与安全

- 所有外部入口默认关闭，显式启用后才开放（与 experiments 灰度同纪律）。
- 入站指令过权限规则层（permission-rules：deny/ask），高风险动作仍弹审批卡。
- 出站通知走 Notifier（白名单信号，不含代码/diff/凭据）。

## 4. 边界

- 本文件是**设计预留**：v0.2/v0.3 初期不实现任何外部通道（无依赖、无代码、无测试变更）。
- 与 docs/mcp-bidirectional.md / docs/satellite.md 共同构成 v0.3 联邦方向的设计集。
