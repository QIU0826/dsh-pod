import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as podPlugin from '../src/plugin.js'
import { POD_GUIDANCE, createPodRuntime } from '../src/plugin.js'

/**
 * 插件契约测试：用真实 cordis Context + mock 服务验证 apply 的注册面
 * （不依赖真实 DSH 进程，但同一份 @deepseek-ai/cordis，R6 只走公开扩展点）。
 * cordis v4 生命周期：await ctx.plugin(...) 完成加载，registry.delete 回收 fiber。
 */

interface Mocks {
  section: ReturnType<typeof vi.fn>
  register: ReturnType<typeof vi.fn>
  sectionDisposers: ReturnType<typeof vi.fn>[]
}

function makeContext(): { ctx: Context; mocks: Mocks } {
  const ctx = new Context()
  const sectionDisposers: ReturnType<typeof vi.fn>[] = []
  const mocks: Mocks = {
    section: vi.fn(() => {
      const disposer = vi.fn()
      sectionDisposers.push(disposer)
      return disposer
    }),
    register: vi.fn(() => () => {}),
    sectionDisposers,
  }
  ctx.provide('systemPrompt', { section: mocks.section })
  ctx.provide('webServer', { register: mocks.register })
  ctx.provide('tools', { register: vi.fn(() => () => {}) })
  return { ctx, mocks }
}

describe('plugin 宿主契约', () => {
  it('apply 注册 system-prompt 播报段与 ping 路由；fiber 回收时 disposer 全部执行', async () => {
    const { ctx, mocks } = makeContext()
    const fiber = ctx.plugin(podPlugin)
    await fiber
    expect(mocks.section).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'plugin:dsh-pod', text: POD_GUIDANCE }),
    )
    expect(mocks.register).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'exact', path: '/api/dsh-pod/ping' }),
    )
    expect(mocks.sectionDisposers.length).toBeGreaterThan(0)
    ctx.registry.delete(podPlugin)
    // 生命周期可逆（方案书 3.1/生命周期纪律）：fiber 删除 → effect disposer 异步执行
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(mocks.sectionDisposers.every((d) => d.mock.calls.length === 1)).toBe(true)
  })

  it('config.enabled=false 时不注册任何表面', async () => {
    const { ctx, mocks } = makeContext()
    const plugin = {
      ...podPlugin,
      apply: (c: Context) => podPlugin.apply(c, { enabled: false, announceToAgent: false }),
    }
    await ctx.plugin(plugin)
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.section).not.toHaveBeenCalled()
    ctx.registry.delete(plugin)
  })

  it('announceToAgent=false 时保留路由但不播报', async () => {
    const { ctx, mocks } = makeContext()
    const plugin = {
      ...podPlugin,
      apply: (c: Context) => podPlugin.apply(c, { enabled: true, announceToAgent: false }),
    }
    await ctx.plugin(plugin)
    expect(mocks.section).not.toHaveBeenCalled()
    expect(mocks.register).toHaveBeenCalledTimes(1)
    ctx.registry.delete(plugin)
  })

  it('运行时数据根损坏 → apply 不抛出（宿主绝不因插件崩溃，R6/R10）', async () => {
    const badRoot = mkdtempSync(join(tmpdir(), 'pod-badroot-'))
    try {
      writeFileSync(join(badRoot, 'store.json'), 'not json {')
      writeFileSync(join(badRoot, 'store.json.bak'), 'also not json [')
      const { ctx } = makeContext()
      const plugin = {
        ...podPlugin,
        apply: (c: Context) => podPlugin.apply(c, { dataDir: badRoot }),
      }
      await expect(ctx.plugin(plugin)).resolves.toBeDefined()
      ctx.registry.delete(plugin)
    } finally {
      rmSync(badRoot, { recursive: true, force: true })
    }
  })
})

describe('createPodRuntime', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'pod-rt-'))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('构造后 store 就绪、schema v1、approvals/ledger 可用', () => {
    const runtime = createPodRuntime(dataDir)
    expect(runtime.store.getSchemaVersion()).toBe(1)
    expect(runtime.approvals).toBeDefined()
    expect(runtime.ledger).toBeDefined()
  })

  it('插件导出契约：name/inject/apply 与版本号格式', () => {
    expect(podPlugin.name).toBe('pod')
    expect(podPlugin.inject).toContain('webServer')
    expect(typeof podPlugin.apply).toBe('function')
    expect(podPlugin.POD_VERSION).toMatch(/^\d+\.\d+\.\d+-w\d+$/)
    expect(POD_GUIDANCE).toContain('dsh-pod')
  })
})
