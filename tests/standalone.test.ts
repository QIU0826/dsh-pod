/**
 * 独立控制台服务测试（CR-38 P0）—— 真实 node:http 监听 + fetch（同 mcp-http.test.ts 风格），
 * 数据根用临时目录，不碰 ~/.dsh/pod。CLI 参数解析与守卫走纯函数单测。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createStandaloneServer, guard, isLoopbackHost, listenStandalone } from '../src/standalone/server.js'
import { parseStandaloneArgs, printUsage } from '../src/standalone/cli.js'

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

function makeTmpDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dsh-pod-standalone-'))
  tmpDirs.push(d)
  return d
}

describe('standalone server', () => {
  it('GET / 返回壳 HTML（#root 挂载点 + /standalone.js 引用）', async () => {
    const s = await listenStandalone({ port: 0, dataDir: makeTmpDataDir() })
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      const html = await res.text()
      expect(html).toContain('id="root"')
      expect(html).toContain('/standalone.js')
      expect(html).toContain('dsh-pod')
    } finally {
      await s.close()
    }
  })

  it('port 0 随机端口回填实际值', async () => {
    const s = await listenStandalone({ port: 0, dataDir: makeTmpDataDir() })
    try {
      expect(s.port).toBeGreaterThan(0)
    } finally {
      await s.close()
    }
  })

  it('GET /api/dsh-pod/status 走真实路由（全新数据根 mission 为 null）', async () => {
    const s = await listenStandalone({ port: 0, dataDir: makeTmpDataDir() })
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/dsh-pod/status`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { mission: unknown }
      expect(body.mission).toBeNull()
    } finally {
      await s.close()
    }
  })

  it('未知 API 路径与非 API 路径均 404', async () => {
    const s = await listenStandalone({ port: 0, dataDir: makeTmpDataDir() })
    try {
      const badApi = await fetch(`http://127.0.0.1:${s.port}/api/dsh-pod/nope`)
      expect(badApi.status).toBe(404)
      const other = await fetch(`http://127.0.0.1:${s.port}/whatever`)
      expect(other.status).toBe(404)
    } finally {
      await s.close()
    }
  })

  it('/standalone.js 从 staticDir 服务；缺失时 404 并提示构建', async () => {
    const staticDir = makeTmpDataDir()
    writeFileSync(join(staticDir, 'standalone.js'), 'console.log("stub-ui")')
    const s = await listenStandalone({ port: 0, dataDir: makeTmpDataDir(), staticDir })
    try {
      const ok = await fetch(`http://127.0.0.1:${s.port}/standalone.js`)
      expect(ok.status).toBe(200)
      expect(ok.headers.get('content-type')).toContain('text/javascript')
      expect(await ok.text()).toContain('stub-ui')
    } finally {
      await s.close()
    }
    const s2 = await listenStandalone({ port: 0, dataDir: makeTmpDataDir(), staticDir: makeTmpDataDir() })
    try {
      const missing = await fetch(`http://127.0.0.1:${s2.port}/standalone.js`)
      expect(missing.status).toBe(404)
      expect(await missing.text()).toContain('npm run build')
    } finally {
      await s2.close()
    }
  })

  it('未监听直接 close() 不抛（ERR_SERVER_NOT_RUNNING 被吞）', async () => {
    const s = createStandaloneServer({ dataDir: makeTmpDataDir() })
    await expect(s.close()).resolves.toBeUndefined()
  })
})

describe('guard（CR-29 loopback/token 纪律 + P1 浏览器侧防线）', () => {
  function fakeReq(remoteAddress: string, authorization?: string, extraHeaders: Record<string, string> = {}): IncomingMessage {
    const headers: Record<string, string> = { host: '127.0.0.1:3930', ...extraHeaders }
    if (authorization !== undefined) headers.authorization = authorization
    return { socket: { remoteAddress }, headers } as unknown as IncomingMessage
  }
  function fakeRes(): { res: ServerResponse; status: () => number; body: () => string } {
    const state = { code: 0, text: '' }
    const res = {
      writeHead(c: number): unknown {
        state.code = c
        return res
      },
      end(b?: unknown): void {
        state.text = typeof b === 'string' ? b : ''
      },
      headersSent: false,
    } as unknown as ServerResponse
    return { res, status: () => state.code, body: () => state.text }
  }

  it('loopback 直通（127.0.0.1 / ::1 / ::ffff:127.0.0.1，本机 Host）', () => {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const { res, status } = fakeRes()
      expect(guard(fakeReq(addr), res, '', true)).toBe(true)
      expect(status()).toBe(0)
    }
  })

  it('P1 DNS rebinding 防护：loopback 连接但 Host 为外域/缺失 → 拒绝', () => {
    const cases: Array<Record<string, string>> = [
      { host: 'evil.com:3930' },
      { host: '' },
      { host: '127.0.0.1.evil.com' },
    ]
    for (const headers of cases) {
      const { res, status, body } = fakeRes()
      expect(guard(fakeReq('127.0.0.1', undefined, headers), res, '', true)).toBe(false)
      expect(status()).toBe(403)
      expect(body()).toContain('Host')
    }
    // [::1]:port 与 localhost:port 合法
    for (const headers of [{ host: '[::1]:3930' }, { host: 'localhost:3930' }]) {
      const { res, status } = fakeRes()
      expect(guard(fakeReq('127.0.0.1', undefined, headers), res, '', true)).toBe(true)
      expect(status()).toBe(0)
    }
  })

  it('P1 CSRF 防护：loopback 连接带外域 Origin → 拒绝；本机 Origin/无 Origin 放行', () => {
    const evil = fakeRes()
    expect(guard(fakeReq('127.0.0.1', undefined, { origin: 'http://evil.com' }), evil.res, '', true)).toBe(false)
    expect(evil.status()).toBe(403)
    const nullOrigin = fakeRes()
    expect(guard(fakeReq('127.0.0.1', undefined, { origin: 'null' }), nullOrigin.res, '', true)).toBe(false)
    const ok = fakeRes()
    expect(guard(fakeReq('127.0.0.1', undefined, { origin: 'http://localhost:3930' }), ok.res, '', true)).toBe(true)
  })

  it('非 loopback：无 token / 错 token / loopbackOnly 均拒；对 token 且放开时放行', () => {
    const cases: Array<{ addr: string; token: string; loopbackOnly: boolean; auth?: string; want: boolean; code?: number }> = [
      { addr: '10.0.0.8', token: '', loopbackOnly: false, want: false, code: 403 },
      { addr: '10.0.0.8', token: 't1', loopbackOnly: false, auth: 'Bearer nope', want: false, code: 403 },
      { addr: '10.0.0.8', token: 't1', loopbackOnly: true, auth: 'Bearer t1', want: false, code: 403 },
      { addr: '10.0.0.8', token: 't1', loopbackOnly: false, auth: 'Bearer t1', want: true },
    ]
    for (const c of cases) {
      const { res, status, body } = fakeRes()
      expect(guard(fakeReq(c.addr, c.auth), res, c.token, c.loopbackOnly)).toBe(c.want)
      if (c.code !== undefined) {
        expect(status()).toBe(c.code)
        expect(body()).toContain('forbidden')
      }
    }
  })

  it('isLoopbackHost：未指定/127.0.0.1/localhost 为 loopback，0.0.0.0 不是', () => {
    expect(isLoopbackHost(undefined)).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('::')).toBe(false)
  })
})

describe('standalone CLI 参数解析', () => {
  it('全参数解析', () => {
    const a = parseStandaloneArgs(['--port', '4000', '--host', '0.0.0.0', '--data-dir', 'D:/tmp/pod', '--token', 's3cret', '--opencode-bin', 'C:/bin/oc.exe'])
    expect(a).toEqual({ help: false, port: 4000, host: '0.0.0.0', dataDir: 'D:/tmp/pod', token: 's3cret', opencodeBin: 'C:/bin/oc.exe' })
  })

  it('无参数 → 仅 help:false 的默认值', () => {
    expect(parseStandaloneArgs([])).toEqual({ help: false })
  })

  it('--help / -h', () => {
    expect(parseStandaloneArgs(['--help']).help).toBe(true)
    expect(parseStandaloneArgs(['-h']).help).toBe(true)
    expect(printUsage()).toContain('--port')
  })

  it('非法值抛错：--port 非整数、缺值、未知 flag', () => {
    expect(() => parseStandaloneArgs(['--port', 'abc'])).toThrow(/--port/)
    expect(() => parseStandaloneArgs(['--port'])).toThrow(/缺少值/)
    expect(() => parseStandaloneArgs(['--wat'])).toThrow(/未知参数/)
  })
})

describe('P1 CSRF 加固（standalone 集成：text/plain 跨站面封堵）', () => {
  it('POST /api/dsh-pod/launch 用 text/plain → 400（readJsonBody 强制 application/json）', async () => {
    const s = await listenStandalone({ port: 0, dataDir: makeTmpDataDir() })
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/dsh-pod/launch`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ name: 'x', goal: 'g', cwd: 'C:\tmp', slots: [{ id: 'S-1', vendor: 'claude', role: 'implementer', capabilities: [] }] }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('JSON')
    } finally {
      await s.close()
    }
  })
})
