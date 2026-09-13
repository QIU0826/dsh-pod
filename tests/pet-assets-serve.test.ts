/**
 * 桌宠资产静态面（随包内置 + dataDir 覆盖）：
 *   - `<pkg>/assets/pet` 随包发布的角色包可被 /pet-assets/** 直接服务（全新 clone 即见品牌娘）
 *   - `<dataDir>/pet-assets` 优先命中（用户覆盖）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listenStandalone } from '../src/standalone/server.js'

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
