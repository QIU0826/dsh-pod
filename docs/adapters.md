# 协议适配器层（docs/adapters.md）—— Berd-G / 方案书 4.3 v0.3

> 落点：迁移计划 **Berd-G**（P2 → v0.3）+ 方案书 4.3「协议适配器层：WorkerBackend 加 protocol 元数据 + docs/adapters.md（ACP 接入照 Berd 生成管线）」；
> 本文档与 `src/core/types.ts` 的 `WorkerProtocol` 同源（Berd-B 精神：类型/校验/文档单一事实源）。

## 1. 一句话

编排层只依赖 `WorkerBackend` 接口；每个后端通过 `protocol` 元数据声明自己的接入协议族、会话层版本与能力位。
新后端（Grok/Kimi/OpenCode/ACP…）= 新增一个 adapter 实现 + 声明 protocol，编排层零改动。

## 2. WorkerProtocol 形状

```ts
export interface WorkerProtocol {
  family: 'headless-cli' | 'acp' | 'native' | 'remote'
  version?: string
  capabilities: {
    kill: boolean            // 进程级 kill 支持
    session_persist: boolean // 会话跨派单持久
    structured_output: boolean // 结构化输出（json/report）
    usage_audit: boolean     // 产出真实 usage（tokens 实测）
  }
}
```

## 3. 现网后端清单

| 后端 | family | 能力位 | 说明 |
|---|---|---|---|
| claude | headless-cli | kill ✓ / session_persist ✓ / structured_output ✓ / usage_audit ✓ | `claude -p --output-format json --allowedTools`；档位 B per-mission 会话持久 |
| codex | headless-cli | kill ✓ / session_persist ✗ / structured_output ✓ / usage_audit ✗ | `codex exec --json`（sandbox-bin）；瞬时档位；usage 以 CLI 输出为准（缺 usage → ledger 标 unavailable） |
| dsh | native | kill ✗ / session_persist ✓ / structured_output ✓ / usage_audit ✓ | DSH 内建 subagent（进程内，kill 由宿主托管） |
| ark | native | kill ✗ / session_persist ✗ / structured_output ✓ / usage_audit ✗ | 火山方舟 Agent Plan OpenAI 兼容端点（/api/plan/v3）；同步 completion **无工具执行能力**（不能写文件/跑测试）——适合文本生成/记忆验收类任务；usage 缺省标 unavailable（D7） |
| remote（satellite） | remote | kill ✓ / session_persist ✗ / structured_output ✓ / usage_audit ✓ | 多机 satellite（CR-30）：`RemoteBackend` 代理到卫星 HTTP 端点（src/workers/remote-backend.ts）；vendor=被代理底层的 vendor；能力位继承自卫星实现，usage 来自卫星回传（诚实化 D7） |

## 4. 新后端接入流程（照 Berd 生成管线）

1. 定协议族：进程式 CLI → `headless-cli`；走 ACP → `acp`；进程内 → `native`。
2. 实现 `WorkerBackend`（detect / start / kill），在类上声明 `protocol` 元数据。
3. 补本表一行 + `tests/<backend>.test.ts` 覆盖 detect/start/kill/退出分类。
4. 编排层零改动：`MissionOrchestrator` 只注入 `Partial<Record<Vendor, WorkerBackend>>`。

## 5. ACP 接入（v0.3 方向，预留）

- ACP（Agent Client Protocol）：`family: "acp"`；会话层握手/流式工具调用照 ACP 规范。
- 编排层已抽象的部分：diff 注入（`diffProvider`）、最小上下文审查（`review spec`）、质量门（`verify`）均为接口注入，ACP 后端可无缝复用。
- 限制如实记录：ACP 客户端进程生命周期与 usage 审计依赖具体实现，接入时逐项核对能力位。

## 6. 边界

- 本切片（v0.2 前置）：只加 `protocol` 元数据 + 文档 + 单测；**不新增任何 adapter 实现**（Grok/Kimi/ACP 均属 v0.3，未提前实现，方案书 983/1005 行如实留白）。
- 能力位是声明不是断言：编排层仍以实际行为为准（如 codex usage_audit=false → ledger 标 unavailable，诚实化 D7）。
