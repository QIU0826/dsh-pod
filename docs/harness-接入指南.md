# Harness 接入指南（接入 workbuddy / zcode / 任何新 agent 平台）

> 2026-09-06 开放式厂商注册落地后，接入一个新 harness 平台**不需要改核心**：
> 实现 1 个接口 + 注册 1 个描述符，编排/存储/事件/审批/账本/桌宠全链路自动可用。
> 本指南以腾讯 WorkBuddy（WorkBuddy Harness 核心）与 zcode 为例。

## 0. 架构位置

```
Pod 编排器 ── WorkerBackend 接口（Berd-G）──► claude-headless / codex-headless / …
                │                              remote-backend（多机卫星）
                └── vendor-registry（谁是合法厂商）
```

- `Vendor` 类型已开放（`BUILT_IN_VENDORS | string`）——存储、事件、账本对自定义 vendor
  天然透明（历史数据以字符串留存，不因注销丢失）。
- 唯一的闭合点是**注册**：`isKnownVendor` 决定 launch 槽位校验是否放行。

## 1. 实现 WorkerBackend（执行面）

```ts
import type { WorkerBackend } from './core/types.js'

export class WorkbuddyBackend implements WorkerBackend {
  readonly vendor = 'workbuddy'
  readonly protocol = {
    family: 'headless-cli',            // 或 'remote'（走卫星线协议）/ 'native'
    version: 'workbuddy wire v1',
    capabilities: { kill: true, session_persist: false, structured_output: true, usage_audit: true },
  }

  async detect() { /* 探测 CLI/平台可用性：installed/authed/models */ }

  async start(slot, task, worktree, callbacks) {
    // 1) 构造平台 CLI 参数（参考 claude-headless 的 --print --output-format stream-json 形态）
    // 2) spawn 子进程；stdout 逐行解析为：
    //    - WorkerProgressEvent → callbacks.onProgress（流式进度，Canvas 实时渲染）
    //    - WorkerCompletion + MissionReport JSON → callbacks.onExit（状态机唯一入口）
    // 3) 返回 WorkerHandle { pid / session_ref }
    // 复用基建：StringDecoder 行缓冲（pet-frames2d 同款跨块问题）、killTree、
    //          argv-guard、错误信封 makeEnvelope——见 src/workers/claude-headless.ts
  }

  async kill(handle) { /* 树杀；参考 kill-tree.ts */ }
}
```

**输出契约是硬约束**：最终产物必须包含 MISSION_REPORT JSON（`report-schema.ts` 单一事实源），
status ∈ done/blocked/need_clarify——verifier 按此 fail-closed 裁决，模型自创 status 会被
归一化/拒绝（ark 的 agent-plan 端点就是反面教材：提取不到报告 = 永远 silent_failure）。

## 2. 注册厂商（元数据面）

```ts
import { registerVendor } from './core/vendor-registry.js'

registerVendor({
  id: 'workbuddy',                     // launch 槽位的 vendor 值
  label: 'WorkBuddy',                  // UI 名牌 / IM 回复
  backend: 'headless-cli',
  sessionTier: 'transient',            // 未显式指定时的会话档位
  petCharacter: 'workbuddy-girl',      // 可选：桌宠房间换装（frames2d 角色包，见桌宠角色生产规格）
})
```

注册时机：宿主插件 apply 阶段 / standalone 装配阶段（backends 注入前）。

## 3. 注入后端实例

```ts
// PodService 构造处（plugin.ts / standalone/server.ts 的 backends 面）
backends: { ..., workbuddy: new WorkbuddyBackend({...}) }
```

之后 `pod_launch` / HTTP / A2A / IM 全部入口的 `vendor: "workbuddy"` 即合法。

## 4. 可选增强

| 项 | 落点 | 说明 |
|---|---|---|
| 桌宠换装 | `pet-characters.ts` localStorage 映射 或 `petCharacter` 描述符字段 | 角色包按 docs/桌宠角色生产规格.md 生产 |
| 计价 | `core/model-cards.ts` 价目表 | 不配置 = price_known false（等效 $0 标注，诚实不虚计） |
| 会话复用 | 槽位 session_tier + 后端 --resume 形态 | 档位 B/C 语义见方案书 3.2 |
| 员工侧 MCP | worker-mcp.json 白名单追加 | pod_mem_* 三件套进 worker |

## 5. 已知平台注记

- **zcode**：本仓库开发所用的 harness CLI；接入形态同 headless-cli（探测/派发/结构化报告）。
- **WorkBuddy**（腾讯）：WorkBuddy Harness 核心有云端托管 runtime——远程形态建议走
  `remote-backend.ts`（卫星线协议）而非本地 CLI，detect 面对齐 Agent Card。
- **CodeBuddy Code CLI**：腾讯编程 agent CLI，headless-cli 形态直配。

## 6. 验收清单（新 harness 接入 DoD）

- [ ] `detect()` 真实 CLI 探测（installed/authed fail-closed）
- [ ] 真实 mission：launch → 协商 → 派发 → 结构化报告 → 质量门 → 审批 → 合并（demo 模式可先跑）
- [ ] 退出码/超时/spawn 失败三分类正确（classifyFault）
- [ ] usage 回传（usage_audit 位如实声明）
- [ ] 单测：Report 提取 / 退出分类 / 残尾冲刷（参照 codex-headless 测试形态）
