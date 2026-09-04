/**
 * SqliteStore / openPodData —— v0.2 SQLite 迁移专项测试：
 * 1) 与 JsonStore 相同的 PodStore 接口行为（CRUD/去重/事件裁剪/跨重启持久化）；
 * 2) 存量 store.json → pod.db 非破坏迁移（旧文件转 .migrated）；
 * 3) memory 共享 pod.db（SqliteMemoryPersistence）；memory.json → pod.db 迁移；
 * 4) openPodData 默认 sqlite 引擎；显式 json 引擎回退。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuplicateIdError, NotFoundError } from '../src/core/errors.js'
import { JsonStore } from '../src/core/store.js'
import { SqliteStore } from '../src/core/sqlite-store.js'
import { openPodData } from '../src/core/store-open.js'
import { MemoryStore } from '../src/core/memory.js'
import type { Mission } from '../src/core/types.js'

let root: string
let clockNow: number

function makeMission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'M-1',
    name: 'test mission',
    goal: 'ship it',
    status: 'planning',
    budget_usd: 2,
    spent_tokens: 0,
    spent_equiv_usd: 0,
    approval_mode: 1,
    cwd: 'C:\\repo',
    worktree_policy: 'per-slot',
    orchestration_mode: 'commander',
    commander_healthy: true,
    created_at: clockNow,
    updated_at: clockNow,
    ...over,
  }
}

function makeSlot(id = 'S-1', missionId = 'M-1') {
  return {
    id, mission_id: missionId, vendor: 'claude' as const, role: 'implementer', capabilities: ['编码'],
    model: 'deepseek-v4-pro', effort: 'medium' as const, session_tier: 'per-mission' as const,
    status: 'idle' as const, tokens_in: 0, tokens_out: 0, ctx_usage_pct: 0, window_tokens: 200_000,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pod-sqlite-'))
  clockNow = 1_700_000_000_000
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('SqliteStore 接口（与 JsonStore 同 PodStore 契约）', () => {
  it('open 创建 pod.db + schema v1，空集合', () => {
    const store = new SqliteStore({ rootDir: root, clock: () => clockNow })
    store.open()
    expect(store.getSchemaVersion()).toBe(1)
    expect(store.listMissions()).toEqual([])
    expect(existsSync(join(root, 'pod.db'))).toBe(true)
    expect(existsSync(join(root, 'store.json'))).toBe(false)
    store.close()
  })

  it('mission CRUD + 注入时钟 + 去重 + NotFound', () => {
    const store = new SqliteStore({ rootDir: root, clock: () => clockNow })
    store.open()
    clockNow = 1_700_000_123_000
    store.createMission(makeMission())
    expect(store.getMission('M-1')!.created_at).toBe(1_700_000_123_000)
    expect(() => store.createMission(makeMission())).toThrowError(DuplicateIdError)
    clockNow += 5_000
    store.updateMission('M-1', { status: 'running' })
    expect(store.getMission('M-1')!.status).toBe('running')
    expect(store.getMission('M-1')!.updated_at).toBe(1_700_000_128_000)
    expect(() => store.updateMission('nope', { status: 'done' })).toThrowError(NotFoundError)
    expect(store.getActiveMission()?.id).toBe('M-1')
    store.close()
  })

  it('slot/task/handoff/ledger/approval/rule 全量 CRUD 与按 mission 过滤', () => {
    const store = new SqliteStore({ rootDir: root, clock: () => clockNow })
    store.open()
    store.createMission(makeMission())
    store.createMission(makeMission({ id: 'M-2', name: 'second' }))
    store.createSlot(makeSlot('S-1', 'M-1'))
    store.createSlot(makeSlot('S-2', 'M-2'))
    expect(store.listSlots('M-1')).toHaveLength(1)
    expect(store.getSlot('S-2')!.mission_id).toBe('M-2')
    expect(() => store.createSlot(makeSlot('S-1', 'M-1'))).toThrowError(DuplicateIdError)
    store.createTask({ id: 'T-1', mission_id: 'M-1', title: 't', spec: 's', skill_tags: [], type: 'implement', depends_on: [], status: 'ready', attempts: 0, soft_attempts: 0, max_wall_clock_ms: 3600_000, created_at: clockNow, updated_at: clockNow })
    store.createTask({ id: 'T-2', mission_id: 'M-2', title: 't2', spec: 's', skill_tags: [], type: 'review', depends_on: [], status: 'ready', attempts: 0, soft_attempts: 0, max_wall_clock_ms: 3600_000, created_at: clockNow, updated_at: clockNow })
    expect(store.listTasks('M-1')).toHaveLength(1)
    expect(store.getTask('T-2')!.type).toBe('review')
    store.updateTask('T-1', { status: 'done' })
    expect(store.getTask('T-1')!.status).toBe('done')
    store.addHandoff({ id: 'H-1', mission_id: 'M-1', from_slot: 'S-1', to_slot: 'S-2', task_id: 'T-1', mode: 'queue', ts: clockNow, payload: { intent: { brief: 'b', constraints: [], acceptance: 'a' }, artifacts: { spec: 's', context_files: [] }, state: { tried: [], blockers: [] }, expected_output: 'e', verify: [] } })
    expect(store.listHandoffs('M-1')).toHaveLength(1)
    expect(store.listHandoffs('M-2')).toHaveLength(0)
    store.addLedgerEntry({ mission_id: 'M-1', slot_id: 'S-1', model: 'deepseek-v4-pro', ts: clockNow, tokens_in: 10, tokens_out: 5, equiv_usd: 0.01, price_table_version: 'v1', price_known: true, usage_source: 'measured' })
    store.addLedgerEntry({ mission_id: 'M-2', slot_id: 'S-2', model: 'deepseek-v4-pro', ts: clockNow, tokens_in: 1, tokens_out: 1, equiv_usd: 0, price_table_version: 'v1', price_known: false, usage_source: 'unavailable' })
    expect(store.listLedger('M-1')).toHaveLength(1)
    store.createApproval({ id: 'A-1', mission_id: 'M-1', status: 'pending', created_at: clockNow, patch: { slot_id: 'S-1', worktree_path: 'C:\\w\\S-1', summary: 'merge' } })
    store.createApproval({ id: 'A-2', mission_id: 'M-2', status: 'pending', created_at: clockNow, patch: { slot_id: 'S-2', worktree_path: 'C:\\w\\S-2', summary: 'merge' } })
    expect(store.listApprovals('M-1')).toHaveLength(1)
    store.updateApproval('A-1', { status: 'approved', decided_at: clockNow, decided_by: 'user' })
    expect(store.getApproval('A-1')!.status).toBe('approved')
    expect(() => store.createApproval({ id: 'A-1', mission_id: 'M-1', status: 'pending', created_at: clockNow, patch: { slot_id: 'S-1', worktree_path: 'C:\\w\\S-1', summary: 'merge' } })).toThrowError(DuplicateIdError)
    store.createRule({ id: 'R-1', tool: 'Bash', pattern: 'git push', decision: 'deny', scope: 'global', ts: clockNow })
    expect(store.listRules()).toHaveLength(1)
    store.deleteRule('R-1')
    expect(store.getRule('R-1')).toBeUndefined()
    expect(() => store.deleteRule('nope')).toThrowError(NotFoundError)
    store.close()
  })

  it('事件：追加保序 + 上限裁剪到 MAX_EVENTS_PER_MISSION（2000）', () => {
    const store = new SqliteStore({ rootDir: root, clock: () => clockNow })
    store.open()
    store.createMission(makeMission())
    for (let i = 0; i < 2500; i++) {
      store.appendEvent('M-1', { id: `E-${i}`, mission_id: 'M-1', ts: clockNow, kind: 'test', payload: { i } })
    }
    const events = store.listEvents('M-1')
    expect(events).toHaveLength(2000)
    expect(events[0]!.id).toBe('E-500')
    expect(events[1999]!.id).toBe('E-2499')
    // 顺序保序（seq 而非插入顺序错乱）
    expect(events.map((e) => e.id)[0]).toBe('E-500')
    store.close()
  })

  it('dropEvents 留 seq 空洞后裁剪仍按条数（与 JsonStore 同语义），不提前丢历史（2026-09-04）', () => {
    const store = new SqliteStore({ rootDir: root, clock: () => clockNow })
    store.open()
    store.createMission(makeMission())
    for (let i = 0; i < 2000; i++) {
      store.appendEvent('M-1', { id: `E-${i}`, mission_id: 'M-1', ts: clockNow, kind: 'test', payload: { i } })
    }
    // 重派删旧 task_context 的真实形态（orchestrator 派发路径常态调用）：删中间一段 → seq 空洞
    const dropped = store.dropEvents('M-1', (e) => {
      const i = (e.payload as { i: number }).i
      return i >= 500 && i < 1000
    })
    expect(dropped).toBe(500)
    // 再追加 1 条：总数 1501 远未到上限——E-0 必须还在。
    // 修复前按 seq 距离裁（seq <= nextSeq-2000 = 0）→ E-0 被误删：空洞位浪费保留窗口。
    store.appendEvent('M-1', { id: 'E-2000', mission_id: 'M-1', ts: clockNow, kind: 'test', payload: { i: 2000 } })
    let events = store.listEvents('M-1')
    expect(events).toHaveLength(1501)
    expect(events[0]!.id).toBe('E-0')
    // 继续追加越过上限：仍按条数裁到最新 2000 条（最老者出局，与空洞位置无关）
    for (let i = 2001; i <= 2500; i++) {
      store.appendEvent('M-1', { id: `E-${i}`, mission_id: 'M-1', ts: clockNow, kind: 'test', payload: { i } })
    }
    events = store.listEvents('M-1')
    expect(events).toHaveLength(2000)
    expect(events[0]!.id).toBe('E-1')
    expect(events[1999]!.id).toBe('E-2500')
    store.close()
  })

  it('跨重启持久化：关闭后重开，mission/task/approval/events 从 pod.db 原样重建', () => {
    const store = new SqliteStore({ rootDir: root, clock: () => clockNow })
    store.open()
    store.createMission(makeMission({ status: 'awaiting_approval' }))
    store.createTask({ id: 'T-1', mission_id: 'M-1', title: 't', spec: 's', skill_tags: ['编码'], type: 'implement', depends_on: [], status: 'done', attempts: 0, soft_attempts: 0, max_wall_clock_ms: 3600_000, created_at: clockNow, updated_at: clockNow, owner_slot_id: 'S-1', commit_sha: 'abc123' })
    store.createApproval({ id: 'A-1', mission_id: 'M-1', status: 'pending', created_at: clockNow, patch: { slot_id: 'S-1', worktree_path: 'C:\\w\\S-1', base_commit: 'b', head_commit: 'abc123', summary: 'merge' } })
    store.appendEvent('M-1', { id: 'E-1', mission_id: 'M-1', ts: clockNow, kind: 'test', payload: {} })
    store.close()
    const reopened = new SqliteStore({ rootDir: root, clock: () => clockNow })
    reopened.open()
    expect(reopened.getMission('M-1')!.status).toBe('awaiting_approval')
    expect(reopened.getTask('T-1')!.commit_sha).toBe('abc123')
    expect(reopened.getApproval('A-1')!.patch.worktree_path).toBe('C:\\w\\S-1')
    expect(reopened.listEvents('M-1')).toHaveLength(1)
    reopened.close()
  })

  it('deleteMission 级联删除全部归属表（含无主键的 ledger 按 seq），其他 mission 保留', () => {
    const store = new SqliteStore({ rootDir: root, clock: () => clockNow })
    store.open()
    store.createMission(makeMission({ id: 'M-1', status: 'done' }))
    store.createMission(makeMission({ id: 'M-2', status: 'done' }))
    for (const mid of ['M-1', 'M-2']) {
      store.createSlot(makeSlot(`S-${mid}`, mid))
      store.createTask({ id: `T-${mid}`, mission_id: mid, title: 't', spec: 's', skill_tags: [], type: 'implement', depends_on: [], status: 'done', attempts: 0, soft_attempts: 0, max_wall_clock_ms: 3600_000, created_at: clockNow, updated_at: clockNow })
      store.addHandoff({ id: `H-${mid}`, mission_id: mid, from_slot: `S-${mid}`, to_slot: `S-${mid}`, task_id: `T-${mid}`, mode: 'queue', ts: clockNow, payload: { intent: { brief: 'b', constraints: [], acceptance: 'a' }, artifacts: { spec: 's', context_files: [] }, state: { tried: [], blockers: [] }, expected_output: 'e', verify: [] } })
      store.addLedgerEntry({ mission_id: mid, slot_id: `S-${mid}`, model: 'deepseek-v4-pro', ts: clockNow, tokens_in: 10, tokens_out: 5, equiv_usd: 0.01, price_table_version: 'v1', price_known: true, usage_source: 'measured' })
      store.addResetEntry({ id: `RE-${mid}`, mission_id: mid, slot_id: `S-${mid}`, type: 'fact', content: 'done', status: 'active', ts: clockNow })
      store.createApproval({ id: `A-${mid}`, mission_id: mid, status: 'pending', created_at: clockNow, patch: { slot_id: `S-${mid}`, worktree_path: `C:\\w\\${mid}`, summary: 'merge' } })
      store.appendEvent(mid, { id: `E-${mid}`, mission_id: mid, ts: clockNow, kind: 'test', payload: {} })
    }
    store.deleteMission('M-1')
    expect(store.getMission('M-1')).toBeUndefined()
    expect(store.listSlots('M-1')).toEqual([])
    expect(store.listTasks('M-1')).toEqual([])
    expect(store.listHandoffs('M-1')).toEqual([])
    expect(store.listLedger('M-1')).toEqual([])
    expect(store.listResetEntries('M-1')).toEqual([])
    expect(store.listApprovals('M-1')).toEqual([])
    expect(store.listEvents('M-1')).toEqual([])
    // 相邻 mission 每类集合原样保留
    expect(store.getMission('M-2')).toBeDefined()
    expect(store.listSlots('M-2')).toHaveLength(1)
    expect(store.listTasks('M-2')).toHaveLength(1)
    expect(store.listHandoffs('M-2')).toHaveLength(1)
    expect(store.listLedger('M-2')).toHaveLength(1)
    expect(store.listResetEntries('M-2')).toHaveLength(1)
    expect(store.listApprovals('M-2')).toHaveLength(1)
    expect(store.listEvents('M-2')).toHaveLength(1)
    expect(() => store.deleteMission('nope')).toThrowError(NotFoundError)
    store.close()
  })
})

describe('存量 store.json → pod.db 迁移（非破坏）', () => {
  it('open 时检测 store.json 并导入全量，旧文件转 .migrated', () => {
    // 先用 JsonStore 造一批存量数据
    const legacy = new JsonStore({ rootDir: root, clock: () => clockNow })
    legacy.open()
    legacy.createMission(makeMission({ status: 'running' }))
    legacy.createSlot(makeSlot())
    legacy.createTask({ id: 'T-1', mission_id: 'M-1', title: 't', spec: 's', skill_tags: [], type: 'implement', depends_on: [], status: 'ready', attempts: 0, soft_attempts: 0, max_wall_clock_ms: 3600_000, created_at: clockNow, updated_at: clockNow })
    legacy.createApproval({ id: 'A-1', mission_id: 'M-1', status: 'pending', created_at: clockNow, patch: { slot_id: 'S-1', worktree_path: 'C:\\w\\S-1', summary: 'merge' } })
    legacy.appendEvent('M-1', { id: 'E-1', mission_id: 'M-1', ts: clockNow, kind: 'test', payload: {} })
    legacy.flush()
    legacy.close()
    // SQLite open → 自动迁移
    const store = new SqliteStore({ rootDir: root, clock: () => clockNow })
    store.open()
    expect(store.listMissions()).toHaveLength(1)
    expect(store.getMission('M-1')!.status).toBe('running')
    expect(store.listSlots('M-1')).toHaveLength(1)
    expect(store.listTasks('M-1')).toHaveLength(1)
    expect(store.listApprovals('M-1')).toHaveLength(1)
    expect(store.listEvents('M-1')).toHaveLength(1)
    // 旧文件保留（.migrated），绝不删除用户数据
    expect(existsSync(join(root, 'store.json.migrated'))).toBe(true)
    expect(existsSync(join(root, 'store.json'))).toBe(false)
    store.close()
  })

  it('幂等：迁移后再次 open 不重复导入', () => {
    const legacy = new JsonStore({ rootDir: root, clock: () => clockNow })
    legacy.open()
    legacy.createMission(makeMission())
    legacy.close()
    const s1 = new SqliteStore({ rootDir: root, clock: () => clockNow })
    s1.open()
    s1.close()
    const s2 = new SqliteStore({ rootDir: root, clock: () => clockNow })
    s2.open()
    expect(s2.listMissions()).toHaveLength(1)
    s2.close()
  })
})

describe('openPodData 引擎选择 + memory 共享 pod.db', () => {
  it('默认 sqlite 引擎：store 与 memory 共享 pod.db；memory CRUD 跨重启持久化', () => {
    const opened = openPodData({ rootDir: root, clock: () => clockNow })
    expect(opened.engine).toBe('sqlite')
    expect(opened.db).toBeDefined()
    const rec = opened.memory.write({ owner_slot_id: 'S-1', type: 'lesson', importance: 5, tags: ['sqlite'], content_ref: 'pod.db 单文件' })
    opened.memory.addEdge(rec.id, rec.id, 'supports')
    opened.memory.close()
    opened.store.close()
    const reopened = openPodData({ rootDir: root, clock: () => clockNow })
    expect(reopened.memory.get(rec.id)?.content_ref).toBe('pod.db 单文件')
    expect(reopened.memory.edges()).toHaveLength(1)
    // 同一 pod.db 文件（方案书 251：memory 进同一 SQLite 单文件）
    expect(existsSync(join(root, 'pod.db'))).toBe(true)
    expect(existsSync(join(root, 'memory.json'))).toBe(false)
    reopened.memory.close()
    reopened.store.close()
  })

  it('显式 engine=json 回退：memory.json 落盘', () => {
    const opened = openPodData({ rootDir: root, engine: 'json', clock: () => clockNow })
    expect(opened.engine).toBe('json')
    opened.memory.write({ owner_slot_id: 'S-1', content_ref: 'json 回退' })
    opened.memory.close()
    opened.store.close()
    expect(existsSync(join(root, 'memory.json'))).toBe(true)
  })

  it('存量 memory.json → pod.db 迁移（非破坏，旧文件转 .migrated）', () => {
    // 先写 JSON memory
    const jsonMem = new MemoryStore({ filePath: join(root, 'memory.json'), clock: () => clockNow })
    jsonMem.open()
    const rec = jsonMem.write({ owner_slot_id: 'S-1', type: 'decision', tags: ['migration'], content_ref: '记忆搬家' })
    jsonMem.close()
    // SQLite open → memory 数据搬入 pod.db
    const opened = openPodData({ rootDir: root, clock: () => clockNow })
    // 迁移保留原 record id（直接 load/save，不经 idFn 重新生成）
    expect(opened.memory.get(rec.id)?.content_ref).toBe('记忆搬家')
    expect(opened.memory.query({ owner_slot_id: 'S-1', tags: ['migration'] }).length).toBe(1)
    expect(existsSync(join(root, 'memory.json.migrated'))).toBe(true)
    opened.memory.close()
    opened.store.close()
  })
})

describe('SqliteMemoryPersistence（与 JSON 行为等价）', () => {
  it('query/correct/historyOf/reflection 与 JSON 后端结果一致', () => {
    const opened = openPodData({ rootDir: root, clock: () => clockNow })
    const a = opened.memory.write({ owner_slot_id: 'S-1', type: 'lesson', importance: 3, tags: ['a'], content_ref: 'x' })
    opened.memory.write({ owner_slot_id: 'S-1', type: 'lesson', importance: 3, tags: ['a'], content_ref: 'x' })
    opened.memory.write({ owner_slot_id: 'S-2', type: 'fact', importance: 1, tags: ['z'], content_ref: 'y' })
    expect(opened.memory.query({ owner_slot_id: 'S-1' })).toHaveLength(2)
    const updated = opened.memory.correct(a.id, { importance: 5 }, 'user')
    expect(updated.importance).toBe(5)
    expect(opened.memory.historyOf(a.id)).toHaveLength(1)
    const res = opened.memory.runReflection({ pruneMinImportance: 2, staleMaxMs: -1, autoLinkMinSharedTags: 2 })
    // 同 owner+type+content_ref 合并；低重要无边剪枝
    expect(res.merged).toBe(1)
    expect(res.pruned).toBe(1)
    opened.memory.close()
    opened.store.close()
  })

  it('reflection 边 ID 跨次运行不撞车（同毫秒两次 run：SQLite PK 约束下 save 不炸）', () => {
    // 修复前 MC-/ME- 边 ID 用 `-${k}` 计数器（每次 run 归零）+ 固定时钟 → 同毫秒两次
    // reflection 的第 1 条边 ID 必然相同 → memory_edges.id PRIMARY KEY INSERT 抛
    // UNIQUE 错误：runReflection 抛错且内存态已变异、持久化从此每次 save 都炸。
    // 修复后 ID 走 idFn（随机后缀，与记录 ID 同唯一性契约）。
    const opened = openPodData({ rootDir: root, clock: () => clockNow })
    const m = opened.memory
    // 三条同 owner+type+tags、两两 Dice 相似度 ∈ [0.4,1) 的记录 → run1 收口 3 对
    m.write({ owner_slot_id: 'S-1', type: 'fact', importance: 3, tags: ['a', 'b'], content_ref: 'alpha beta gamma' })
    m.write({ owner_slot_id: 'S-1', type: 'fact', importance: 3, tags: ['a', 'b'], content_ref: 'alpha beta delta' })
    m.write({ owner_slot_id: 'S-1', type: 'fact', importance: 3, tags: ['a', 'b'], content_ref: 'alpha gamma delta' })
    const r1 = m.runReflection()
    expect(r1.conflictsResolved).toBe(3)
    // D 与 A/B 构成新冲突对 → run2 再收口 2 条；修复前 ID 从 MC-<t>-0 重新计数即撞车
    m.write({ owner_slot_id: 'S-1', type: 'fact', importance: 3, tags: ['a', 'b'], content_ref: 'alpha beta eps' })
    const r2 = m.runReflection()
    expect(r2.conflictsResolved).toBe(2)
    const ids = m.edges().filter((e) => e.relation === 'contradicts').map((e) => e.id)
    expect(ids).toHaveLength(5)
    expect(new Set(ids).size).toBe(ids.length)
    opened.memory.close()
    opened.store.close()
  })
})