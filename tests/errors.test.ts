import { describe, expect, it } from 'vitest'
import {
  ApprovalConflictError,
  InvalidTransitionError,
  PodError,
  StoreCorruptError,
  getUserMessage,
  isPodError,
  toPodError,
} from '../src/core/errors.js'

describe('errors 类型化错误体系（error-handling skill 契约）', () => {
  it('PodError 携带 code/details/retryable，原型链正确', () => {
    const error = new PodError('boom', 'TEST_CODE', { x: 1 }, true)
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(PodError)
    expect(error.code).toBe('TEST_CODE')
    expect(error.details).toEqual({ x: 1 })
    expect(error.retryable).toBe(true)
    expect(error.name).toBe('PodError')
  })

  it('默认 retryable=false；子类错误码稳定（对外契约）', () => {
    expect(new PodError('x', 'X').retryable).toBe(false)
    expect(new InvalidTransitionError('a', 'b', 'why').code).toBe('INVALID_TRANSITION')
    expect(new ApprovalConflictError('A-1', 'pending', 'approved').code).toBe('APPROVAL_CONFLICT')
    expect(new StoreCorruptError('/p', '/p.bak').code).toBe('STORE_CORRUPT')
  })

  it('getUserMessage：已知码 → 用户文案；未知码 → 兜底（不含技术细节）', () => {
    expect(getUserMessage('BUDGET_EXCEEDED')).toBe('预算已耗尽，任务已暂停。')
    expect(getUserMessage('UNKNOWN_CODE_XYZ')).toBe('发生意外错误，详见日志。')
  })

  it('isPodError 跨模块边界安全识别', () => {
    expect(isPodError(new PodError('x', 'X'))).toBe(true)
    expect(isPodError(new Error('plain'))).toBe(false)
    expect(isPodError('string')).toBe(false)
    expect(isPodError(null)).toBe(false)
  })

  it('toPodError 归一化：PodError 原样返回，Error 包 code=INTERNAL，非 Error 包字符串', () => {
    const original = new PodError('keep', 'KEEP')
    expect(toPodError(original)).toBe(original)
    const wrapped = toPodError(new Error('plain'))
    expect(wrapped).toBeInstanceOf(PodError)
    expect(wrapped.code).toBe('INTERNAL')
    expect(toPodError(42)).toBeInstanceOf(PodError)
  })
})
