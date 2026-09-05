/**
 * A2A（Agent-to-Agent）wire 协议映射 —— 纯函数层。
 *
 * 把 dsh-pod 的内部模型映射成 A2A 风格的对外契约（时序：Agent Card 发现 →
 * sendMessage 建任务 → sendMessageStream 流式收事件）：
 *   - Agent Card（`/.well-known/agent-card`）：名册即技能表，能力位如实声明；
 *   - A2A Task = mission：内部 mission/task 双层中，对外任务粒度是 mission
 *     （一次 sendMessage = 一个目标），单个 agent 任务作为 artifact 流出；
 *   - 事件映射：内部 PodEvent → task_status_update / task_artifact_update，
 *     mission 终态（done/denied/aborted）→ final status-update，随后流收口。
 *
 * 纪律：
 *   - 纯映射不落盘、无 IO；路由层负责 SSE 传输与订阅；
 *   - 凭据/内部路径不出协议面（securitySchemes 只声明 loopback NoAuth）；
 *   - fail-closed：未知事件不映射（返回 null），不编造状态。
 */

import type { AgentSlot, Mission, PodEvent } from './types.js'

/** A2A TaskState（协议子集；paused 无对应态 → input-required + 说明消息）。 */
export type A2aTaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'

export interface A2aPart {
  kind: 'text'
  text: string
}

export interface A2aStatus {
  state: A2aTaskState
  message?: { role: 'agent'; parts: A2aPart[] }
  timestamp: string
}

export interface A2aArtifact {
  artifactId: string
  name: string
  parts: A2aPart[]
}

export interface A2aTask {
  id: string
  contextId: string
  kind: 'task'
  status: A2aStatus
  artifacts?: A2aArtifact[]
  metadata?: Record<string, unknown>
}

export interface A2aStatusUpdateEvent {
  kind: 'status-update'
  taskId: string
  contextId: string
  status: A2aStatus
  final: boolean
}

export interface A2aArtifactUpdateEvent {
  kind: 'artifact-update'
  taskId: string
  contextId: string
  artifact: A2aArtifact
}

export type A2aStreamEvent = A2aStatusUpdateEvent | A2aArtifactUpdateEvent

export interface AgentCardOptions {
  /** 对外可达基址（loopback 部署即 http://127.0.0.1:3930）。 */
  baseUrl: string
  slots: Pick<AgentSlot, 'id' | 'role' | 'capabilities' | 'vendor' | 'model'>[]
  version?: string
}

/** Agent Card（发现端点）：名册 → 技能表；能力位如实（流式真支持，推送 v1.0 已接线）。 */
export function buildAgentCard(opts: AgentCardOptions): Record<string, unknown> {
  return {
    name: 'dsh-pod',
    description: '多 agent 座舱编排器：Claude Code / Codex 等 CLI 员工池，目标 → 任务 DAG 协商派发 → 审查合并',
    url: `${opts.baseUrl.replace(/\/$/, '')}/a2a`,
    version: opts.version ?? '0.1.0',
    protocolVersion: '0.2.5',
    capabilities: {
      streaming: true,
      pushNotifications: true,
      stateTransitionHistory: true,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: opts.slots.map((s) => ({
      id: s.id,
      name: s.role,
      description: `${s.vendor}${s.model.length > 0 ? ` · ${s.model}` : ''} 员工；能力：${s.capabilities.join('、')}`,
      tags: s.capabilities,
    })),
    security: [{ schemes: [] }],
    securitySchemes: {},
    // v1.0 Signed Agent Card 扩展位（JWS 数组）：loopback NoAuth 场景如实给空数组；
    // 跨机/上网络时这是第一道防线（防发现环节投毒），届时填真实签名。
    signatures: [],
    supportsAuthenticatedExtendedCard: false,
    preferredTransport: 'JSONRPC',
    additionalInterfaces: [
      { transport: 'HTTPJSON', url: `${opts.baseUrl.replace(/\/$/, '')}/a2a/sendMessage` },
      { transport: 'HTTPJSON', url: `${opts.baseUrl.replace(/\/$/, '')}/a2a/sendMessageStream` },
    ],
  }
}

/** mission → A2A TaskState（对外任务 = mission；内部 agent 任务是 artifact 流）。 */
export function missionState(mission: Pick<Mission, 'status'>): A2aTaskState {
  switch (mission.status) {
    case 'planning':
    case 'running':
      return 'working'
    case 'awaiting_approval':
    case 'paused':
      return 'input-required'
    case 'done':
      return 'completed'
    case 'aborted':
      return 'canceled'
  }
}

function iso(ts: number): string {
  return new Date(ts).toISOString()
}

function statusUpdate(taskId: string, state: A2aTaskState, final: boolean, text: string, ts: number): A2aStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId: taskId,
    status: { state, message: { role: 'agent', parts: [{ kind: 'text', text }] }, timestamp: iso(ts) },
    final,
  }
}

function artifactUpdate(taskId: string, name: string, text: string, ts: number): A2aArtifactUpdateEvent {
  return {
    kind: 'artifact-update',
    taskId,
    contextId: taskId,
    artifact: { artifactId: `art-${ts}-${name}`, name, parts: [{ kind: 'text', text }] },
  }
}

/** mission → A2A Task 快照（sendMessage 的同步响应体）。 */
export function missionToA2aTask(mission: Mission, goal: string): A2aTask {
  return {
    id: mission.id,
    contextId: mission.id,
    kind: 'task',
    status: {
      state: missionState(mission),
      message: { role: 'agent', parts: [{ kind: 'text', text: `已受理：${goal.slice(0, 200)}` }] },
      timestamp: iso(mission.created_at),
    },
    metadata: {
      cwd: mission.cwd,
      budget_usd: mission.budget_usd,
      orchestration_mode: mission.orchestration_mode,
    },
  }
}

function textOf(payload: Record<string, unknown>): string {
  const t = payload.text ?? payload.detail ?? payload.reason ?? payload.note ?? ''
  return typeof t === 'string' ? t : ''
}

/**
 * 内部 PodEvent → A2A 流事件（0..n 条；未知事件返回空数组，不编造）。
 * 状态类事件收敛为 working（mission 未终态），终态由 mission_* 事件给出 final。
 */
export function internalEventToA2a(event: PodEvent): A2aStreamEvent[] {
  const taskId = event.mission_id
  const p = event.payload as Record<string, unknown>
  const label = typeof event.slot_id === 'string' ? `${event.slot_id}: ` : ''
  switch (event.kind) {
    case 'mission_started':
    case 'mission_resumed':
      return [statusUpdate(taskId, 'working', false, '编排已启动', event.ts)]
    case 'mission_awaiting_approval':
      return [statusUpdate(taskId, 'input-required', false, '等待人工审批（合并门）', event.ts)]
    case 'mission_paused':
      return [statusUpdate(taskId, 'input-required', false, '已暂停（等待人工恢复）', event.ts)]
    case 'mission_paused_stale_approval': {
      // 审批超期自动暂停（CR-01-7）：停顿明细信号（mission_paused 已给 input-required，
      // 这里给超期明细——对齐 task_rejected 双信号模式）
      const stale = Array.isArray(p.stale) ? p.stale.map(String) : []
      return [
        statusUpdate(taskId, 'input-required', false, `审批超期，已自动暂停（${stale.length} 张审批卡超期）——恢复后需人工处理`, event.ts),
        artifactUpdate(taskId, 'approval:stale', `⏰ 审批超期：${stale.join('、')}`.slice(0, 300), event.ts),
      ]
    }
    case 'mission_paused_budget':
      // 预算短路暂停（与 pause() 的 mission_paused 并发双信号：这里给预算明细）
      return [statusUpdate(taskId, 'input-required', false, `预算超限，已自动暂停：${textOf(p)}`.slice(0, 300), event.ts)]
    case 'mission_done':
      return [statusUpdate(taskId, 'completed', true, '任务完成（质量门 + 合并门全过）', event.ts)]
    case 'mission_denied':
      // 非终态（mission 状态机：deny 后回 running 重跑）。标 final 会让对端提前断流，
      // 真正的 completed 永不再达（审计修复：与 task_rejected 分支同一纪律）
      return [statusUpdate(taskId, 'working', false, `合并被拒，任务重跑：${textOf(p)}`, event.ts)]
    case 'mission_aborted':
      return [statusUpdate(taskId, 'canceled', true, `已中止：${textOf(p)}`, event.ts)]
    case 'task_negotiation': {
      const phase = typeof p.phase === 'string' ? p.phase : ''
      const who = typeof (p.to_slot ?? p.by_slot) === 'string' ? String(p.to_slot ?? p.by_slot) : '?'
      const text =
        phase === 'offer'
          ? `🤝 要约 ${event.task_id} → ${who}`
          : phase === 'accepted'
            ? `🤝 ${who} 接受 ${event.task_id}`
            : `🚫 ${who} 谢绝 ${event.task_id}（${textOf(p)}）`
      return [artifactUpdate(taskId, `negotiation:${who}`, text, event.ts)]
    }
    case 'task_rejected':
      // 能力拒绝终局（全员谢绝转人工）：mission 未终态（可重规划），不能标 rejected-final；
      // 但必须给外部驱动方一条非终态「停顿需人工」信号（v1.0 input-required 即此语义），
      // 否则任务停滞时对端只看到 working 无进展。artifact 照旧留审计细节。
      return [
        statusUpdate(taskId, 'input-required', false, `⛔ ${event.task_id} 终局拒绝（无可用员工），需人工介入：${textOf(p)}`.slice(0, 300), event.ts),
        artifactUpdate(taskId, 'negotiation:final', `⛔ ${event.task_id} 终局拒绝：${textOf(p)}`, event.ts),
      ]
    case 'task_dispatched':
      return [artifactUpdate(taskId, `task:${event.task_id ?? ''}`, `📦 ${event.task_id} 已派发给 ${p.to_slot ?? '?'}，执行中`, event.ts)]
    case 'task_started':
      return []
    case 'task_done':
      return [artifactUpdate(taskId, `task:${event.task_id ?? ''}`, `✅ ${event.task_id} 完成${typeof p.commit_sha === 'string' ? `（commit ${String(p.commit_sha).slice(0, 8)}）` : ''}`, event.ts)]
    case 'task_blocked':
      return [artifactUpdate(taskId, `task:${event.task_id ?? ''}`, `⚠️ ${event.task_id} 受阻（${p.fault ?? '?'}）：${textOf(p)}`.slice(0, 400), event.ts)]
    case 'task_escalated':
      // 转人工（attempts 烧尽 / early exit / mismatch）：同样是「停顿需人工」信号
      return [
        statusUpdate(taskId, 'input-required', false, `⛔ ${event.task_id} 转人工：${textOf(p)}`.slice(0, 300), event.ts),
        artifactUpdate(taskId, `task:${event.task_id ?? ''}`, `⛔ ${event.task_id} 转人工：${textOf(p)}`.slice(0, 400), event.ts),
      ]
    case 'task_paused':
      return [artifactUpdate(taskId, `task:${event.task_id ?? ''}`, `⏸ ${event.task_id} 已暂停（用户）`, event.ts)]
    case 'task_resumed':
      return [artifactUpdate(taskId, `task:${event.task_id ?? ''}`, `▶️ ${event.task_id} 已恢复，重新协商派发`, event.ts)]
    case 'task_question':
      return [statusUpdate(taskId, 'input-required', false, `${event.task_id} 提问：${textOf(p)}`.slice(0, 300), event.ts)]
    case 'worker_progress': {
      const text = textOf(p)
      const tool = typeof p.tool === 'string' ? p.tool : ''
      if (text.length === 0 && tool.length === 0) return []
      const toolTag = tool.length > 0 ? ` ⚒ ${tool}` : ''
      return [artifactUpdate(taskId, `stream:${event.slot_id ?? 'agent'}`, `${label}${text}${toolTag}`.slice(0, 2_000), event.ts)]
    }
    case 'agent_relay':
      return [artifactUpdate(taskId, 'relay', `🔁 ${textOf(p)}`.slice(0, 300), event.ts)]
    case 'budget_short_circuit':
      // 非终态：预算短路现在会 pause mission（编排器修复），等待人工加预算/恢复——
      // input-required 语义而非 failed(final)
      return [statusUpdate(taskId, 'input-required', false, `预算短路：剩余 ${p.remaining_usd} < 预估 ${p.estimate_usd}，mission 已暂停`, event.ts)]
    default:
      return []
  }
}

/** 是否终态事件（收到后 SSE 流收口）。 */
export function isFinalA2aEvent(e: A2aStreamEvent): boolean {
  return e.kind === 'status-update' && e.final
}

// ── Push Notification（v1.0 §4.3：客户端 webhook 回调）──

/** v1.0 PushNotificationConfig：任务更新时服务端 POST 到客户端提供的 webhook。 */
export interface A2aPushConfig {
  url: string
  /** SDK 默认头名 X-A2A-Notification-Token 携带（authentication 未给时）。 */
  token?: string
  /** v1.0 AuthenticationInfo：scheme 必填（Bearer/Basic…），credentials 可选。 */
  authentication?: { scheme: string; credentials?: string }
}

/**
 * 从 sendMessage 参数提取 `configuration.pushNotificationConfig`。
 * fail-closed：缺失 / 形状不对 / url 非 http(s) → undefined（当作没配，不抛错不编造）。
 * SSRF 注意（v1.0 安全要求）：服务端不得盲目信任 webhook URL——本实现只放行 http(s)
 * scheme + 10s 超时 + 2 次尝试；loopback-only 的 A2A 入口本身已限攻击面，allowlist 属部署侧。
 */
export function parsePushConfig(params: unknown): A2aPushConfig | undefined {
  const cfg =
    params !== null && typeof params === 'object'
      ? (params as { configuration?: { pushNotificationConfig?: unknown } }).configuration
      : undefined
  const raw = cfg !== null && typeof cfg === 'object' ? cfg.pushNotificationConfig : undefined
  if (raw === null || typeof raw !== 'object') return undefined
  const url = (raw as { url?: unknown }).url
  if (typeof url !== 'string' || url.length === 0) return undefined
  let scheme: string
  try {
    scheme = new URL(url).protocol
  } catch {
    return undefined
  }
  if (scheme !== 'http:' && scheme !== 'https:') return undefined
  const out: A2aPushConfig = { url }
  const token = (raw as { token?: unknown }).token
  if (typeof token === 'string' && token.length > 0) out.token = token
  const auth = (raw as { authentication?: unknown }).authentication
  if (auth !== null && typeof auth === 'object') {
    const s = (auth as { scheme?: unknown }).scheme
    if (typeof s === 'string' && s.length > 0) {
      out.authentication = { scheme: s }
      const cred = (auth as { credentials?: unknown }).credentials
      if (typeof cred === 'string' && cred.length > 0) out.authentication.credentials = cred
    }
  }
  return out
}

/**
 * 回调鉴权头（v1.0 §4.3.1）：authentication 优先 → `Authorization: <scheme> <credentials>`；
 * 其次 token → `X-A2A-Notification-Token`（JS SDK 默认头名）；两者皆缺 → 不带鉴权头
 * （loopback 场景合法，但客户端应自行校验来源）。
 */
export function buildPushHeaders(config: A2aPushConfig): Record<string, string> {
  const headers: Record<string, string> = {}
  if (config.authentication !== undefined) {
    headers.authorization =
      config.authentication.credentials !== undefined
        ? `${config.authentication.scheme} ${config.authentication.credentials}`
        : config.authentication.scheme
  } else if (config.token !== undefined) {
    headers['x-a2a-notification-token'] = config.token
  }
  return headers
}
