/**
 * PodService × CronScheduler 接线（CR-34，AgentScope-J）：
 *   cron.json 热加载（mtime 变化生效）→ maintenanceTick 同拍触发 → ChannelTarget 适配真实 pod_* 动作。
 * 默认关（无 cron.json = 无 job，Berd-H 显式启用纪律）；节流防抖与 watchdog 同拍。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { JsonStore } from '../src/core/store.js'
import { PodService } from '../src/pod-service.js'


  /** cwd git 预检要求真实仓库：测试用临时 git 仓库（单 EMPTY_COMMIT，零内容）。 */
  function initRepo(dir: string): string {
    mkdirSync(dir, { recursive: true })
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' })
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'init'], { stdio: 'ignore' })
    return dir
  }

describe('PodService × CronScheduler 接线（CR-34）', () => {
  let root: string
  let store: JsonStore
  let service: PodService
  let clockNow: number
  let cronFile: string
  let repo: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-cron-'))
    clockNow = 1_700_000_000_000
    store = new JsonStore({ rootDir: root, clock: () => clockNow })
    store.open()
    service = new PodService({ store, backends: {}, clock: () => clockNow, dataDir: root })
    repo = initRepo(join(root, 'repo'))
    cronFile = join(root, 'cron.json')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeCron(jobs: unknown[]): void {
    writeFileSync(cronFile, JSON.stringify({ jobs }), 'utf8')
  }

  it('cron.json 缺省 → tick 安全 no-op（默认关，Berd-H 显式启用纪律）', () => {
    const r = service.maintenanceTick()
    expect(r.staleApprovals).toEqual([])
    expect(service.cronList().jobs.length).toBe(0)
  })

  it('enabled job 到期触发 → status 命令经 ChannelTarget 真实执行并留历史', async () => {
    writeCron([{ id: 'c1', intervalMs: 1000, enabled: true, command: { kind: 'status' }, label: '巡检' }])
    service.maintenanceTick()
    await new Promise((r) => setTimeout(r, 30))
    const snap = service.cronList()
    expect(snap.jobs.length).toBe(1)
    expect(snap.jobs[0]!.id).toBe('c1')
    expect(snap.recent.some((h) => h.job_id === 'c1' && h.fired === true)).toBe(true)
  })

  it('节流防抖：interval 内重复 tick 不重复触发', async () => {
    writeCron([{ id: 'c1', intervalMs: 60_000, enabled: true, command: { kind: 'status' } }])
    service.maintenanceTick()
    await new Promise((r) => setTimeout(r, 20))
    service.maintenanceTick()
    service.maintenanceTick()
    await new Promise((r) => setTimeout(r, 20))
    const fired = service.cronList().recent.filter((h) => h.job_id === 'c1' && h.fired)
    expect(fired.length).toBe(1)
  })

  it('cron.json 热加载：mtime 变化后新 job 生效（无需重启）', async () => {
    service.maintenanceTick()
    await new Promise((r) => setTimeout(r, 20))
    expect(service.cronList().jobs.length).toBe(0)
    writeCron([{ id: 'hot', intervalMs: 1000, enabled: true, command: { kind: 'status' } }])
    await new Promise((r) => setTimeout(r, 5))
    service.maintenanceTick()
    await new Promise((r) => setTimeout(r, 20))
    expect(service.cronList().jobs.map((j) => j.id)).toContain('hot')
  })

  it('enabled:false 不触发（显式关闭优先）', async () => {
    writeCron([{ id: 'off', intervalMs: 1, enabled: false, command: { kind: 'status' } }])
    service.maintenanceTick()
    await new Promise((r) => setTimeout(r, 20))
    expect(service.cronList().recent.filter((h) => h.fired).length).toBe(0)
  })

  it('launch 命令经 ChannelTarget 真实创建 mission（复用 pod_launch 面）', async () => {
    writeCron([{ id: 'cron-launch', intervalMs: 1, enabled: true, command: { kind: 'launch', name: 'cron-m', goal: '定时巡检', cwd: repo, slots: [] } }])
    service.maintenanceTick()
    await new Promise((r) => setTimeout(r, 30))
    const missions = store.listMissions()
    expect(missions.some((m) => m.name === 'cron-m')).toBe(true)
  })

  it('cron.json 非法 JSON → 忽略并保持上一份（不炸宿主）', async () => {
    writeCron([{ id: 'ok1', intervalMs: 1000, enabled: true, command: { kind: 'status' } }])
    service.maintenanceTick()
    await new Promise((r) => setTimeout(r, 20))
    expect(service.cronList().jobs.length).toBe(1)
    writeFileSync(cronFile, '{not json', 'utf8')
    await new Promise((r) => setTimeout(r, 5))
    service.maintenanceTick()
    await new Promise((r) => setTimeout(r, 20))
    expect(service.cronList().jobs.length).toBe(1)
  })
})
