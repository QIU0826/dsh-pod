# 多机 Satellite（v0.3 方向性设计）—— 方案书 594 行

> 状态：**设计预留**（v0.3 排期，P2 方向性，不实现、不改架构——方案书 934 行采纳原则）。

## 1. 一句话目标

员工进程跑在别的机器上（异构资源 / 隔离 / 规模化），本机 Pod 编排不变——通过 WorkerBackend 的「远程」实现接入 satellite。

## 2. 与现有架构的关系

- 现网 `WorkerBackend` 是进程式（headless-cli / native），`start()` 返回 `WorkerHandle`（pid/session_ref）。
- Satellite 不新开抽象：新增一个 `RemoteBackend implements WorkerBackend`（Berd-G 协议元数据 `family` 扩展）。
- 员工进程仍是沙箱边界（charter + --allowedTools + 路径白名单三道防线）——remote 端同样强制执行。

## 3. 传输与生命周期

| 环节 | 设计 |
|---|---|
| 发现 | satellite 启动时向本机上报能力（vendor/models/版本），本机登记 |
| 派发 | 本机 `RemoteBackend.start()` 通过加密通道下发 charter + 任务 + worktree 快照 |
| 进度 | satellite 回传 worker_progress 事件（同 WorkerProgressEvent 形状） |
| 完成 | 回传 WorkerCompletion + 产物（diff 经本机 Verifier 校验） |
| 隔离 | worktree 在 remote 侧；本机只存结果与账本（数据不出本机原则保持） |

## 4. 信任与安全

- 双向认证（本机 ↔ satellite 共享密钥 / mTLS），杜绝中间人。
- satellite 不得直接写本机 store / 审批；一切状态迁移仍走本机状态机入口（架构不变量 1/2/3 保持）。
- 账本 tokens 实测来自 satellite 回传 usage（usage_audit 能力位，诚实化 D7）。

## 5. 与 Berd-G 的关系

- `docs/adapters.md` 已定义 `WorkerBackend.protocol` 元数据；satellite 后端声明 `family` 新值（如 `remote`）与能力位。
- 新后端接入流程（adapters.md §4）直接适用：实现 RemoteBackend + 声明 protocol + 补表 + 单测。

## 6. 边界

- 本文件是**设计预留**：v0.2/v0.3 初期不实现多机（无依赖、无代码、无测试变更）。
- 单机单用户数据量极小（方案书 485 行 SQLite 论证）是当前事实，多机是规模化方向。
