/** P1 加固：HTTP 入口共享守卫单元测试（Host/Origin/content-type/token）。 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import {
  allowsJsonBody,
  bearerTokenEquals,
  hasAllowedLoopbackOrigin,
  isLocalHostHeader,
  isLoopbackBindHost,
  isLoopbackRemoteAddress,
} from '../src/core/http-guard.js'

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('isLocalHostHeader（DNS rebinding 防护）', () => {
  it('本机名（含端口/IPv6 方括号）放行；外域、缺失、前缀伪装拒绝', () => {
    for (const host of ['localhost', 'localhost:3930', '127.0.0.1', '127.0.0.1:80', '[::1]', '[::1]:3930', 'LOCALHOST:3930']) {
      expect(isLocalHostHeader(req({ host }))).toBe(true)
    }
    for (const host of ['', 'evil.com', 'evil.com:3930', '127.0.0.1.evil.com', 'localhost.evil.com']) {
      expect(isLocalHostHeader(req({ host }))).toBe(false)
    }
    expect(isLocalHostHeader(req({}))).toBe(false)
  })
})

describe('hasAllowedLoopbackOrigin（CSRF 防护）', () => {
  it('无 Origin（原生客户端）放行；本机源放行；外域/null/畸形拒绝', () => {
    expect(hasAllowedLoopbackOrigin(req({}))).toBe(true)
    expect(hasAllowedLoopbackOrigin(req({ origin: '' }))).toBe(true)
    expect(hasAllowedLoopbackOrigin(req({ origin: 'http://localhost:3930' }))).toBe(true)
    expect(hasAllowedLoopbackOrigin(req({ origin: 'http://127.0.0.1:3930' }))).toBe(true)
    expect(hasAllowedLoopbackOrigin(req({ origin: 'http://[::1]:3930' }))).toBe(true)
    expect(hasAllowedLoopbackOrigin(req({ origin: 'http://evil.com' }))).toBe(false)
    expect(hasAllowedLoopbackOrigin(req({ origin: 'null' }))).toBe(false)
    expect(hasAllowedLoopbackOrigin(req({ origin: 'not a url' }))).toBe(false)
  })
})

describe('allowsJsonBody（text/plain CSRF 通道封堵）', () => {
  it('无体请求放行；带体必须 application/json', () => {
    expect(allowsJsonBody(req({}))).toBe(true)
    expect(allowsJsonBody(req({ 'content-length': '0' }))).toBe(true)
    expect(allowsJsonBody(req({ 'content-length': '10', 'content-type': 'application/json' }))).toBe(true)
    expect(allowsJsonBody(req({ 'content-length': '10', 'content-type': 'application/json; charset=utf-8' }))).toBe(true)
    expect(allowsJsonBody(req({ 'content-length': '10', 'content-type': 'text/plain' }))).toBe(false)
    expect(allowsJsonBody(req({ 'content-length': '10' }))).toBe(false)
    expect(allowsJsonBody(req({ 'transfer-encoding': 'chunked', 'content-type': 'application/x-www-form-urlencoded' }))).toBe(false)
  })
})

describe('bearerTokenEquals（恒时比较）', () => {
  it('精确匹配 Bearer；前缀/错误/大小写敏感拒绝', () => {
    expect(bearerTokenEquals('s3cret', req({ authorization: 'Bearer s3cret' }))).toBe(true)
    expect(bearerTokenEquals('s3cret', req({ authorization: 'bearer s3cret' }))).toBe(false)
    expect(bearerTokenEquals('s3cret', req({ authorization: 'Bearer s3cretX' }))).toBe(false)
    expect(bearerTokenEquals('s3cret', req({}))).toBe(false)
  })
})

describe('loopback 判定统一', () => {
  it('远端地址（含 ::1/::ffff: 映射）；绑定地址（缺省=loopback）', () => {
    expect(isLoopbackRemoteAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackRemoteAddress('::1')).toBe(true)
    expect(isLoopbackRemoteAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackRemoteAddress('10.0.0.8')).toBe(false)
    expect(isLoopbackBindHost(undefined)).toBe(true)
    expect(isLoopbackBindHost('')).toBe(true)
    expect(isLoopbackBindHost('0.0.0.0')).toBe(false)
    expect(isLoopbackBindHost('::')).toBe(false)
    expect(isLoopbackBindHost('::1')).toBe(true)
  })
})
