/**
 * 设备配对与会话（远程访问片 A）回归测试：
 *   - PairingStore：mint 一次性令牌（重复铸造作废旧令牌）/ accept 换发凭据 /
 *     令牌过期与错误拒绝（fail-closed）/ revoke 单设备与全部 / 持久化重开保持
 *   - guard：非 loopback 凭设备会话 Cookie 放行；凭据错误/已撤销拒绝；loopback 恒过
 *   - 真实 HTTP：mint → accept → 凭 Cookie 访问受保护路由（standalone 全链路）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PairingStore } from '../src/core/pairing.js'
import { guard, listenStandalone } from '../src/standalone/server.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pod-pairing-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function fakeRes(): ServerResponse & { status?: number; body?: string } {
  const res: { status?: number; body?: string; writeHead: (code: number) => void; end: (b?: string) => void } = {
    writeHead: (code: number) => {
      res.status = code
    },
    end: (b?: string) => {
      res.body = b
    },
  }
  return res as never
}

describe('PairingStore（配对令牌与设备会话）', () => {
  it('mint → accept：一次性令牌换发设备凭据；令牌即作废', () => {
    const store = new PairingStore({ dataDir: dir, clock: () => 1_000 })
    store.open()
    const { token, expiresAt } = store.mintToken()
    expect(expiresAt).toBe(1_000 + 10 * 60 * 1000)
    const d = store.accept(token, 'Mozilla/5.0 (iPhone)')
    expect(d.name).toBe('iPhone')
    expect(d.secret.length).toBeGreaterThanOrEqual(32)
    expect(store.validate(d.deviceId, d.secret)).toBe(true)
    // 令牌一次性：再 accept 同 token → 拒绝
    expect(() => store.accept(token, undefined)).toThrow(/invalid or expired/)
  })
  it('过期令牌 / 错误令牌 → 拒绝（fail-closed）', () => {
    let now = 1_000
    const store = new PairingStore({ dataDir: dir, clock: () => now, tokenTtlMs: 1_000 })
    store.open()
    const { token } = store.mintToken()
    now = 3_000 // 超 TTL
    expect(() => store.accept(token, undefined)).toThrow(/invalid or expired/)
    now = 1_100
    expect(() => store.accept('deadbeef', undefined)).toThrow(/invalid or expired/)
  })
  it('重复铸造使旧令牌失效（同时仅一枚）', () => {
    const store = new PairingStore({ dataDir: dir, clock: () => 1_000 })
    store.open()
    const first = store.mintToken()
    const second = store.mintToken()
    expect(() => store.accept(first.token, undefined)).toThrow(/invalid or expired/)
    expect(store.accept(second.token, undefined).deviceId).toBeDefined()
  })
  it('revoke：单设备与全部；撤销后 validate 拒绝', () => {
    const store = new PairingStore({ dataDir: dir, clock: () => 1_000 })
    store.open()
    const d1 = store.accept(store.mintToken().token, undefined)
    const d2 = store.accept(store.mintToken().token, undefined)
    expect(store.revoke(d1.deviceId)).toBe(1)
    expect(store.validate(d1.deviceId, d1.secret)).toBe(false)
    expect(store.validate(d2.deviceId, d2.secret)).toBe(true)
    expect(store.revoke()).toBe(1) // 撤销全部（剩 d2）
    expect(store.validate(d2.deviceId, d2.secret)).toBe(false)
  })
  it('凭据错误 → 拒绝（恒时比较路径）', () => {
    const store = new PairingStore({ dataDir: dir, clock: () => 1_000 })
    store.open()
    const d = store.accept(store.mintToken().token, undefined)
    expect(store.validate(d.deviceId, '0'.repeat(d.secret.length))).toBe(false)
    expect(store.validate(d.deviceId, '')).toBe(false)
  })
  it('持久化：重开后设备会话与撤销状态保持', () => {
    const store = new PairingStore({ dataDir: dir, clock: () => 1_000 })
    store.open()
    const d = store.accept(store.mintToken().token, 'Mozilla/5.0 (Linux; Android 14; Mobile)')
    store.revoke(d.deviceId)
    const reopened = new PairingStore({ dataDir: dir, clock: () => 2_000 })
    reopened.open()
    expect(reopened.validate(d.deviceId, d.secret)).toBe(false) // 撤销状态持久
    const list = reopened.listDevices()
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe('Android 手机')
    expect(list[0]).not.toHaveProperty('secret') // 凭据永不进列表面
  })
})

describe('guard 设备会话放行（非 loopback）', () => {
  function makeGuardedReq(over: { remoteAddress: string; host?: string; cookie?: string; token?: string }): { req: IncomingMessage; res: ServerResponse } {
    const req = {
      socket: { remoteAddress: over.remoteAddress },
      headers: {
        host: over.host ?? '192.168.1.5',
        ...(over.cookie !== undefined ? { cookie: `pod-device=${over.cookie}` } : {}),
        ...(over.token !== undefined ? { authorization: `Bearer ${over.token}` } : {}),
      },
    } as never
    const res = fakeRes()
    return { req, res }
  }

  it('非 loopback + 有效设备会话 Cookie → 放行；凭据错误 → 403', () => {
    const store = new PairingStore({ dataDir: dir, clock: () => 1_000 })
    store.open()
    const d = store.accept(store.mintToken().token, undefined)
    const good = makeGuardedReq({ remoteAddress: '192.168.1.5', cookie: `${d.deviceId}.${d.secret}` })
    expect(guard(good.req, good.res, '', false, store)).toBe(true)
    const bad = makeGuardedReq({ remoteAddress: '192.168.1.5', cookie: `${d.deviceId}.wrong` })
    expect(guard(bad.req, bad.res, '', false, store)).toBe(false)
    expect((bad.res as { status?: number }).status).toBe(403)
  })
  it('loopback 请求不受影响（恒过路径不变）', () => {
    const store = new PairingStore({ dataDir: dir, clock: () => 1_000 })
    store.open()
    const { req, res } = makeGuardedReq({ remoteAddress: '127.0.0.1', host: '127.0.0.1' })
    expect(guard(req, res, '', true, store)).toBe(true)
  })
})

describe('真实 HTTP 配对链（mint → accept → 凭 Cookie 访问）', () => {
  it('全链路经真实 fetch：非 loopback 绑定 + pairing', async () => {
    const satellite = await listenStandalone({
      host: '127.0.0.1', // 同源测试；guard 的非 loopback 分支由上面的单测覆盖
      port: 0,
      dataDir: dir,
      pairing: true,
    })
    try {
      const base = `http://127.0.0.1:${satellite.port}`
      const mint = await fetch(base + '/api/pair/mint', { method: 'POST' })
      expect(mint.status).toBe(200)
      const { token } = (await mint.json()) as { token: string }
      const accept = await fetch(base + '/api/pair/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (iPhone)' },
        body: JSON.stringify({ token }),
      })
      expect(accept.status).toBe(200)
      const setCookie = accept.headers.get('set-cookie') ?? ''
      expect(setCookie).toContain('pod-device=')
      expect(setCookie).toContain('HttpOnly')
      const cookie = setCookie.split(';')[0]!
      // 凭 Cookie 访问受保护路由（status 是 pod 面）
      const authorized = await fetch(base + '/api/dsh-pod/status', { headers: { cookie } })
      expect(authorized.status).toBe(200)
      // devices 列表不泄露凭据
      const devices = await (await fetch(base + '/api/pair/devices')).json()
      expect(JSON.stringify(devices)).not.toContain('secret')
    } finally {
      await satellite.close()
    }
  })
})
