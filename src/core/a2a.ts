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

/** Agent Card（发现端点）：名册 → 技能表；能力位如实（流式 = SSE 真支持）。 */
export function buildAgentCard(opts: AgentCardOptions): Record<string, unknown> {
  return {
    name: 'dsh-pod',
    description: '多 agent 座舱编排器：Claude Code / Codex 等 CLI 员工池，目标 → 任务 DAG 协商派发 → 审查合并',
    url: `${opts.baseUrl.replace(/\/$/, '')}/a2a`,
    version: opts.version ?? '0.1.0',
    protocolVersion: '0.2.5',
    capabilities: {
      streaming: true,
      pushNotifications: false,
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
    case 'mission_done':
      return [statusUpdate(taskId, 'completed', true, '任务完成（质量门 + 合并门全过）', event.ts)]
    case 'mission_denied':
      return [statusUpdate(taskId, 'rejected', true, `合并被拒：${textOf(p)}`, event.ts)]
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
      return [artifactUpdate(taskId, 'negotiation:final', `⛔ ${event.task_id} 终局拒绝：${textOf(p)}`, event.ts)]
    case 'task_dispatched':
      return [artifactUpdate(taskId, `task:${event.task_id ?? ''}`, `📦 ${event.task_id} 已派发给 ${p.to_slot ?? '?'}，执行中`, event.ts)]
    case 'task_started':
      return []
    case 'task_done':
      return [artifactUpdate(taskId, `task:${event.task_id ?? ''}`, `✅ ${event.task_id} 完成${typeof p.commit_sha === 'string' ? `（commit ${String(p.commit_sha).slice(0, 8)}）` : ''}`, event.ts)]
    case 'task_blocked':
      return [artifactUpdate(taskId, `task:${event.task_id ?? ''}`, `⚠️ ${event.task_id} 受阻（${p.fault ?? '?'}）：${textOf(p)}`.slice(0, 400), event.ts)]
    case 'task_escalated':
      return [artifactUpdate(taskId, `task:${event.task_id ?? ''}`, `⛔ ${event.task_id} 转人工：${textOf(p)}`.slice(0, 400), event.ts)]
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
      return [statusUpdate(taskId, 'failed', true, `预算短路：剩余 ${p.remaining_usd} < 预估 ${p.estimate_usd}`, event.ts)]
    default:
      return []
  }
}

/** 是否终态事件（收到后 SSE 流收口）。 */
export function isFinalA2aEvent(e: A2aStreamEvent): boolean {
  return e.kind === 'status-update' && e.final
}
