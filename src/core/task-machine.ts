/**
 * Task 状态机 —— 方案书 3.4 节核心资产。
 *
 * 设计不变量（3.3 节）：LLM 提议、代码裁决。所有状态迁移走本模块的显式事件入口，
 * 非法迁移抛 InvalidTransitionError；迁移合法性只由代码判定，与调用方（commander
 * LLM / 手动模式 UI）无关——手动模式与 commander 走同一套代码入口。
 *
 * 故障分类全集（3.4 节故障表 + CR-01-6）：
 *   crash/idle_timeout/wall_clock/silent_failure → attempts+1
 *   rate_limited/need_clarify → soft_attempts+1，不计 attempts
 *   auth_expired → slot error，停止重试
 *   mismatch → 直接转人工（escalated）
 *   attempts ≥ 3 → 转人工（escalated，Canvas 弹接管卡）
 */

import {
  InvalidReportError,
  InvalidTransitionError,
  NotFoundError,
  VerificationError,
} from './errors'
import type { PodStore } from './store'
import type {
  AgentSlot,
  FaultKind,
  MissionReport,
  PodEvent,
  Task,
  TaskStatus,
} from './types'
import { RATE_LIMIT_BACKOFF_BASE_MS, RATE_LIMIT_BACKOFF_MAX_MS } from './types'

export interface FaultInfo {
  kind: FaultKind
  message: string
  exitCode?: number
  questions?: string[]
}

export interface TaskVerifyResult {
  ok: boolean
  commit_sha?: string
  parent_sha?: string
  failures: { check: string; detail: string }[]
  /** 叙事与产物不符（3.4 节 mismatch）→ 转人工。 */
  mismatch: boolean
}

/** Verifier 注入点（verifier.ts 提供真实实现；测试注入 mock）。 */
export type TaskVerifyFn = (task: Task, report: MissionReport) => Promise<TaskVerifyResult>

export interface TaskMachineOptions {
  clock?: () => number
  rng?: () => number
  verify?: TaskVerifyFn
}

interface FaultSignals {
  exit?: 'done' | 'failed' | 'killed' | 'timeout' | 'rate_limited'
  exitCode?: number
  stderrTail?: string
}

/** 凭据过期特征（3.4 节故障表：preflight 式 auth 探测）。 */
const AUTH_EXPIRED_PATTERN = /auth|credential|expired|unauthorized|not logged in|401/i

/** 429 特征（输出或退出码）。 */
const RATE_LIMIT_PATTERN = /429|rate limit|too many requests/i

/** worker 原始信号 → FaultKind（429 与凭据过期可自动判定，其余由调用方显式给出）。 */
export function classifyFault(signals: FaultSignals): FaultKind | null {
  if (signals.exit === 'rate_limited' || RATE_LIMIT_PATTERN.test(signals.stderrTail ?? '')) {
    return 'rate_limited'
  }
  if (
    (signals.exit === 'failed' || signals.exit === 'killed') &&
    AUTH_EXPIRED_PATTERN.test(signals.stderrTail ?? '')
  ) {
    return 'auth_expired'
  }
  if (signals.exit === 'failed' || (signals.exitCode !== undefined && signals.exitCode !== 0)) {
    return 'crash'
  }
  return null
}

/** 指数退避（3.4 节）：min(base·2^(n-1) + jitter, max)。 */
export function rateLimitBackoff(softAttempts: number, rng: () => number): number {
  const exp = Math.min(Math.pow(2, Math.max(softAttempts - 1, 0)), 128)
  const delay = RATE_LIMIT_BACKOFF_BASE_MS * exp + rng() * RATE_LIMIT_BACKOFF_BASE_MS
  return Math.min(delay, RATE_LIMIT_BACKOFF_MAX_MS)
}

const RETRYABLE_FROM: ReadonlySet<TaskStatus> = new Set(['ready', 'blocked'])
const FAILABLE_FROM: ReadonlySet<TaskStatus> = new Set(['dispatched', 'running'])

function event(missionId: string, kind: string, task: Task, payload: Record<string, unknown>, now: number): PodEvent {
  return {
    id: `ev-${kind}-${task.id}-${now}-${Math.floor(Math.random() * 1e9)}`,
    mission_id: missionId,
    ts: now,
    kind,
    task_id: task.id,
    slot_id: task.owner_slot_id,
    payload,
  }
}

export class TaskMachine {
  private readonly store: PodStore
  private readonly clock: () => number
  private readonly rng: () => number
  private readonly verify: TaskVerifyFn

  constructor(store: PodStore, options: TaskMachineOptions = {}) {
    this.store = store
    this.clock = options.clock ?? (() => Date.now())
    this.rng = options.rng ?? Math.random
    this.verify = options.verify ?? defaultVerify
  }

  private getTask(taskId: string): Task {
    const task = this.store.getTask(taskId)
    if (task === undefined) throw new NotFoundError('task', taskId)
    return task
  }

  private getSlot(slotId: string): AgentSlot {
    const slot = this.store.getSlot(slotId)
    if (slot === undefined) throw new NotFoundError('slot', slotId)
    return slot
  }

  private emit(task: Task, kind: string, payload: Record<string, unknown>): void {
    this.store.appendEvent(task.mission_id, event(task.mission_id, kind, task, payload, this.clock()))
  }

  /** 派发（ready | 可重试的 blocked → dispatched）。429 退避期内的重试被拒绝。 */
  dispatch(taskId: string, slotId: string): void {
    const task = this.getTask(taskId)
    const slot = this.getSlot(slotId)
    if (!RETRYABLE_FROM.has(task.status)) {
      throw new InvalidTransitionError(task.status, 'dispatched', 'only ready or retryable blocked tasks can be dispatched')
    }
    if (task.status === 'blocked' && !this.shouldRetry(task, this.clock())) {
      throw new InvalidTransitionError('blocked', 'dispatched', this.retryBlockReason(task))
    }
    if (slot.mission_id !== task.mission_id) {
      throw new InvalidTransitionError(task.status, 'dispatched', 'slot belongs to another mission')
    }
    this.store.updateTask(taskId, {
      status: 'dispatched',
      owner_slot_id: slotId,
      dispatched_at: this.clock(),
      next_retry_at: undefined,
      fault: undefined,
      last_error: undefined,
    })
    this.store.updateSlot(slotId, { status: 'working' })
    this.emit(this.getTask(taskId), 'task_dispatched', { to_slot: slotId })
  }

  private retryBlockReason(task: Task): string {
    if (task.fault === 'auth_expired') return 'auth expired: no retry'
    if (task.attempts >= 3) return 'attempts exhausted: escalate instead'
    if ((task.next_retry_at ?? 0) > this.clock()) return 'rate-limit backoff not elapsed'
    return 'not retryable'
  }

  /** 任务是否具备重试资格（3.4 节：429 不计 attempts；auth_expired 不重试；≥3 转人工）。 */
  shouldRetry(task: Task, at: number): boolean {
    if (task.status !== 'blocked') return false
    if (task.fault === 'auth_expired') return false
    if (task.attempts >= 3) return false
    return (task.next_retry_at ?? 0) <= at
  }

  start(taskId: string): void {
    const task = this.getTask(taskId)
    if (task.status !== 'dispatched') {
      throw new InvalidTransitionError(task.status, 'running', 'task must be dispatched first')
    }
    this.store.updateTask(taskId, { status: 'running', started_at: this.clock() })
    this.emit(this.getTask(taskId), 'task_started', {})
  }

  /**
   * 收集 MISSION_REPORT。done 报告必须先过 Verifier（静默假成功对策）：
   * 校验不过 → silent_failure（attempts+1）；叙事与产物不符 → mismatch 转人工。
   */
  async report(taskId: string, report: MissionReport): Promise<void> {
    const task = this.getTask(taskId)
    if (task.status !== 'running') {
      throw new InvalidTransitionError(task.status, 'report', 'only a running task can report')
    }
    if (report.task_id !== task.id) {
      throw new InvalidReportError('task_id', `report.task_id=${report.task_id} != task.id=${task.id}`)
    }
    if (report.status === 'done') {
      const verdict = await this.verify(task, report)
      if (verdict.mismatch) {
        this.escalateInternal(task, 'report narrative does not match artifacts (mismatch)', verdict.failures)
        return
      }
      if (!verdict.ok) {
        const failure = new VerificationError(verdict.failures)
        this.applyFailure(task, 'silent_failure', failure.message)
        return
      }
      this.store.updateTask(taskId, {
        status: 'done',
        commit_sha: verdict.commit_sha ?? report.commit_sha,
        parent_sha: verdict.parent_sha,
        result_ref: report.diff_path,
        done_at: this.clock(),
      })
      this.releaseSlot(task)
      this.emit(this.getTask(taskId), 'task_done', { commit_sha: verdict.commit_sha ?? report.commit_sha })
      return
    }
    if (report.status === 'need_clarify') {
      this.applyFailure(task, 'need_clarify', report.questions.join('; ') || 'needs clarification', { soft: true })
      return
    }
    this.applyFailure(task, 'crash', report.blockers.join('; ') || 'reported blocked', { fromReport: true })
  }

  /** 运行时故障入口（watchdog / worker 层调用）。 */
  fail(taskId: string, fault: FaultInfo): void {
    const task = this.getTask(taskId)
    if (!FAILABLE_FROM.has(task.status)) {
      throw new InvalidTransitionError(task.status, 'blocked', 'only dispatched or running tasks can fail')
    }
    if (fault.kind === 'rate_limited') {
      this.applyFailure(task, 'rate_limited', fault.message, { soft: true })
      return
    }
    if (fault.kind === 'auth_expired') {
      this.applyFailure(task, 'auth_expired', fault.message, { auth: true })
      return
    }
    this.applyFailure(task, fault.kind, fault.message)
  }

  /** 转人工（commander 决策或 UI 手动模式直接调用；也是 mismatch 的落点）。 */
  escalate(taskId: string): void {
    const task = this.getTask(taskId)
    if (task.status !== 'blocked') {
      throw new InvalidTransitionError(task.status, 'escalated', 'only blocked tasks escalate')
    }
    this.escalateInternal(task, 'escalated by operator', [])
  }

  private escalateInternal(task: Task, reason: string, failures: { check: string; detail: string }[]): void {
    this.store.updateTask(task.id, {
      status: 'escalated',
      escalated_at: this.clock(),
      last_error: reason,
      fault: task.fault,
    })
    this.releaseSlot(task)
    this.emit(this.getTask(task.id), 'task_escalated', { reason, failures })
  }

  /** 统一失败落点：attempts/soft 计数、退避、升级判定、slot 状态。 */
  private applyFailure(
    task: Task,
    kind: FaultKind,
    message: string,
    options: { soft?: boolean; auth?: boolean; fromReport?: boolean } = {},
  ): void {
    const now = this.clock()
    const attempts = options.soft ? task.attempts : task.attempts + 1
    const softAttempts = task.soft_attempts + 1
    const nextRetryAt = kind === 'rate_limited' ? now + rateLimitBackoff(softAttempts, this.rng) : now
    const escalated = !options.soft && !options.auth && attempts >= 3
    this.store.updateTask(task.id, {
      status: escalated ? 'escalated' : 'blocked',
      fault: kind,
      last_error: message,
      attempts,
      soft_attempts: softAttempts,
      next_retry_at: kind === 'auth_expired' ? undefined : nextRetryAt,
      escalated_at: escalated ? now : undefined,
    })
    if (options.auth && task.owner_slot_id !== undefined) {
      this.store.updateSlot(task.owner_slot_id, { status: 'error' })
    } else if (kind === 'rate_limited' && task.owner_slot_id !== undefined) {
      this.store.updateSlot(task.owner_slot_id, { status: 'rate_limited' })
    } else {
      this.releaseSlot(task)
    }
    this.emit(this.getTask(task.id), escalated ? 'task_escalated' : 'task_blocked', {
      fault: kind,
      attempts,
      message,
    })
  }

  /** 任务结束 → 槽位回 idle（error/rate_limited 由调用方显式处理）。 */
  private releaseSlot(task: Task): void {
    if (task.owner_slot_id === undefined) return
    const slot = this.store.getSlot(task.owner_slot_id)
    if (slot !== undefined && slot.status === 'working') {
      this.store.updateSlot(slot.id, { status: 'idle' })
    }
  }
}

/** 默认 Verifier：未注入时拒绝一切 done 报告（fail-closed，防止绕过校验）。 */
const defaultVerify: TaskVerifyFn = async () => ({
  ok: false,
  failures: [{ check: 'verifier_configured', detail: 'no verifier injected; done reports are rejected by default' }],
  mismatch: false,
})
