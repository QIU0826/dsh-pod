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
  toolNames: string[]
  sectionDisposers: ReturnType<typeof vi.fn>[]
}

function makeContext(): { ctx: Context; mocks: Mocks } {
  const ctx = new Context()
  const sectionDisposers: ReturnType<typeof vi.fn>[] = []
  const toolNames: string[] = []
  const mocks: Mocks = {
    section: vi.fn(() => {
      const disposer = vi.fn()
      sectionDisposers.push(disposer)
      return disposer
    }),
    register: vi.fn(() => () => {}),
    toolNames,
    sectionDisposers,
  }
  ctx.provide('systemPrompt', { section: mocks.section })
  ctx.provide('webServer', { register: mocks.register })
  ctx.provide('tools', {
    register: vi.fn((definition: { name?: string }) => {
      if (typeof definition.name === 'string') toolNames.push(definition.name)
      return () => {}
    }),
  })
  return { ctx, mocks }
}

describe('plugin 宿主契约', () => {
  it('apply 注册播报段、ping 路由与七个 pod_* 工具；fiber 回收时 disposer 全部执行', async () => {
    const { ctx, mocks } = makeContext()
    const dataDir = mkdtempSync(join(tmpdir(), 'pod-plugin-'))
    const plugin = {
      ...podPlugin,
      apply: (c: Context) => podPlugin.apply(c, { dataDir }),
    }
    const fiber = ctx.plugin(plugin)
    await fiber
    expect(mocks.section).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'plugin:dsh-pod', text: POD_GUIDANCE }),
    )
    expect(mocks.register).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'exact', path: '/api/dsh-pod/ping' }),
    )
    expect(mocks.toolNames).toEqual([
      'pod_launch',
      'pod_status',
      'pod_dispatch',
      'pod_collect',
      'pod_steer',
      'pod_approve',
      'pod_mem_write',
      'pod_mem_query',
      'pod_mem_correct',
      'pod_reassign',
      'pod_abort',
      'pod_pause',
      'pod_resume',
      'pod_cron_list',
      'pod_plan',
      'pod_expand_tool',
      'pod_commander_start',
    ])
    expect(mocks.sectionDisposers.length).toBeGreaterThan(0)
    ctx.registry.delete(plugin)
    // 生命周期可逆（方案书 3.1/生命周期纪律）：fiber 删除 → effect disposer 异步执行
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(mocks.sectionDisposers.every((d) => d.mock.calls.length === 1)).toBe(true)
    rmSync(dataDir, { recursive: true, force: true })
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
    expect(mocks.toolNames).toEqual([])
    ctx.registry.delete(plugin)
  })

  it('announceToAgent=false 时保留路由与工具但不播报', async () => {
    const { ctx, mocks } = makeContext()
    const dataDir = mkdtempSync(join(tmpdir(), 'pod-plugin-'))
    const plugin = {
      ...podPlugin,
      apply: (c: Context) => podPlugin.apply(c, { enabled: true, announceToAgent: false, dataDir }),
    }
    await ctx.plugin(plugin)
    expect(mocks.section).not.toHaveBeenCalled()
    // 断言关键路由都在，而不是数总数——总数断言每新增一条路由就要改一次
    // （2026-08-29 加 /pause /resume 挂一次，2026-08-30 加 /reassign 又挂一次），
    // 脆弱且失败时不告诉你缺了哪条。改成存在性断言后，新增路由不会误伤，
    // 删了关键路由则会明确指出是哪条。
    const registered = mocks.register.mock.calls.map((call) => String((call[0] as { path: unknown }).path))
    const required = [
      '/api/dsh-pod/status', '/api/dsh-pod/events', '/api/dsh-pod/events/stream',
      '/api/dsh-pod/launch', '/api/dsh-pod/steer', '/api/dsh-pod/approve', '/api/dsh-pod/deny',
      '/api/dsh-pod/dispatch', '/api/dsh-pod/resolve', '/api/dsh-pod/rules', '/api/dsh-pod/abort',
      '/api/dsh-pod/pause', '/api/dsh-pod/resume',
      '/api/dsh-pod/task/pause', '/api/dsh-pod/task/resume', '/api/dsh-pod/reassign',
      '/api/dsh-pod/assets', '/api/dsh-pod/missions', '/api/dsh-pod/missions/detail',
      '/api/dsh-pod/plan', '/api/dsh-pod/fs/browse', '/api/dsh-pod/approvals/detail',
      '/api/dsh-pod/memory', '/api/dsh-pod/memory/correct', '/api/dsh-pod/cron',
      '/a2a', '/a2a/sendMessage', '/a2a/sendMessageStream', '/.well-known/agent-card',
    ]
    for (const path of required) expect(registered, `缺少路由 ${path}`).toContain(path)
    expect(mocks.toolNames).toHaveLength(17) // 16 pod_*（含 pod_expand_tool）+ commander_start
    ctx.registry.delete(plugin)
    // 等 effect disposer 异步执行（SQLite WAL 句柄释放）再清理目录
    await new Promise((resolve) => setTimeout(resolve, 10))
    rmSync(dataDir, { recursive: true, force: true })
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
      // 等 disposer 释放 SQLite 句柄
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      rmSync(badRoot, { recursive: true, force: true })
    }
  })
})

describe('createPodRuntime', () => {
  let dataDir: string
  let runtimeRef: ReturnType<typeof createPodRuntime> | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'pod-rt-'))
    runtimeRef = undefined
  })

  afterEach(() => {
    // 释放 SQLite 连接（WAL 句柄不关会导致 rmSync EBUSY）
    runtimeRef?.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('构造后 store 就绪、schema v1、approvals/ledger 可用', () => {
    runtimeRef = createPodRuntime(dataDir)
    expect(runtimeRef.store.getSchemaVersion()).toBe(1)
    expect(runtimeRef.approvals).toBeDefined()
    expect(runtimeRef.ledger).toBeDefined()
  })

  it('插件导出契约：name/inject/apply 与版本号格式', () => {
    expect(podPlugin.name).toBe('pod')
    expect(podPlugin.inject).toContain('webServer')
    expect(typeof podPlugin.apply).toBe('function')
    expect(podPlugin.POD_VERSION).toMatch(/^\d+\.\d+\.\d+-w\d+$/)
    expect(POD_GUIDANCE).toContain('dsh-pod')
  })
})
