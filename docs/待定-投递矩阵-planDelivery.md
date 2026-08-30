# 待定：投递矩阵（planDelivery / 2×3）

状态：**挂起，待讨论**　记录日期：2026-08-30　基线：`7094a80`

秋秋决定先挂起这个问题，转去做没有设计争议的补齐项。本文把调查结论固化下来，
以后讨论时不必重新翻代码。

---

## 一、一句话结论

**「planDelivery 零调用」是真的，但「零实现」是假的。** queue 行三格已经由现有代码
覆盖了——只是没调用这个函数本身。所以剩下的问题不是"怎么接线"，而是
"要不要把已实现的行为改为显式调用矩阵"。

---

## 二、矩阵是什么

`src/core/handoff.ts:118-135` 定义了 2×3 投递矩阵：投递模式 × 会话档位 → 确定性动作。

```ts
deliveryMatrix: Record<SessionTier, Record<HandoffMode, DeliveryAction>>
```

- `SessionTier` = `transient` | `per-mission` | `auto-reset`（`types.ts:9`）
- `HandoffMode` = `queue` | `memory`（`types.ts:69`）
- `DeliveryAction` 六种：
  `new-process` / `resume-session` / `reset-session` / `memory-file` / `context-append`

## 三、六格的真实状态

| | transient | per-mission | auto-reset |
|---|---|---|---|
| **queue** | `new-process`<br>✅ 默认行为 | `resume-session`<br>✅ session_ref 写回 | `reset-session`<br>✅ C 档刹车 |
| **memory** | `memory-file`<br>⬜ 需新建 | `context-append`<br>❌ 架构上不可行 | `memory-file`<br>⬜ 需新建 |

queue 行三格的实现来源：
- `new-process`：transient 档位本来就是每次 `start(prompt)` 起新进程。
- `resume-session`：`orchestrator.ts` 在 `backend.start` 之后把 `handle.session_ref`
  写回 `slot.session_ref`（2026-08-30 修复）。此前 core 从不写回，判据恒为真，
  等于 per-mission 名存实亡。
- `reset-session`：派发前检测 `needsAutoReset(slot)` → 清空 `session_ref`
  + 注入 `buildResetSummary` + 更新 `session_base_tokens` 基线 + 占用归零
  + 落 `session_reset` 事件（2026-08-30 接线）。

**这三项是分别实现的，没有一处调用 `planDelivery`。**

---

## 四、四个待定问题

### 问题 1（阻塞其余）：常规派发的 `HandoffMode` 是什么？

- **现状**：`HandoffMode` 只有换人路径 `buildHandoff`（`orchestrator.ts:1525`）会指定。
  常规派发不构造 Handoff，因此没有 mode —— 这是矩阵无法直接接线的根本原因。
- **判断**：常规派发传的是一次性任务规格，语义上就是 `queue`；`memory` 是知识持久化，
  属于另一回事。
- **待定**：确认「常规派发 mode = queue」。定了这个，矩阵就只用左列，问题缩小一半。

### 问题 2：要不要把已实现的三格改为显式调用？

- **现状**：行为有了，但声明（矩阵）与实现（`dispatchTask` 里的 if 分支）不同源。
- **风险**：以后改行为时忘了改矩阵，又会退化成「方案书说有、代码里没有」
  （本项目已经踩过一次：README 标 ✅ 而实际零集成）。
- **选项**：
  | 选项 | 做法 | 代价 |
  |---|---|---|
  | a | 重构为显式调用 `planDelivery`，矩阵作唯一事实源 | 要动 `dispatchTask` 控制流，有回归风险 |
  | b | 保持现状，在矩阵旁注明「由谁实现」 | 零风险，但漂移可能仍在 |
  | c | 删掉矩阵，只留 `needsAutoReset` / `sessionCtxUsage` 等实际函数 | 最诚实，但丢了方案书的设计意图 |
- **倾向**：先 b（标注，零风险），a 留到有整块时间时做。

### 问题 3：memory 列怎么办？

- **`context-append`（per-mission + memory，`interrupt: false`）架构上不可行。**
  它需要向**运行中**的进程追加上下文，但是：
  - `WorkerBackend.protocol.capabilities`（`types.ts:343-348`）只有
    `kill` / `session_persist` / `structured_output` / `usage_audit` 四位，
    **没有"运行中注入"**；
  - headless CLI 是 `start(prompt)` 一次性语义，`WorkerBackend` 接口上也没有注入方法。
  - 要支持它得先扩 `WorkerBackend` 接口，是另一个量级的工程。
- **`memory-file` 两格是"需新建"而非"接线"**：要有写文件 + 下次派发携带的机制，
  本质上是个独立功能（跨任务知识沉淀）。
- **倾向**：memory 列如实标注「未实现 / 不支持」，不纳入近期计划。
  除非认为"记忆文件"有独立价值，那要单独立项。

### 问题 4：dsh 的档位与能力不对齐

| 后端 | `session_persist` | `DEFAULT_SESSION_TIERS` | 对齐 |
|---|---|---|---|
| claude | true | per-mission | ✅ |
| **dsh** | **true** | **transient** | ❌ |
| codex | false | transient | ✅ |
| opencode | false | transient | ✅ |
| ark | false | transient | ✅ |
| remote / satellite | false | transient | ✅ |

`dsh-subagent.ts:42` 声明支持会话持久，默认档位却把它关掉了。
可能是有意保守，也可能是遗漏 —— 需要判断。

---

## 五、顺带：一处死代码

`tierDefaults(vendor)`（`session-tiers.ts:17`）在 `src/` 内零调用，
真正在用的是 `DEFAULT_SESSION_TIERS` 常量（`orchestrator.ts:314`）。
两者取值当前一致，但存在漂移风险。建议删除函数或改为由常量派生。

---

## 六、决策记录

（留空，待讨论后填写）

- [ ] 问题 1：常规派发 mode = queue？　结论：
- [ ] 问题 2：a / b / c？　结论：
- [ ] 问题 3：memory 列标注为不支持？　结论：
- [ ] 问题 4：dsh 默认档位改为 per-mission？　结论：
