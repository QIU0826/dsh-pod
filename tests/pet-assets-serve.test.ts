/**
 * 桌宠资产静态面（随包内置 + dataDir 覆盖）：
 *   - `<pkg>/assets/pet` 随包发布的角色包可被 /pet-assets/** 直接服务（全新 clone 即见品牌娘）
 *   - `<dataDir>/pet-assets` 优先命中（用户覆盖）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listenStandalone, petAssetRoots } from '../src/standalone/server.js'
import { makePodRoutes } from '../src/routes.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pod-pet-assets-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('桌宠资产静态面', () => {
  it('内置角色包（<pkg>/assets/pet）随包可服务：GET /pet-assets/claude-girl/pet.json', async () => {
    const s = await listenStandalone({ host: '127.0.0.1', port: 0, dataDir: dir })
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/pet-assets/claude-girl/pet.json`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = (await res.json()) as { id?: string }
      expect(body.id).toBe('claude-girl')
    } finally {
      await s.close()
    }
  })

  it('dataDir/pet-assets 覆盖内置（优先命中）', async () => {
    mkdirSync(join(dir, 'pet-assets', 'zz'), { recursive: true })
    writeFileSync(join(dir, 'pet-assets', 'zz', 'pet.json'), JSON.stringify({ id: 'override' }))
    const s = await listenStandalone({ host: '127.0.0.1', port: 0, dataDir: dir })
    try {
      const body = (await (await fetch(`http://127.0.0.1:${s.port}/pet-assets/zz/pet.json`)).json()) as { id?: string }
      expect(body.id).toBe('override')
    } finally {
      await s.close()
    }
  })

  it('不存在的角色 → 404（回落机制兜底）', async () => {
    const s = await listenStandalone({ host: '127.0.0.1', port: 0, dataDir: dir })
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/pet-assets/nope-girl/pet.json`)
      expect(res.status).toBe(404)
    } finally {
      await s.close()
    }
  })
})

describe('petAssetRoots（内置包定位：打包态 + 源码态）', () => {
  it('打包态 dist/ 上一级、源码态 src/standalone 上两级，都指向 <pkg>/assets/pet', () => {
    const pkg = join('X:', 'pkg')
    const distRoots = petAssetRoots(join('X:', 'data'), join(pkg, 'dist'))
    expect(distRoots[0]).toBe(join('X:', 'data', 'pet-assets'))
    expect(distRoots).toContain(join(pkg, 'assets', 'pet'))

    const srcRoots = petAssetRoots(join('X:', 'data'), join(pkg, 'src', 'standalone'))
    expect(srcRoots).toContain(join(pkg, 'assets', 'pet'))
  })

  it('以本仓库真实布局验证：源码态 staticDir 能命中 assets/pet', () => {
    const roots = petAssetRoots(tmpdir(), join(process.cwd(), 'src', 'standalone'))
    const hit = roots.find((r) => existsSync(join(r, 'claude-girl', 'pet.json')))
    expect(hit).toBe(join(process.cwd(), 'assets', 'pet'))
  })
})

describe('插件形态 /pet-assets 路由（prefix）', () => {
  function fakeRes(): { status: number; body: unknown; writeHead(s: number, h?: Record<string, string>): void; end(b?: unknown): void } {
    const res = {
      status: 0,
      body: undefined as unknown,
      writeHead(s: number) {
        res.status = s
      },
      end(b?: unknown) {
        res.body = b
      },
    }
    return res
  }

  it('注册为 prefix，且能服务随包内置角色包', async () => {
    const route = makePodRoutes(() => undefined).find((r) => r.path === '/pet-assets')
    expect(route?.kind).toBe('prefix')
    const res = fakeRes()
    await route!.handler({ url: '/pet-assets/claude-girl/pet.json', method: 'GET' } as never, res as never)
    expect(res.status).toBe(200)
    expect((JSON.parse(String(res.body)) as { id?: string }).id).toBe('claude-girl')
  })

  it('/pet-assets 根路径与穿越尝试 → 404', async () => {
    const route = makePodRoutes(() => undefined).find((r) => r.path === '/pet-assets')!
    for (const url of ['/pet-assets', '/pet-assets/', '/pet-assets/../../package.json']) {
      const res = fakeRes()
      await route.handler({ url, method: 'GET' } as never, res as never)
      expect(res.status, url).toBe(404)
    }
  })
})
