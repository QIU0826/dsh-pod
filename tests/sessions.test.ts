import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore } from '../src/core/store.js'
import { PodService } from '../src/pod-service.js'
import type { Mission, PodEvent } from '../src/core/types.js'

/**
 * 会话中心数据面（P2）：mission 历史 = 会话。
 * missionSummaries / missionArchive / approvalDetail 均直读 store，
 * active 与归档同构——历史会话回看不依赖运行中的编排器。
 */
describe('会话中心：mission 历史与归档（P2）', () => {
  let root: string
  let store: JsonStore
  let service: PodService
  let clockNow: number

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-sessions-'))
    clockNow = 1_700_000_000_000
    store = new JsonStore({ rootDir: root, clock: () => clockNow })
    store.open()
    service = new PodService({ store, backends: {}, clock: () => clockNow, dataDir: root })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function seedMission(over: Partial<Mission> = {}): Mission {
    clockNow += 1000
    const mission: Mission = {
      id: 'M-1',
      name: '会话一',
      goal: '给 README 增加安装章节',
      status: 'done',
      budget_usd: 3,
      spent_tokens: 1200,
      spent_equiv_usd: 0.5,
      approval_mode: 1,
      cwd: join(root, 'repo'),
      worktree_policy: 'per-slot',
      orchestration_mode: 'commander',
      commander_healthy: true,
      created_at: clockNow,
      updated_at: clockNow,
      ...over,
    }
    store.createMission(mission)
    return mission
  }

  it('missionSummaries：按创建时间倒序，含任务/token/槽位/最新事件聚合', () => {
    seedMission({ id: 'M-1', status: 'running' })
    seedMission({ id: 'M-2', status: 'done' })
    store.createSlot({ id: 'M-1-S-1', mission_id: 'M-1', vendor: 'claude', role: 'implementer', capabilities: ['编码'], status: 'idle', tokens_in: 0, tokens_out: 0, model: '', effort: 'medium', session_tier: 'transient', ctx_usage_pct: 0, window_tokens: 200_000 })
    store.createTask({ id: 'T-1', mission_id: 'M-1', title: '安装章节', spec: 's', type: 'implement', skill_tags: [], status: 'done', depends_on: [], attempts: 0, soft_attempts: 0, max_wall_clock_ms: 60_000, created_at: clockNow, updated_at: clockNow })
    store.addLedgerEntry({ mission_id: 'M-1', slot_id: 'M-1-S-1', task_id: 'T-1', model: 'demo', ts: clockNow, tokens_in: 800, tokens_out: 400, equiv_usd: 0.01, price_known: false, price_table_version: 'v0', usage_source: 'measured' })
    store.appendEvent('M-1', { id: 'ev-1', mission_id: 'M-1', ts: clockNow, kind: 'task_done', task_id: 'T-1', payload: {} } as PodEvent)

    const summaries = service.missionSummaries()
    expect(summaries.map((m) => m.id)).toEqual(['M-2', 'M-1'])
    const first = summaries[1]!
    expect(first.active).toBe(true)
    expect(first.task_total).toBe(1)
    expect(first.task_done).toBe(1)
    expect(first.tokens_in).toBe(800)
    expect(first.tokens_out).toBe(400)
    expect(first.slots).toEqual([{ id: 'M-1-S-1', role: 'implementer', vendor: 'claude', avatar: null }])
    expect(first.last_event?.kind).toBe('task_done')
  })

  it('missionArchive：归档快照含对话流/审批/账本；不存在的 mission → undefined', () => {
    seedMission({ id: 'M-1' })
    store.appendEvent('M-1', { id: 'ev-1', mission_id: 'M-1', ts: clockNow, kind: 'mission_created', payload: {} } as PodEvent)
    store.createApproval({ id: 'A-1', mission_id: 'M-1', kind: 'merge', task_id: 'T-1', patch: { slot_id: 'M-1-S-1', worktree_path: join(root, 'repo', '.pod-worktrees', 'S-1'), summary: 'README 安装章节' }, status: 'approved', created_at: clockNow })
    const archive = service.missionArchive('M-1')
    expect(archive).not.toBeUndefined()
    expect(archive!.events.map((e) => e.kind)).toContain('mission_created')
    expect(archive!.approvals[0]!.status).toBe('approved')
    expect(service.missionArchive('M-nope')).toBeUndefined()
  })

  it('approvalDetail：diff 在白名单根内可读；根外/超大降级为 null', () => {
    const repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    const worktree = join(repo, '.pod-worktrees', 'S-1')
    mkdirSync(worktree, { recursive: true })
    const diffFile = join(worktree, 'patch.diff')
    writeFileSync(diffFile, '+ ## 安装\n', 'utf8')
    seedMission({ id: 'M-1', cwd: repo })
    store.createApproval({ id: 'A-1', mission_id: 'M-1', patch: { slot_id: 'M-1-S-1', worktree_path: worktree, summary: 'README 安装章节', diff_path: diffFile }, status: 'pending', created_at: clockNow })
    // 根外 diff（系统临时目录其他位置）
    const outside = join(root, 'outside.diff')
    writeFileSync(outside, 'x', 'utf8')
    store.createApproval({ id: 'A-2', mission_id: 'M-1', patch: { slot_id: 'M-1-S-1', worktree_path: worktree, summary: 'x', diff_path: outside }, status: 'pending', created_at: clockNow })

    const good = service.approvalDetail('A-1')!
    expect(good.diff).toBe('+ ## 安装\n')
    expect(good.summary).toBe('README 安装章节')
    const bad = service.approvalDetail('A-2')!
    expect(bad.diff).toBeNull()
    expect(service.approvalDetail('A-nope')).toBeUndefined()
  })
})
