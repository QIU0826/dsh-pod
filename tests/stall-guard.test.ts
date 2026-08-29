import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore } from '../src/core/store.js'
import { PodService } from '../src/pod-service.js'
import { DemoBackend } from '../src/workers/demo-backend.js'
import { repairPath } from '../src/workers/preflight.js'
import type { Task } from '../src/core/types.js'

repairPath()

/**
 * 停摆兜底（存储级）：驱动循环静默挂起（实证的运行态故障）时，
 * maintenanceTick 对「长时间无落盘进展的 active 任务」故障化 + 重驱，保证自愈。
 */
describe('停摆兜底：active 任务超时无进展 → 故障化重派', () => {
  let root: string
  let store: JsonStore
  let service: PodService
  let clockNow: number

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-stall-'))
    const repo = join(root, 'repo')
    execFileSync('git', ['-C', root, 'init', '-q', 'repo'])
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'init'])
    clockNow = 1_700_000_000_000
    store = new JsonStore({ rootDir: root, clock: () => clockNow })
    store.open()
    service = new PodService({
      store,
      backends: { claude: new DemoBackend('claude'), codex: new DemoBackend('codex'), opencode: new DemoBackend('opencode') },
      clock: () => clockNow,
      dataDir: root,
    })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('伪造挂起现场（running 任务 updated_at 陈旧）→ tick 后任务 blocked + 落事件 + 驱动恢复', async () => {
    const mission = service.launch({
      name: 'm', goal: '给 README 增加安装章节', cwd: join(root, 'repo'), budgetUsd: 0,
      slots: [{ id: 'S-1', vendor: 'claude', role: 'implementer', capabilities: ['编码'], model: '' }],
    })
    // 等默认链完成（无 planner：默认实现+审查两任务）
    await new Promise((r) => setTimeout(r, 8000))
    const active = store.listTasks(mission.id).filter((t) => t.status === 'dispatched' || t.status === 'running')
    if (active.length === 0) {
      // 已全部完成（快机器）：直接伪造一个挂起任务验证兜底
      const t0 = store.listTasks(mission.id)[0]! as Task
      store.updateTask(mission.id, t0.id, { status: 'running', updated_at: clockNow - 10 * 60_000 })
    } else {
      const t = active[0]!
      store.updateTask(mission.id, t.id, { updated_at: clockNow - 10 * 60_000 })
    }
    const stalled = store.listTasks(mission.id).find((x) => (x.status === 'running' || x.status === 'dispatched') && x.updated_at < clockNow - 3 * 60_000)
    expect(stalled).toBeDefined()
    service.maintenanceTick()
    // 兜底后：要么已重派（新 dispatch/running + 新 updated_at），要么 blocked 等待重试
    const after = store.listTasks(mission.id).find((x) => x.id === stalled!.id)!
    expect(after.status === 'blocked' || after.updated_at >= clockNow - 60_000).toBe(true)
    expect(store.listEvents(mission.id).some((e) => e.kind === 'task_blocked' && e.task_id === stalled!.id)).toBe(true)
  }, 30_000)
})
