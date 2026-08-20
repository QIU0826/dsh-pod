/**
 * Pod 错误体系 —— error-handling skill：类型化错误、错误码即 API 契约、
 * 用户消息 ≠ 开发者消息、永不静默吞错。
 *
 * 所有 PodError 都是结构化值：code 稳定（对外契约）、retryable 决定重试策略、
 * details 携带完整上下文（落日志），userMessage 面向 UI 与 LLM 反馈。
 */

export class PodError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
    public readonly retryable: boolean = false,
  ) {
    super(message)
    this.name = new.target.name
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** 状态机非法迁移（3.3 节不变量 1：LLM 提议、代码裁决）。 */
export class InvalidTransitionError extends PodError {
  constructor(from: string, to: string, reason: string) {
    super(
      `illegal transition: ${from} -> ${to} (${reason})`,
      'INVALID_TRANSITION',
      { from, to, reason },
      false,
    )
  }
}

export class NotFoundError extends PodError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND', { resource, id }, false)
  }
}

export class DuplicateIdError extends PodError {
  constructor(resource: string, id: string) {
    super(
      `${resource} id already exists: ${id}`,
      'DUPLICATE_ID',
      { resource, id },
      false,
    )
  }
}

/** 审批卡冲突：重复 approve/deny 等。 */
export class ApprovalConflictError extends PodError {
  constructor(approvalId: string, expected: string, actual: string) {
    super(
      `approval ${approvalId} expected ${expected}, got ${actual}`,
      'APPROVAL_CONFLICT',
      { approvalId, expected, actual },
      false,
    )
  }
}

/** 未实现的功能位（审批模式 2/3 等，显式拒绝而非静默降级）。 */
export class UnsupportedError extends PodError {
  constructor(feature: string, hint: string) {
    super(`${feature} is not supported in this version (${hint})`, 'UNSUPPORTED', { feature }, false)
  }
}

/** 预算熔断（2.7 节）。 */
export class BudgetExceededError extends PodError {
  constructor(
    missionId: string,
    public readonly spentTokens: number,
    public readonly limitTokens: number | undefined,
    public readonly spentUsd: number,
    public readonly limitUsd: number,
  ) {
    super(
      `budget exceeded for mission ${missionId}: tokens=${spentTokens}/${limitTokens ?? '∞'}, usd=${spentUsd.toFixed(4)}/${limitUsd}`,
      'BUDGET_EXCEEDED',
      { missionId, spentTokens, limitTokens, spentUsd, limitUsd },
      false,
    )
  }
}

/** Verifier 产物校验失败（3.4 节静默假成功对策）。 */
export class VerificationError extends PodError {
  constructor(public readonly failures: VerifyFailure[]) {
    super(
      `artifact verification failed: ${failures.map((f) => f.check).join(', ')}`,
      'VERIFY_FAILED',
      { failures },
      false,
    )
  }
}

export interface VerifyFailure {
  check: string
  detail: string
}

/** Store 层错误。 */
export class StoreCorruptError extends PodError {
  constructor(public readonly path: string, public readonly backupPath: string | undefined) {
    super(
      `store file corrupt: ${path}${backupPath ? ` (backup also failed: ${backupPath})` : ''}`,
      'STORE_CORRUPT',
      { path, backupPath },
      false,
    )
  }
}

export class StoreWriteError extends PodError {
  constructor(path: string, cause: unknown) {
    super(`store write failed: ${path}`, 'STORE_WRITE_FAILED', { path, cause }, true)
  }
}

/** 外部 CLI / 探测失败（preflight 层）。 */
export class PreflightError extends PodError {
  constructor(checkId: string, detail: string, cause?: unknown) {
    super(`preflight check ${checkId} failed: ${detail}`, 'PREFLIGHT_FAILED', { checkId, detail, cause }, false)
  }
}

/** 交接 payload 不合法。 */
export class HandoffValidationError extends PodError {
  constructor(public readonly failures: VerifyFailure[]) {
    super(
      `handoff payload invalid: ${failures.map((f) => f.check).join(', ')}`,
      'HANDOFF_INVALID',
      { failures },
      false,
    )
  }
}

/** MISSION_REPORT 字段不齐（输出契约，附录 C）。 */
export class InvalidReportError extends PodError {
  constructor(field: string, detail: string) {
    super(`mission report invalid: ${field} (${detail})`, 'INVALID_REPORT', { field }, false)
  }
}

/** 并发限制（2.12 节单 active mission / 3.8 节 fan-out 限流）。 */
export class ConcurrencyLimitError extends PodError {
  constructor(limit: number, detail: string) {
    super(`concurrency limit ${limit} exceeded: ${detail}`, 'CONCURRENCY_LIMIT', { limit }, false)
  }
}

/** 用户可读消息映射（error-handling skill：技术细节不进 UI）。 */
const USER_MESSAGES: Record<string, string> = {
  INVALID_TRANSITION: '该操作与当前状态冲突，已拒绝。',
  NOT_FOUND: '找不到请求的对象。',
  DUPLICATE_ID: 'ID 已存在，请换一个。',
  APPROVAL_CONFLICT: '该审批卡已被处理，请刷新。',
  UNSUPPORTED: '当前版本不支持该功能。',
  BUDGET_EXCEEDED: '预算已耗尽，任务已暂停。',
  VERIFY_FAILED: '产物校验未通过：报告与产物不一致。',
  STORE_CORRUPT: '本地状态文件损坏（已保留损坏文件供排查）。',
  STORE_WRITE_FAILED: '状态写入失败，请检查磁盘。',
  PREFLIGHT_FAILED: '环境检查未通过。',
  HANDOFF_INVALID: '交接消息不完整，已拒绝派发。',
  INVALID_REPORT: '任务报告字段不齐全，已拒绝。',
  CONCURRENCY_LIMIT: '超出并发限制。',
  INTERNAL: '发生意外错误，详见日志。',
}

/** 错误码 → 用户可读文案（UI / LLM 反馈用，不含技术细节）。 */
export function getUserMessage(code: string): string {
  return USER_MESSAGES[code] ?? USER_MESSAGES.INTERNAL!
}

/** 判定一个未知值是否为 PodError（跨模块边界的安全识别）。 */
export function isPodError(value: unknown): value is PodError {
  return value instanceof PodError
}

/** 未知异常 → PodError 归一化（边界收口：绝不把裸异常抛给上层）。 */
export function toPodError(value: unknown): PodError {
  if (value instanceof PodError) return value
  if (value instanceof Error) {
    return new PodError(value.message, 'INTERNAL', { cause: String(value.stack ?? value) }, false)
  }
  return new PodError(String(value), 'INTERNAL', { cause: value }, false)
}
