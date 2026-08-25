import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore } from '../src/core/store.js'
import { PodService, defaultPlan } from '../src/pod-service.js'

/**
 * PodService 宿主侧闭环测试：commander 自动创建接线 + maintenanceTick 透传 + 默认任务链。
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
    service = new PodService({ store, backends: {}, clock: () => clockNow, dataDir: root })
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
    // 自动默认链存在但无人可派（slots 空）→ 转人工；mission 状态保持 running
    expect(store.getMission(mission.id)!.status).toBe('running')
  })

  it('launch 缺省 plan → 自动生成「实现 + 独立 review」默认链（CR-06-5 质量门默认开）', async () => {
    const mission = service.launch({ name: 'm', goal: '实现 multiply 函数', cwd: 'C:\\repo', budgetUsd: 2, slots: [] })
    const tasks = store.listTasks(mission.id)
    expect(tasks.map((t) => t.type)).toEqual(['implement', 'review'])
    expect(tasks[1]!.depends_on).toEqual(['T-1'])
    expect(tasks[0]!.spec).toContain('multiply')
  })

  it('defaultPlan：goal 过长截断为标题，review 依赖实现任务', () => {
    const plan = defaultPlan('在 src/util.ts 新增 multiply(a,b) 函数并在 example.md 补充用法示例，要求文档清晰')
    expect(plan).toHaveLength(2)
    expect(plan[0]!.title.length).toBeLessThanOrEqual(41)
    expect(plan[1]!.type).toBe('review')
  })

  it('DoD-2：launch 将 plan 落盘为 plan.md（mission 数据目录，唯一事实源）', () => {
    const mission = service.launch({ name: 'm', goal: '实现 multiply 函数', cwd: 'C:\\repo', budgetUsd: 2, slots: [] })
    const planPath = join(root, 'missions', mission.id, 'plan.md')
    expect(existsSync(planPath)).toBe(true)
    const content = readFileSync(planPath, 'utf8')
    expect(content).toContain('# Mission Plan:')
    expect(content).toContain('T-1')
    expect(content).toContain('T-2')
    expect(content).toContain('实现 multiply 函数')
    // 与 store 中的任务 DAG 一致（唯一事实源可回溯）
    const tasks = store.listTasks(mission.id)
    expect(tasks.map((t) => t.id)).toEqual(['T-1', 'T-2'])
  })
})
