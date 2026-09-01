import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { JsonStore } from '../src/core/store.js'
import { PodService, defaultPlan, EVENT_TAIL_LIMIT, capEventsByBytes, MISSION_ARCHIVE_EVENTS_MAX_BYTES } from '../src/pod-service.js'

/**
 * PodService 宿主侧闭环测试：commander 自动创建接线 + maintenanceTick 透传 + 默认任务链。
 * 空 backends + 无任务 plan → run() 立即收敛，不触达真实 CLI（无 API 消耗）。
 */

  /** cwd git 预检要求真实仓库：测试用临时 git 仓库（单 EMPTY_COMMIT，零内容）。 */
  function initRepo(dir: string): string {
    mkdirSync(dir, { recursive: true })
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' })
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'init'], { stdio: 'ignore' })
    return dir
  }

describe('PodService 宿主闭环（CR-05-6）', () => {
  let root: string
  let store: JsonStore
  let service: PodService
  let repo: string
  let clockNow: number

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-service-'))
    clockNow = 1_700_000_000_000
    store = new JsonStore({ rootDir: root, clock: () => clockNow })
    store.open()
    repo = initRepo(join(root, 'repo'))
    service = new PodService({ store, backends: {}, clock: () => clockNow, dataDir: root })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('launch 自动调用 commander 启动器（mission 独立会话承载编排）', async () => {
    const launcher = vi.fn(async () => ({ sessionId: 'pod-mission-1' }))
    service.setCommanderLauncher(launcher)
    service.launch({ name: 'm', goal: '实现 X', cwd: repo, budgetUsd: 2, slots: [] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(launcher).toHaveBeenCalledWith('实现 X', repo)
  })

  it('commander 创建失败 → 落事件不阻断 mission（编排可降级）', async () => {
    const launcher = vi.fn(async () => {
      throw new Error('AGENT_FACTORY_UNAVAILABLE')
    })
    service.setCommanderLauncher(launcher)
    service.launch({ name: 'm', goal: 'g', cwd: repo, budgetUsd: 2, slots: [] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const events = store.listEvents(store.listMissions()[0]!.id).map((e) => e.kind)
    expect(events).toContain('commander_creation_error')
  })

  it('无 active mission 时 maintenanceTick 是安全 no-op', () => {
    expect(service.maintenanceTick()).toEqual({ staleApprovals: [], watchdogFired: 0 })
  })

  it('未注入 commander 启动器时 launch 不抛（可选接线）', async () => {
    const mission = service.launch({ name: 'm', goal: 'g', cwd: repo, budgetUsd: 2, slots: [] })
    expect(mission.status).toBe('planning')
    await new Promise((resolve) => setTimeout(resolve, 50))
    // 自动默认链存在但无人可派（slots 空）→ 转人工；mission 状态保持 running
    expect(store.getMission(mission.id)!.status).toBe('running')
  })

  it('launch 缺省 plan → 自动生成「实现 + 独立 review」默认链（CR-06-5 质量门默认开）', async () => {
    const mission = service.launch({ name: 'm', goal: '实现 multiply 函数', cwd: repo, budgetUsd: 2, slots: [] })
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
    const mission = service.launch({ name: 'm', goal: '实现 multiply 函数', cwd: repo, budgetUsd: 2, slots: [] })
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

  it('审批规则层（AgentScope-B）：addRule 落 Store，listRules 可查，deleteRule 可删', () => {
    const rule = service.addRule({ tool: 'Bash', pattern: 'git push', decision: 'deny' })
    expect(rule.id).toMatch(/^R-/)
    expect(service.listRules()).toHaveLength(1)
    expect(service.listRules()[0]!.pattern).toBe('git push')
    service.deleteRule(rule.id)
    expect(service.listRules()).toHaveLength(0)
  })

  it('记忆子系统：memoryWrite→memoryQuery 往返 + correct 留痕 + maintenanceTick 触发 reflection', () => {
    const rec = service.memoryWrite({ owner_slot_id: 'S-1', type: 'lesson', tags: ['a', 'b'], content_ref: '经验' })
    service.memoryWrite({ owner_slot_id: 'S-1', type: 'lesson', tags: ['a', 'b'], content_ref: '经验' }) // 重复 → 待合并
    expect(service.memoryQuery({ owner_slot_id: 'S-1' })).toHaveLength(2)
    // maintenanceTick 触发节流 reflection → 合并重复
    const tick = service.maintenanceTick()
    expect(tick).toEqual({ staleApprovals: [], watchdogFired: 0 })
    expect(service.memoryQuery({ owner_slot_id: 'S-1' })).toHaveLength(1)
    // correct 更新并审计留痕
    const updated = service.memoryCorrect(rec.id, { importance: 5 }, 'user')
    expect(updated.importance).toBe(5)
  })
})

describe('eventsAfter id 游标（SSE 路径：同毫秒事件不丢，审计 P1 修复）', () => {
  let root: string
  let store: JsonStore
  let service: PodService
  let repo: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-events-after-'))
    repo = initRepo(join(root, 'repo'))
    store = new JsonStore({ rootDir: root, clock: () => 1_700_000_000_000 })
    store.open()
    service = new PodService({ store, backends: {}, clock: () => 1_700_000_000_000, dataDir: root })
    service.launch({ name: 'm', goal: 'g', cwd: repo, budgetUsd: 2, slots: [] })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('同毫秒事件：id 游标逐帧续读不丢（ts 游标会跳过兄弟事件）', () => {
    const id = store.listMissions()[0]!.id
    for (let i = 0; i < 4; i += 1) {
      store.appendEvent(id, { id: `s${i}`, mission_id: id, ts: 2_000_000_000_000, kind: 'worker_progress', payload: { seq: i } })
    }
    // 旧实现：SSE 游标推进到该 ts 后，`ts > ts` 把同毫秒兄弟事件整批跳过
    expect(service.eventsAfter(2_000_000_000_000 - 1).map((e) => e.id)).toEqual(['s0', 's1', 's2', 's3'])
    expect(service.eventsAfter(2_000_000_000_000).map((e) => e.id)).toEqual([])
    // 新实现：按事件 id 精确定位，逐帧续读
    expect(service.eventsAfter(0, 's1').map((e) => e.id)).toEqual(['s2', 's3'])
    expect(service.eventsAfter(0, 's3')).toEqual([])
    // afterId 失效（不在窗口）→ 回退 ts 语义，不静默返回空
    expect(service.eventsAfter(2_000_000_000_000 - 1, 'no-such-id').map((e) => e.id)).toEqual(['s0', 's1', 's2', 's3'])
  })
})

describe('eventsTail 分页游标（HTTP 轮询路径：超限不丢、同毫秒不跳）', () => {
  let root: string
  let store: JsonStore
  let service: PodService
  let repo: string
  let clockNow: number

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-events-tail-'))
    repo = initRepo(join(root, 'repo'))
    clockNow = 1_700_000_000_000
    store = new JsonStore({ rootDir: root, clock: () => clockNow })
    store.open()
    service = new PodService({ store, backends: {}, clock: () => clockNow, dataDir: root })
    service.launch({ name: 'm', goal: 'g', cwd: repo, budgetUsd: 2, slots: [] })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  // launch 自身会落事件（ts = clockNow）；种子事件用更大的基准 ts 与之隔离，
  // 查询统一从 CLOCK_TS 起步，断言里就只有种子事件。
  const CLOCK_TS = 1_700_000_000_000
  const SEED_TS = 2_000_000_000_000

  function seed(count: number, tsOf: (i: number) => number): void {
    const id = store.listMissions()[0]!.id
    for (let i = 0; i < count; i += 1) {
      store.appendEvent(id, {
        id: `e${i}`,
        mission_id: id,
        ts: tsOf(i),
        kind: 'worker_progress',
        payload: { seq: i },
      })
    }
  }

  it('增量不足一批 → 全量返回，has_more=false', () => {
    seed(3, (i) => SEED_TS + i)
    const page = service.eventsTail(CLOCK_TS)
    expect(page.events.map((e) => e.id)).toEqual(['e0', 'e1', 'e2'])
    expect(page.has_more).toBe(false)
    expect(page.cursor).toBe('e2')
  })

  it('增量超过 EVENT_TAIL_LIMIT → 返回最早一批 + has_more，按 cursor 续读可拿全（此前取最后一批会永久丢事件）', () => {
    const total = EVENT_TAIL_LIMIT + 10
    seed(total, (i) => SEED_TS + i)
    const first = service.eventsTail(CLOCK_TS)
    expect(first.events).toHaveLength(EVENT_TAIL_LIMIT)
    expect(first.has_more).toBe(true)
    expect(first.events[0]!.id).toBe('e0')

    const last = first.events[first.events.length - 1]!
    const second = service.eventsTail(last.ts, first.cursor)
    const ids = [...first.events, ...second.events].map((e) => e.id)
    expect(ids).toHaveLength(total)
    expect(new Set(ids).size).toBe(total)
    expect(second.has_more).toBe(false)
  })

  it('同毫秒事件：id 游标能续读，ts 游标会整批跳过（旧实现丢事件的根因）', () => {
    seed(5, () => SEED_TS)
    expect(service.eventsTail(CLOCK_TS).events.map((e) => e.id)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4'])
    // 只消费到 e1 时用 id 游标续读 → 拿到剩下全部
    expect(service.eventsTail(SEED_TS, 'e1').events.map((e) => e.id)).toEqual(['e2', 'e3', 'e4'])
    // 同样的位置用纯 ts 语义：ts > SEED_TS 一律不成立 → 一条都拿不到（丢事件）
    expect(service.eventsTail(SEED_TS).events).toHaveLength(0)
  })

  it('afterId 失效（事件已不在窗口）→ 回退 ts 语义，不静默返回空', () => {
    seed(4, (i) => SEED_TS + i)
    expect(service.eventsTail(SEED_TS + 1, 'ghost-id').events.map((e) => e.id)).toEqual(['e2', 'e3'])
  })
})

describe('capEventsByBytes：missionArchive 事件尾部字节截断（条数有界≠字节有界）', () => {
  const ev = (id: string, payloadLen: number): { id: string; payload: string } => ({
    id,
    payload: 'x'.repeat(payloadLen),
  })

  it('累计字节超预算 → 只保留最近的一批，返回时间正序', () => {
    const events = [ev('e0', 50), ev('e1', 50), ev('e2', 50)]
    // 每条约 50 字节 payload + JSON 包装；预算放 150 字节，只够最近的 2 条
    const kept = capEventsByBytes(events, 150)
    expect(kept.map((e) => e.id)).toEqual(['e1', 'e2'])
  })

  it('单条事件自身超预算 → 仍保留最近一条，不返回空', () => {
    const events = [ev('e0', 10_000), ev('e1', 10)]
    const kept = capEventsByBytes(events, 100)
    expect(kept.map((e) => e.id)).toEqual(['e1'])
  })

  it('空输入 → 空输出；预算覆盖全部 → 原样返回', () => {
    expect(capEventsByBytes([], 100)).toEqual([])
    const events = [ev('e0', 5), ev('e1', 5)]
    expect(capEventsByBytes(events, 10_000).map((e) => e.id)).toEqual(['e0', 'e1'])
  })

  it('大 payload 事件流（500 条 × 8KB）被字节预算压回，实际输出远小于条数上限', () => {
    const big = Array.from({ length: 500 }, (_, i) => ev(`e${i}`, 8 * 1024))
    const kept = capEventsByBytes(big, MISSION_ARCHIVE_EVENTS_MAX_BYTES)
    // 256KB 预算 / 每条约 8KB → 至多 32 条，远小于 500
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThanOrEqual(33)
    const totalBytes = kept.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e), 'utf8'), 0)
    expect(totalBytes).toBeLessThanOrEqual(MISSION_ARCHIVE_EVENTS_MAX_BYTES)
    // 保留的是最近的事件（尾部），时间正序
    expect(kept[kept.length - 1]!.id).toBe('e499')
  })
})
