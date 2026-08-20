/**
 * 交接协议 —— 方案书 2.5 节 / 3.5 节。
 *
 * 核心原则：消息传指针和意图，磁盘传内容（工作区即共享内存）。
 * 交接消息四件套（intent/artifacts/state/expected_output）+ 第五项增强：
 * verify 可检查物列表——收方（collector/校验层）不信任叙事，只验证可检查物
 * （静默假成功对策，附录 F-25）。
 *
 * 2×3 投递语义矩阵（D2 / 2.5 节）：投递模式（queue|memory）× 会话档位
 * （transient|per-mission|auto-reset）→ planDelivery 的六种确定性动作。
 */

import { HandoffValidationError, NotFoundError } from './errors.js'
import type { PodStore } from './store.js'
import type { AgentSlot, Handoff, HandoffMode, HandoffPayload, SessionTier } from './types.js'

/** 已知可检查物清单（附录 B verify 字段；未知检查项 fail-closed）。 */
export const KNOWN_VERIFY_CHECKS: ReadonlySet<string> = new Set([
  'commit_exists',
  'diff_range_valid',
  'test_log_exists',
  'report_fields_complete',
  'path_whitelist',
])

export interface HandoffDraft {
  from_slot: string
  to_slot: string
  task_id: string
  payload: HandoffPayload
  mode: HandoffMode
}

export interface HandoffBuildOptions {
  clock?: () => number
  idFn?: () => string
}

/** 2×3 矩阵的确定性投递动作（3.2 节表）。 */
export type DeliveryAction =
  | { kind: 'new-process'; inject: 'task-prompt-prefix' }
  | { kind: 'resume-session'; inject: 'task-prompt' }
  | { kind: 'reset-session'; inject: 'structured-summary' }
  | { kind: 'memory-file'; carry: 'next-dispatch' | 'mandatory' }
  | { kind: 'context-append'; interrupt: false }

export function validateHandoffPayload(payload: HandoffPayload): { check: string; detail: string }[] {
  const failures: { check: string; detail: string }[] = []
  const fail = (check: string, detail: string): void => {
    failures.push({ check, detail })
  }

  if (!payload.intent?.brief.trim()) fail('intent_brief', 'intent.brief must be non-empty')
  if (!payload.intent?.acceptance.trim()) fail('intent_acceptance', 'intent.acceptance must be non-empty')
  if (!payload.artifacts?.spec.trim()) fail('artifacts_spec', 'artifacts.spec must point at the plan/spec on disk')

  const files = payload.artifacts?.context_files ?? []
  for (const file of files) {
    if (file.includes('..') || file.startsWith('/') || /^[a-zA-Z]:/.test(file)) {
      fail('context_files_path', `context file outside mission tree: ${file}`)
    }
  }

  const verify = payload.verify ?? []
  if (verify.length === 0) {
    fail('verify_checks', 'verify list must name at least one checkable artifact')
  }
  for (const check of verify) {
    if (!KNOWN_VERIFY_CHECKS.has(check)) {
      fail('verify_known', `unknown verify check: ${check}`)
    }
  }
  return failures
}

/** 构造并落盘交接消息；事件流与交接记录一一对应（3.5 节）。 */
export function buildHandoff(store: PodStore, draft: HandoffDraft, options: HandoffBuildOptions = {}): Handoff {
  const clock = options.clock ?? (() => Date.now())
  const idFn = options.idFn ?? (() => `H-${clock()}-${Math.floor(Math.random() * 1e6)}`)

  const failures = validateHandoffPayload(draft.payload)
  if (failures.length > 0) throw new HandoffValidationError(failures)

  const from = store.getSlot(draft.from_slot)
  if (from === undefined) throw new NotFoundError('slot', draft.from_slot)
  const to = store.getSlot(draft.to_slot)
  if (to === undefined) throw new NotFoundError('slot', draft.to_slot)
  const task = store.getTask(draft.task_id)
  if (task === undefined) throw new NotFoundError('task', draft.task_id)
  if (task.mission_id !== from.mission_id || task.mission_id !== to.mission_id) {
    throw new HandoffValidationError([{ check: 'mission_scope', detail: 'slots and task must share one mission' }])
  }

  const handoff: Handoff = {
    id: idFn(),
    mission_id: task.mission_id,
    from_slot: draft.from_slot,
    to_slot: draft.to_slot,
    task_id: draft.task_id,
    payload: structuredClone(draft.payload),
    mode: draft.mode,
    ts: clock(),
  }
  store.addHandoff(handoff)
  store.appendEvent(handoff.mission_id, {
    id: `ev-handoff-${handoff.id}`,
    mission_id: handoff.mission_id,
    ts: handoff.ts,
    kind: 'handoff_created',
    task_id: handoff.task_id,
    slot_id: handoff.to_slot,
    payload: { handoff_id: handoff.id, from: handoff.from_slot, to: handoff.to_slot, mode: handoff.mode },
  })
  return handoff
}

/** 2×3 投递语义矩阵：投递模式 × 会话档位 → 确定性动作。 */
export function planDelivery(slot: Pick<AgentSlot, 'session_tier'>, mode: HandoffMode): DeliveryAction {
  return deliveryMatrix[slot.session_tier][mode]
}

const deliveryMatrix: Record<SessionTier, Record<HandoffMode, DeliveryAction>> = {
  transient: {
    queue: { kind: 'new-process', inject: 'task-prompt-prefix' },
    memory: { kind: 'memory-file', carry: 'next-dispatch' },
  },
  'per-mission': {
    queue: { kind: 'resume-session', inject: 'task-prompt' },
    memory: { kind: 'context-append', interrupt: false },
  },
  'auto-reset': {
    queue: { kind: 'reset-session', inject: 'structured-summary' },
    memory: { kind: 'memory-file', carry: 'mandatory' },
  },
}
