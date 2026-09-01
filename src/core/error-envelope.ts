/**
 * worker ↔ 编排器结构化错误信封（P2-2，调研 §3.2）。
 *
 * ## 为什么要有它
 *
 * 旧链路：worker 失败 → 取 stderr 最后 12 行 → `classifyFault` 用正则嗅探
 * （`/auth|credential|expired|unauthorized|401/i`）判定故障类型。问题是这 12 行是
 * **自然语言**，厂商措辞一变解析就漂；而且它要进编排器上下文才有用，等于花 token
 * 买一个不稳定的判定。
 *
 * 新链路：worker 侧把它已经**结构化持有**的信号（claude 的 result.is_error /
 * api_retry、codex 的 ERROR JSON 行）收敛成一个有界信封，编排器按短码做确定性分流。
 *
 * ## 设计原则（ADOL「verbose 可控」）
 *
 * - **给机器短码**：`error_code` 是分类的唯一依据，正则嗅探降级为兜底。
 * - **给人留全文**：`hint_ref` 只进事件审计与 UI，**不进 LLM 上下文**。
 *   stderr 12 行同理降级为纯调试材料，只在转人工时给人看。
 * - **fail-closed**：信封解析失败/短码未知 → 返回 undefined / null，回落到既有
 *   分类逻辑。宁可少一次确定性判定，不可错判。
 */

import type { FaultKind } from './types.js'

/** worker 结构化错误信封（有界：字段固定、字符串长度受限）。 */
export interface WorkerErrorEnvelope {
  /** 机器可读短码，大写下划线，如 `AUTH_401` / `RATE_LIMIT_429`。 */
  error_code: string
  /** 是否值得自动重试（编排器据此决定走重试还是直接转人工）。 */
  retriable: boolean
  /** 给人看的定位线索（进事件审计与 UI，不进 LLM 上下文）。 */
  hint_ref?: string
}

/** stdout/stderr 行内信封前缀（worker 与 adapter 可显式输出，属前瞻通道）。 */
export const ERROR_ENVELOPE_PREFIX = 'POD_ERROR '

/** 单行信封字节上限（防止 worker 灌爆事件面）。 */
export const ERROR_ENVELOPE_MAX_LINE = 512

/** hint_ref 长度上限。 */
export const ERROR_ENVELOPE_MAX_HINT = 400

/**
 * 短码前缀 → FaultKind（按首段前缀匹配，便于扩展而不改表）。
 *
 * 例：`AUTH_401` / `AUTH_EXPIRED` / `AUTH` 都命中 `AUTH`。
 * 刻意不做全表精确匹配——厂商错误码后缀会变，前缀语义稳定。
 */
const CODE_PREFIX_FAULTS: ReadonlyArray<readonly [string, FaultKind]> = [
  ['AUTH', 'auth_expired'],
  ['UNAUTHORIZED', 'auth_expired'],
  ['CREDENTIAL', 'auth_expired'],
  ['RATE_LIMIT', 'rate_limited'],
  ['QUOTA', 'rate_limited'],
  ['NEED_CLARIFY', 'need_clarify'],
  ['AMBIGUOUS', 'need_clarify'],
  ['WALL_CLOCK', 'wall_clock'],
  ['IDLE', 'idle_timeout'],
  ['SILENT', 'silent_failure'],
  ['MISMATCH', 'mismatch'],
  ['STREAM', 'stream_broken'],
  ['CRASH', 'crash'],
  ['INTERNAL', 'crash'],
]

/**
 * 短码 → FaultKind（确定性分流，喂现有 feedback 环）。
 *
 * 未知短码返回 null（fail-closed）：调用方回落到既有分类，绝不猜。
 */
export function faultFromEnvelopeCode(code: string): FaultKind | null {
  const normalized = code.trim().toUpperCase()
  if (normalized.length === 0) return null
  for (const [prefix, fault] of CODE_PREFIX_FAULTS) {
    if (normalized === prefix || normalized.startsWith(`${prefix}_`) || normalized.startsWith(`${prefix}-`)) {
      return fault
    }
  }
  return null
}

/** 短码是否默认可重试（编排器未显式指定 retriable 时的兜底语义）。 */
export function defaultRetriable(code: string): boolean {
  const fault = faultFromEnvelopeCode(code)
  // 只有限流与瞬时崩溃值得自动重试；凭据/规格类问题重试只会再烧一轮
  return fault === 'rate_limited' || fault === 'crash' || fault === 'stream_broken'
}

/**
 * 从一行 stdout/stderr 解析信封。
 *
 * 只认 `POD_ERROR ` 前缀的裸行（stream-json 行本身是 JSON，不会误命中）。
 * 解析失败、字段缺失、超长一律返回 undefined（fail-closed）。
 */
export function parseErrorEnvelope(line: string): WorkerErrorEnvelope | undefined {
  const trimmed = line.trim()
  if (trimmed.length > ERROR_ENVELOPE_MAX_LINE) return undefined
  if (!trimmed.startsWith(ERROR_ENVELOPE_PREFIX)) return undefined
  const raw = trimmed.slice(ERROR_ENVELOPE_PREFIX.length)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const code = record.error_code
  if (typeof code !== 'string' || code.trim().length === 0) return undefined
  const hint = typeof record.hint_ref === 'string' ? record.hint_ref.slice(0, ERROR_ENVELOPE_MAX_HINT) : undefined
  return {
    error_code: code.trim().toUpperCase(),
    retriable: typeof record.retriable === 'boolean' ? record.retriable : defaultRetriable(code),
    ...(hint !== undefined && hint.length > 0 ? { hint_ref: hint } : {}),
  }
}

/**
 * 从一组行里取最后一个有效信封（worker 可能输出多行，取最后一条＝最终结论）。
 */
export function lastErrorEnvelope(lines: readonly string[]): WorkerErrorEnvelope | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const envelope = parseErrorEnvelope(lines[i] ?? '')
    if (envelope !== undefined) return envelope
  }
  return undefined
}

/**
 * 构造信封（供 adapter 从自己已结构化的信号生成）。
 * hint 超长截断——审计要留痕，但不能让事件面被灌爆。
 */
export function makeEnvelope(code: string, retriable?: boolean, hint?: string): WorkerErrorEnvelope {
  const normalized = code.trim().toUpperCase()
  return {
    error_code: normalized,
    retriable: retriable ?? defaultRetriable(normalized),
    ...(hint !== undefined && hint.trim().length > 0 ? { hint_ref: hint.trim().slice(0, ERROR_ENVELOPE_MAX_HINT) } : {}),
  }
}
