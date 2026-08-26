# 遥测立场文档（telemetry.md）

> 落点：迁移计划 **EN-4**（Berd-I），与方案书 **3.8-7 遥测立场（v2）** / 风险 **R13** 一致。
> 一句话立场：**统计全部默认本地可见；匿名聚合为显式 opt-in，默认关闭。**

## 1. 立场声明

1. **默认全部本地**：所有事件、成本账本、Debrief 数据默认只落在本机
   （`~/.dsh/pod` + 各 mission worktree），不出本机。
2. **匿名聚合默认关闭**：任何形式的匿名聚合上报（见 §4）都是显式 opt-in，
   未 opt-in 一律不产生任何外发流量。
3. **绝不采集**（无论是否 opt-in，见 §3 排除清单）：代码内容、文件路径、
   凭据、diff 正文、prompt 全文、MISSION_REPORT 正文。
4. **遥测是白名单不是黑名单**：新事件类型默认不在白名单内，须先过 §2 schema
   评审确认无敏感字段后才能进入可采集集合。
5. **可审计**：opt-in 后上报的每条记录带价目表/插件版本号，可对照本地账本复核。

## 2. 事件白名单 schema（可采集集合）

事件统一形状（与 `src/core/types.ts` 的 `PodEvent` 一致）：

```ts
interface PodEvent {
  id: string        // ev-<kind>-<ts>[-<seq>]
  mission_id: string
  ts: number        // epoch ms
  kind: string
  slot_id?: string  // 员工槽位 id（不承载姓名/凭据）
  task_id?: string
  payload: Record<string, unknown>  // 仅平面、可 JSON 序列化、经白名单的字段
}
```

### 2.1 mission / task 生命周期事件（可采集）

| kind | 语义 | 白名单字段 |
|---|---|---|
| `mission_created` | 任务书创建 | `mode`, `budget_usd`, `slots_count` |
| `mission_paused_budget` | 预算熔断暂停 | `spent_usd`, `limit_usd` |
| `mission_run_error` | 运行期异常 | `phase`（不含堆栈/路径） |
| `task_dispatched` / `task_done` | 派发 / 完成 | `type`, `attempts`, `test_result`, `commit_sha` |
| `task_escalated` / `task_human_resolved` | 转人工 / 接管 | `reason`（仅分类码，不含正文） |
| `approval_requested` | 审批卡 | `mode`, `patch_files_count` |
| `merge_completed` / `merge_conflict` | 合并 | `files`, `conflict` |
| `handoff_created` | 交接协议 | `target_role` |

### 2.2 worker 进度事件（可采集，**有界预览**）

`worker_progress` 的 payload 遵循方案书 3.6-S7：**tool_call 只存工具名 + 输入摘要（截断 120 字符）**；
`text` 段承载员工回复文本（本地可见；匿名聚合时**只计 token 数与频次**，不采文本）。

### 2.3 异常 / 告警事件（可采集）

| kind | 语义 | 白名单字段 |
|---|---|---|
| `crash` / `completion_error` / `silent_failure` | 后端异常 | `exit_code`, `fault`（不含 stderr 全文） |
| `rate_limited` / `idle_timeout` / `wall_clock` | 限流 / 超时 | `attempts`, `elapsed_ms` |
| `budget_short_circuit` | 派发前预算短路 | `task_type`, `estimate_usd`, `remaining_usd` |
| `steer_queued` | 排队指令 | `slot_id`（不含指令正文） |

## 3. 显式排除清单（任何场景都不采集）

- **代码与 diff**：文件内容、patch、`merge_conflict` 的冲突正文
- **路径**：仓库绝对路径、worktree 路径、home 目录
- **凭据**：API key、token、settings.json 内容、CLI 凭据文件
- **正文**：prompt 全文、MISSION_REPORT 正文、spec/steer 指令原文、stderr 全文
- **身份**：员工姓名、机器名、IP

## 4. 匿名聚合（显式 opt-in，默认关）

仅当用户显式开启后才外发，且**字段上限**为：

- mission 形状：任务数 / 员工数 / 类型分布（无 id、无 ts 精度到秒以下）
- 成本：`total_tokens` / `total_equiv_usd` / 模型名
- 通过率：`done` / `escalated` / `awaiting_approval` 任务数

对应成功指标（方案书 §6）：组队率、无接管完成率、单任务成本分布。

## 5. 当前代码落地核对（v0.1.0）

- [x] 事件只进 `store.appendEvent`（磁盘唯一事实源），无任何外发通道（`src/routes.ts` 全 loopback-only）
- [x] `worker_progress` tool_call 输入摘要截断 120 字符（`src/core/events.ts`，3.6-S7）
- [x] 成本账本标注价目表版本 + price_known（`src/core/ledger.ts`，DoD-7 估算不编造）
- [x] SSE 事件通道只绑 127.0.0.1（`isLoopback` 校验，CR-08 Berd-C）
- [ ] 匿名聚合上报管线：**v0.3 方向，本版本不实现**（默认关 = 无上报代码，最安全的默认）
- [x] 立场声明同步到 README（§遥测行）+ 本文件

> 变更记录：本文档随迁移计划 EN-4 落成（Berd-I）；后续事件类型新增时先过 §2 schema。
