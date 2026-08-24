import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore } from '../src/core/store.js'
import { PodService } from '../src/pod-service.js'

/**
 * PodService 宿主侧闭环测试：commander 自动创建接线 + maintenanceTick 透传。
 * 空 backends + 无任务 plan → run() 立即收敛，不触达真实 CLI（无 API 消耗）。
 */
describe('PodService 宿主闭环（CR-05-6）', () => {
  let root: string
  let store: JsonStore
  let service: PodService
  let clockNow: number

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-service-'))
    clockNow = 1_700_000_000_000
    store = new JsonStore({ rootDir: root, clock: () => clockNow })
    store.open()
    service = new PodService({ store, backends: {}, clock: () => clockNow })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('launch 自动调用 commander 启动器（mission 独立会话承载编排）', async () => {
    const launcher = vi.fn(async () => ({ sessionId: 'pod-mission-1' }))
    service.setCommanderLauncher(launcher)
    service.launch({ name: 'm', goal: '实现 X', cwd: 'C:\\repo', budgetUsd: 2, slots: [] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(launcher).toHaveBeenCalledWith('实现 X', 'C:\\repo')
  })

  it('commander 创建失败 → 落事件不阻断 mission（编排可降级）', async () => {
    const launcher = vi.fn(async () => {
      throw new Error('AGENT_FACTORY_UNAVAILABLE')
    })
    service.setCommanderLauncher(launcher)
    service.launch({ name: 'm', goal: 'g', cwd: 'C:\\repo', budgetUsd: 2, slots: [] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const events = store.listEvents(store.listMissions()[0]!.id).map((e) => e.kind)
    expect(events).toContain('commander_creation_error')
  })

  it('无 active mission 时 maintenanceTick 是安全 no-op', () => {
    expect(service.maintenanceTick()).toEqual({ staleApprovals: [], watchdogFired: 0 })
  })

  it('未注入 commander 启动器时 launch 不抛（可选接线）', async () => {
    const mission = service.launch({ name: 'm', goal: 'g', cwd: 'C:\\repo', budgetUsd: 2, slots: [] })
    expect(mission.status).toBe('planning')
    await new Promise((resolve) => setTimeout(resolve, 50))
    // 无任务 → run() 收敛到 needs_human，mission 状态保持 running（转人工语义）
    expect(store.getMission(mission.id)!.status).toBe('running')
  })
})
