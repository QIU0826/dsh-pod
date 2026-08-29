import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuplicateIdError, NotFoundError, StoreCorruptError } from '../src/core/errors.js'
import { JsonStore } from '../src/core/store.js'
import type { Mission } from '../src/core/types.js'

let root: string
let clockNow: number

function makeStore() {
  return new JsonStore({ rootDir: root, clock: () => clockNow })
}

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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pod-store-'))
  clockNow = 1_700_000_000_000
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('JsonStore.open', () => {
  it('creates a fresh store with schema version 1 and empty collections', () => {
    const store = makeStore()
    store.open()
    expect(store.listMissions()).toEqual([])
    expect(existsSync(join(root, 'store.json'))).toBe(true)
    expect(store.getSchemaVersion()).toBe(1)
  })

  it('persists data across close and reopen', () => {
    const store = makeStore()
    store.open()
    store.createMission(makeMission())
    const reopened = makeStore()
    reopened.open()
    expect(reopened.getMission('M-1')?.name).toBe('test mission')
  })

  it('recovers from a corrupt primary file using the .bak backup', () => {
    const store = makeStore()
    store.open()
    store.createMission(makeMission())
    store.createMission(makeMission({ id: 'M-2', name: 'second' }))
    // Corrupt the primary but keep the .bak intact.
    writeFileSync(join(root, 'store.json'), '{"schemaVersion":1,"missions":{trunc')
    const reopened = makeStore()
    reopened.open()
    // .bak holds the state after the first write (only M-1).
    expect(reopened.getMission('M-1')).toBeDefined()
    // The corrupt file must be preserved for forensics.
    expect(readdirSync(root).some((f) => f.startsWith('store.json.corrupt-'))).toBe(true)
  })

  it('throws StoreCorruptError when both primary and backup are corrupt', () => {
    const store = makeStore()
    store.open()
    store.createMission(makeMission())
    writeFileSync(join(root, 'store.json'), 'not json {')
    writeFileSync(join(root, 'store.json.bak'), 'also not json [')
    const reopened = makeStore()
    expect(() => reopened.open()).toThrowError(StoreCorruptError)
  })

  it('state mutations write a valid JSON file synchronously; buffered events flush on flush()', () => {
    const store = makeStore()
    store.open()
    store.createMission(makeMission())
    let raw = readFileSync(join(root, 'store.json'), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(raw).toContain('M-1')
    store.appendEvent('M-1', { id: 'E-1', mission_id: 'M-1', ts: clockNow, kind: 'test', payload: {} })
    raw = readFileSync(join(root, 'store.json'), 'utf8')
    expect(raw).not.toContain('E-1')
    store.flush()
    raw = readFileSync(join(root, 'store.json'), 'utf8')
    expect(raw).toContain('E-1')
  })
})

describe('JsonStore mutations', () => {
  it('creates and reads a mission with the injected clock', () => {
    const store = makeStore()
    store.open()
    clockNow = 1_700_000_123_000
    store.createMission(makeMission())
    const got = store.getMission('M-1')!
    expect(got.created_at).toBe(1_700_000_123_000)
    expect(got.updated_at).toBe(1_700_000_123_000)
  })

  it('rejects duplicate mission ids', () => {
    const store = makeStore()
    store.open()
    store.createMission(makeMission())
    expect(() => store.createMission(makeMission())).toThrowError(DuplicateIdError)
  })

  it('updateMission patches fields and bumps updated_at', () => {
    const store = makeStore()
    store.open()
    store.createMission(makeMission())
    clockNow += 5_000
    store.updateMission('M-1', { status: 'running' })
    const got = store.getMission('M-1')!
    expect(got.status).toBe('running')
    expect(got.updated_at).toBe(clockNow)
  })

  it('updateMission on a missing mission throws NotFoundError', () => {
    const store = makeStore()
    store.open()
    expect(() => store.updateMission('nope', { status: 'done' })).toThrowError(NotFoundError)
  })

  it('appendEvent caps the event log per mission in memory and persists on flush', () => {
    const store = makeStore()
    store.open()
    store.createMission(makeMission())
    for (let i = 0; i < 2500; i++) {
      store.appendEvent('M-1', { id: `E-${i}`, mission_id: 'M-1', ts: clockNow, kind: 'test', payload: {} })
    }
    const events = store.listEvents('M-1')
    expect(events).toHaveLength(2000)
    expect(events[0]!.id).toBe('E-500')
    store.flush()
    const reopened = makeStore()
    reopened.open()
    expect(reopened.listEvents('M-1')).toHaveLength(2000)
    expect(reopened.listEvents('M-1')[0]!.id).toBe('E-500')
  })

  it('getActiveMission returns the single non-terminal mission', () => {
    const store = makeStore()
    store.open()
    store.createMission(makeMission({ id: 'M-done', status: 'done' }))
    store.createMission(makeMission({ id: 'M-live', status: 'running' }))
    expect(store.getActiveMission()?.id).toBe('M-live')
  })

  it('DoD-11 跨重启恢复：关闭后重新 open，mission/任务/审批卡从磁盘原样重建', () => {
    const store = makeStore()
    store.open()
    store.createMission(makeMission({ id: 'M-1', status: 'awaiting_approval' }))
    store.createTask({
      id: 'T-1', mission_id: 'M-1', title: 't', spec: 's', skill_tags: ['编码'], type: 'implement',
      depends_on: [], status: 'done', attempts: 0, soft_attempts: 0,
      max_wall_clock_ms: 3600_000, created_at: clockNow, updated_at: clockNow,
      owner_slot_id: 'S-1', commit_sha: 'abc123',
    })
    store.createApproval({
      id: 'A-1', mission_id: 'M-1', status: 'pending', created_at: clockNow,
      patch: { slot_id: 'S-1', worktree_path: 'C:\\w\\S-1', base_commit: 'b', head_commit: 'abc123', summary: 'merge' },
    })
    store.flush()
    // 模拟宿主/浏览器重启：全新实例重新 open（磁盘唯一事实源）
    const reopened = makeStore()
    reopened.open()
    expect(reopened.getMission('M-1')!.status).toBe('awaiting_approval')
    expect(reopened.getTask('T-1')!.commit_sha).toBe('abc123')
    const approval = reopened.getApproval('A-1')!
    expect(approval.status).toBe('pending')
    expect(approval.patch.worktree_path).toBe('C:\\w\\S-1')
    // 审批卡可继续裁决（跨重启审批闭环不丢）
    expect(reopened.listApprovals('M-1')).toHaveLength(1)
  })

  it('审批规则层：create/list/get/delete + 跨重启持久化（AgentScope-B）', () => {
    const store = makeStore()
    store.open()
    store.createRule({
      id: 'R-1', tool: 'Bash', pattern: 'git push', decision: 'deny', scope: 'global', ts: clockNow,
    })
    store.createRule({
      id: 'R-2', tool: 'apply_patch', decision: 'ask', scope: 'global', ts: clockNow,
    })
    expect(store.listRules()).toHaveLength(2)
    expect(store.getRule('R-1')!.decision).toBe('deny')
    expect(() => store.createRule({ id: 'R-1', tool: 'Bash', decision: 'allow', scope: 'mission', ts: clockNow })).toThrowError(DuplicateIdError)
    store.deleteRule('R-1')
    expect(store.getRule('R-1')).toBeUndefined()
    expect(() => store.deleteRule('nope')).toThrowError(NotFoundError)
    // 跨重启：rules 持久化
    store.flush()
    const reopened = makeStore()
    reopened.open()
    expect(reopened.getRule('R-2')!.decision).toBe('ask')
    // 旧 store 文件（无 rules 表）兼容：open 不炸且可写规则
    const legacyRoot = mkdtempSync(join(tmpdir(), 'pod-store-legacy-'))
    try {
      writeFileSync(join(legacyRoot, 'store.json'), JSON.stringify({ schemaVersion: 1, missions: {}, slots: {}, tasks: {}, handoffs: [], ledger: [], approvals: {}, events: {} }))
      const legacy = new JsonStore({ rootDir: legacyRoot })
      legacy.open()
      legacy.createRule({ id: 'R-x', tool: 'Bash', decision: 'allow', scope: 'global', ts: 1 })
      expect(legacy.getRule('R-x')!.decision).toBe('allow')
    } finally {
      rmSync(legacyRoot, { recursive: true, force: true })
    }
  })
})

describe('崩溃窗口恢复（P0：主文件缺失时回读 .bak，绝不静默开空库）', () => {
  it('persist 两次 rename 之间中断（main 缺失、bak 完好）→ open 从 .bak 恢复', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-bak-'))
    try {
      const s1 = new JsonStore({ rootDir: dir, clock: () => clockNow })
      s1.open()
      s1.createMission(makeMission({ id: 'M-keep' }))
      // 第二次落盘才会产生 .bak（首次 persist 无 main 可转）
      s1.createMission(makeMission({ id: 'M-2nd' }))
      // 模拟崩溃窗口：main→bak 已完成、tmp→main 未发生 → 磁盘只剩 .bak
      rmSync(join(dir, 'store.json'))
      expect(existsSync(join(dir, 'store.json.bak'))).toBe(true)
      const s2 = new JsonStore({ rootDir: dir, clock: () => clockNow })
      s2.open()
      expect(s2.getMission('M-keep')).toBeDefined()
      expect(s2.listMissions().map((m) => m.id)).toContain('M-keep')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('全新目录（main/bak 均缺失）→ 正常开空库', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-fresh-'))
    try {
      const s = new JsonStore({ rootDir: dir, clock: () => clockNow })
      s.open()
      expect(s.listMissions()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
