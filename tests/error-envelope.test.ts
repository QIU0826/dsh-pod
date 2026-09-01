import { describe, expect, it } from 'vitest'
import {
  ERROR_ENVELOPE_MAX_HINT,
  ERROR_ENVELOPE_PREFIX,
  defaultRetriable,
  faultFromEnvelopeCode,
  lastErrorEnvelope,
  makeEnvelope,
  parseErrorEnvelope,
} from '../src/core/error-envelope.js'

describe('faultFromEnvelopeCode（短码 → FaultKind，前缀匹配）', () => {
  it('精确短码与带后缀短码都命中前缀', () => {
    expect(faultFromEnvelopeCode('AUTH_401')).toBe('auth_expired')
    expect(faultFromEnvelopeCode('AUTH_EXPIRED')).toBe('auth_expired')
    expect(faultFromEnvelopeCode('AUTH')).toBe('auth_expired')
    expect(faultFromEnvelopeCode('UNAUTHORIZED_403')).toBe('auth_expired')
    expect(faultFromEnvelopeCode('RATE_LIMIT_429')).toBe('rate_limited')
    expect(faultFromEnvelopeCode('QUOTA_EXCEEDED')).toBe('rate_limited')
    expect(faultFromEnvelopeCode('WALL_CLOCK_TIMEOUT')).toBe('wall_clock')
    expect(faultFromEnvelopeCode('STREAM_BROKEN')).toBe('stream_broken')
    expect(faultFromEnvelopeCode('CRASH')).toBe('crash')
  })
  it('大小写与空白不敏感', () => {
    expect(faultFromEnvelopeCode('  auth_401  ')).toBe('auth_expired')
    expect(faultFromEnvelopeCode('RATE_LIMIT-429')).toBe('rate_limited')
  })
  it('未知短码 → null（fail-closed，绝不猜）', () => {
    expect(faultFromEnvelopeCode('MARTIAN_9000')).toBe(null)
    expect(faultFromEnvelopeCode('')).toBe(null)
    expect(faultFromEnvelopeCode('   ')).toBe(null)
  })
})

describe('defaultRetriable（未显式指定 retriable 时的兜底语义）', () => {
  it('限流/瞬时崩溃/流断裂默认可重试', () => {
    expect(defaultRetriable('RATE_LIMIT_429')).toBe(true)
    expect(defaultRetriable('CRASH')).toBe(true)
    expect(defaultRetriable('STREAM_BROKEN')).toBe(true)
  })
  it('凭据/规格/超时类默认不重试（重试只会再烧一轮）', () => {
    expect(defaultRetriable('AUTH_401')).toBe(false)
    expect(defaultRetriable('WALL_CLOCK_TIMEOUT')).toBe(false)
    expect(defaultRetriable('NEED_CLARIFY')).toBe(false)
  })
})

describe('parseErrorEnvelope（单行解析，fail-closed）', () => {
  it('合法信封 → 结构体（retriable 缺省时按短码兜底）', () => {
    const e = parseErrorEnvelope(`${ERROR_ENVELOPE_PREFIX}{"error_code":"AUTH_401","hint_ref":"token expired"}`)
    expect(e).toEqual({ error_code: 'AUTH_401', retriable: false, hint_ref: 'token expired' })
  })
  it('显式 retriable 优先于短码兜底', () => {
    const e = parseErrorEnvelope(`${ERROR_ENVELOPE_PREFIX}{"error_code":"CRASH","retriable":false}`)
    expect(e?.retriable).toBe(false)
  })
  it('非前缀行 / 坏 JSON / 缺 error_code → undefined', () => {
    expect(parseErrorEnvelope('plain stderr line')).toBeUndefined()
    expect(parseErrorEnvelope(`${ERROR_ENVELOPE_PREFIX}not-json`)).toBeUndefined()
    expect(parseErrorEnvelope(`${ERROR_ENVELOPE_PREFIX}{"hint_ref":"x"}`)).toBeUndefined()
    expect(parseErrorEnvelope(`${ERROR_ENVELOPE_PREFIX}{"error_code":123}`)).toBeUndefined()
  })
  it('超长行 → undefined（防灌爆事件面）', () => {
    const long = `${ERROR_ENVELOPE_PREFIX}{"error_code":"CRASH","hint_ref":"${'x'.repeat(600)}"}`
    expect(parseErrorEnvelope(long)).toBeUndefined()
  })
  it('hint_ref 超长截断到上限（行内仍 ≤512 时）', () => {
    const e = parseErrorEnvelope(`${ERROR_ENVELOPE_PREFIX}{"error_code":"CRASH","hint_ref":"${'y'.repeat(450)}"}`)
    expect(e?.hint_ref).toHaveLength(ERROR_ENVELOPE_MAX_HINT)
  })
})

describe('lastErrorEnvelope（取最后一个有效信封）', () => {
  it('多行取最后一条信封（最终结论）', () => {
    const lines = [
      'noise',
      `${ERROR_ENVELOPE_PREFIX}{"error_code":"RATE_LIMIT_429"}`,
      'more noise',
      `${ERROR_ENVELOPE_PREFIX}{"error_code":"AUTH_401"}`,
    ]
    expect(lastErrorEnvelope(lines)?.error_code).toBe('AUTH_401')
  })
  it('无信封 → undefined', () => {
    expect(lastErrorEnvelope(['a', 'b'])).toBeUndefined()
  })
})

describe('makeEnvelope（adapter 构造信封）', () => {
  it('短码大写归一 + hint 超长截断', () => {
    const e = makeEnvelope('auth_401', false, `${'z'.repeat(1000)}`)
    expect(e.error_code).toBe('AUTH_401')
    expect(e.retriable).toBe(false)
    expect(e.hint_ref).toHaveLength(ERROR_ENVELOPE_MAX_HINT)
  })
  it('空 hint 不落字段', () => {
    expect(makeEnvelope('CRASH').hint_ref).toBeUndefined()
  })
})
