import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore } from '../src/core/store.js'
import { PodService } from '../src/pod-service.js'
import { DemoBackend } from '../src/workers/demo-backend.js'
import { repairPath } from '../src/workers/preflight.js'

repairPath()

/**
 * P0 回归（用户实证 DUPLICATE_TASK P-1）：任务主键按 mission 复合前，
 * 第二个会话的规划任务 P-1 与上一轮全局撞键 → launch 立即失败。
 * 现在连续会话各自落 P-1/T-1.. 短 id 合法共存。
 */
describe('连续会话任务短 id 共存（复合主键）', () => {
  let root: string
  let repo: string
  let store: JsonStore
  let service: PodService

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-seq-'))
    repo = join(root, 'repo')
    execFileSync('git', ['-C', root, 'init', '-q', 'repo'])
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'init'])
    store = new JsonStore({ rootDir: root, clock: () => Date.now() })
    store.open()
    service = new PodService({
      store,
      backends: { claude: new DemoBackend('claude'), codex: new DemoBackend('codex'), opencode: new DemoBackend('opencode') },
      clock: () => Date.now(),
      dataDir: root,
    })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const roster = [
    { id: 'S-1', vendor: 'claude' as const, role: 'planner', capabilities: ['规划'], model: '' },
    { id: 'S-2', vendor: 'claude' as const, role: 'implementer', capabilities: ['编码'], model: '' },
    { id: 'S-3', vendor: 'codex' as const, role: 'reviewer', capabilities: ['审查'], model: '' },
  ]

  it('两个会话先后发射：各自的 P-1/T-1 短 id 不冲突，第二轮正常进入执行', async () => {
    const waitTerminal = async (): Promise<void> => {
      for (let i = 0; i < 40; i += 1) {
        await new Promise((r) => setTimeout(r, 500))
        const active = store.getActiveMission()
        if (active === undefined) return
        if (active.status === 'awaiting_approval' || active.status === 'aborted' || active.status === 'done') return
      }
    }

    const m1 = service.launch({ name: '一', goal: '给 README 增加安装章节', cwd: repo, budgetUsd: 0, slots: roster })
    await waitTerminal()
    const st1 = store.getMission(m1.id)!
        expect(['awaiting_approval', 'done']).toContain(st1.status)
    // 手工终结第一轮（模拟审批通过后的场景）——直接 abort 释放单活跃锁
    store.updateMission(m1.id, { status: 'aborted' })

    // 第二轮：同样的短 id（P-1/T-1/T-2/T-3）必须能再建
    const m2 = service.launch({ name: '二', goal: '给 README 增加环境说明', cwd: repo, budgetUsd: 0, slots: roster })
    await waitTerminal()
    const t2 = store.listTasks(m2.id).map((t) => `${t.id}:${t.status}`)
    expect(store.listTasks(m2.id).some((t) => t.id === 'P-1' && t.status === 'done')).toBe(true)
    expect(store.getTask(m1.id, 'P-1')).toBeDefined()
    expect(store.getTask(m2.id, 'P-1')).toBeDefined()
    // 兼容重载：单参短 id 全表匹配仍可用（旧调用面）
    expect(store.getTask('P-1')!.mission_id).toBe(m1.id)
    console.log('round2 tasks:', t2.join(' '))
    const st2 = store.getMission(m2.id)!
    expect(['awaiting_approval', 'done']).toContain(st2.status)
  }, 45_000)
})
