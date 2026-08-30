import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore } from '../src/core/store.js'
import { PodService } from '../src/pod-service.js'
import { DemoBackend } from '../src/workers/demo-backend.js'
import { repairPath } from '../src/workers/preflight.js'
import type { Mission } from '../src/core/types.js'

repairPath()

/**
 * P0 回归（实证 bug：planning 僵尸）：launch/run 任何一步崩溃都必须落到终态，
 * 否则 mission 停在 planning/running 无人驱动，且永久占用单活跃锁（后续 launch 全 409）。
 */
describe('发射故障原子性（planning 僵尸修复）', () => {
  let root: string
  let store: JsonStore
  let service: PodService

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-atomic-'))
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
    { id: 'S-1', vendor: 'claude' as const, role: 'planner', capabilities: ['规划'], model: 'm' },
    { id: 'S-2', vendor: 'claude' as const, role: 'implementer', capabilities: ['编码'], model: 'm' },
  ]

  it('cwd 非 git 仓库 → 发射前同步拒绝（CWD_NOT_GIT_REPO），零残留不阻塞后续', () => {
    // 审计修复：此前 mission 创建后 run 异步崩溃 → aborted 僵尸；现在发射前预检直接拒绝
    const notRepo = join(root, 'exists-but-not-repo')
    mkdirSync(notRepo, { recursive: true })
    expect(() => service.launch({
      name: '坏目录', goal: 'g', cwd: notRepo, budgetUsd: 1_000_000_000, slots: roster,
    })).toThrow(/不是 git 仓库/)
    expect(store.listMissions()).toHaveLength(0) // 零残留：连 planning 碎片都没有
  })

  it('maintenanceTick 自愈：无编排器归属的 planning 僵尸 → aborted + 释放单活跃锁', () => {
    const now = Date.now()
    const zombie: Mission = {
      id: 'M-zombie', name: 'z', goal: 'g', status: 'planning', budget_usd: 3,
      spent_tokens: 0, spent_equiv_usd: 0, approval_mode: 1, cwd: root,
      worktree_policy: 'per-slot', orchestration_mode: 'commander', commander_healthy: true,
      created_at: now, updated_at: now,
    }
    store.createMission(zombie)
    // 无 orchestrator 持有 → maintenanceTick 判僵尸
    service.maintenanceTick()
    expect(store.getMission('M-zombie')!.status).toBe('aborted')
    expect(store.listEvents('M-zombie').some((e) => e.kind === 'mission_run_error')).toBe(true)
    // 锁释放：launch 不再被僵尸挡（用坏参数让它自己失败也无所谓，关键是不抛 ConcurrencyLimit）
    let blocked = false
    try {
      service.launch({ name: 'n', goal: 'g', cwd: join(root, 'x'), budgetUsd: 3, slots: roster })
    } catch (error) {
      blocked = error instanceof Error && error.message.includes('another mission is active')
    }
    expect(blocked).toBe(false)
  })
})
