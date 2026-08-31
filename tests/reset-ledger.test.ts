import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore } from '../src/core/store.js'
import { appendTaskFact, curateIncoming, renderResetSummaryFromLedger, resetSummaryFromStore, taskToFactEntry } from '../src/core/reset-ledger.js'
import type { Task } from '../src/core/types.js'

const now = 1_700_000_000_000

function makeTask(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    mission_id: 'M-1',
    title: id,
    spec: 's',
    skill_tags: [],
    type: 'implement',
    depends_on: [],
    status: 'done',
    attempts: 1,
    soft_attempts: 0,
    max_wall_clock_ms: 3600_000,
    created_at: now,
    updated_at: now,
    ...over,
  }
}

describe('taskToFactEntry（Generator：任务完成 → Rich fact 条目）', () => {
  it('含 commit / 测试结果 / 决策（替代旧摘要 title+commit+status 三字段）', () => {
    const task = makeTask('T-1', { title: '做限流器', commit_sha: 'a1b2c3', test_result: 'pass', test_evidence: '12/12 ✓', decisions: ['token bucket'], owner_slot_id: 'S-1' })
    const entry = taskToFactEntry(task, 'S-1', now)
    expect(entry.type).toBe('fact')
    expect(entry.status).toBe('active')
    expect(entry.content).toContain('T-1 做限流器')
    expect(entry.content).toContain('a1b2c3')
    expect(entry.content).toContain('pass')
    expect(entry.content).toContain('token bucket')
    expect(entry.task_id).toBe('T-1')
  })
})

describe('curateIncoming（Curator：幂等去重 + supersede 重做条目）', () => {
  it('同任务同 commit 已有 active 条目 → 幂等跳过（不重复入账）', () => {
    const existing = [taskToFactEntry(makeTask('T-1', { commit_sha: 'abc' }), 'S-1', now)]
    const superseded: string[] = []
    const add = curateIncoming(existing, taskToFactEntry(makeTask('T-1', { commit_sha: 'abc' }), 'S-1', now), (id) => superseded.push(id), now)
    expect(add).toBe(false)
    expect(superseded).toHaveLength(0)
  })

  it('同任务新 commit（重做成功）→ 旧条目标 superseded，新条目入账', () => {
    const old = taskToFactEntry(makeTask('T-1', { commit_sha: 'abc' }), 'S-1', now)
    const existing = [old]
    const superseded: string[] = []
    const add = curateIncoming(existing, taskToFactEntry(makeTask('T-1', { commit_sha: 'def' }), 'S-1', now + 100), (id) => superseded.push(id), now + 100)
    expect(add).toBe(true)
    expect(superseded).toEqual([old.id])
  })

  it('无源任务（决策/坑）直接入账', () => {
    const entry = { id: 'RE-x', mission_id: 'M-1', slot_id: 'S-1', type: 'decision' as const, content: 'd', status: 'active' as const, ts: now }
    const add = curateIncoming([], entry, () => {}, now)
    expect(add).toBe(true)
  })
})

describe('renderResetSummaryFromLedger（Reflector：只渲染 active 条目）', () => {
  it('只渲染 active，superseded 条目进留痕不进摘要', () => {
    const active = taskToFactEntry(makeTask('T-1', { commit_sha: 'abc' }), 'S-1', now)
    const superseded = { ...active, id: 'RE-old', status: 'superseded' as const, content: '被推翻' }
    const s = renderResetSummaryFromLedger([active, superseded], 'M-1', 'S-1')
    expect(s).toContain('T-1')
    expect(s).not.toContain('被推翻')
  })

  it('空账本 → 摘要骨架仍在（不重扫任务，无任务时不编造）', () => {
    const s = renderResetSummaryFromLedger([], 'M-1', 'S-1')
    expect(s).toContain('会话重置摘要')
    expect(s).toContain('（无）')
  })
})

describe('appendTaskFact + resetSummaryFromStore（store 集成，P1-1 端到端）', () => {
  let root: string
  let store: JsonStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-reset-ledger-'))
    store = new JsonStore({ rootDir: root })
    store.open()
    store.createMission({
      id: 'M-1', name: 'm', goal: 'g', status: 'running', budget_usd: 2,
      spent_tokens: 0, spent_equiv_usd: 0, approval_mode: 1, cwd: 'C:\\repo',
      worktree_policy: 'per-slot', orchestration_mode: 'commander',
      commander_healthy: true, created_at: now, updated_at: now,
    })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('任务完成入账 → 重置时从账本渲染（Rich 内容，含测试结果/决策）', () => {
    const task = makeTask('T-1', { owner_slot_id: 'S-1', commit_sha: 'abc', test_result: 'pass', test_evidence: '12/12 ✓', decisions: ['token bucket'] })
    const added = appendTaskFact(store, 'M-1', 'S-1', task, now)
    expect(added).toBeDefined()
    const s = resetSummaryFromStore(store, 'M-1', 'S-1')
    expect(s).toContain('12/12 ✓') // Rich：测试证据不再丢失（对比旧摘要 2/5 字段）
    expect(s).toContain('token bucket')
    expect(s).toContain('T-1')
  })

  it('同任务同 commit 重复入账幂等（账本不重复膨胀）', () => {
    const task = makeTask('T-1', { owner_slot_id: 'S-1', commit_sha: 'abc' })
    appendTaskFact(store, 'M-1', 'S-1', task, now)
    appendTaskFact(store, 'M-1', 'S-1', task, now + 1)
    expect(store.listResetEntries('M-1', 'S-1')).toHaveLength(1)
  })

  it('任务重做（新 commit）→ 旧条目标 superseded，账本保留两条（可审计）', () => {
    appendTaskFact(store, 'M-1', 'S-1', makeTask('T-1', { owner_slot_id: 'S-1', commit_sha: 'abc' }), now)
    appendTaskFact(store, 'M-1', 'S-1', makeTask('T-1', { owner_slot_id: 'S-1', commit_sha: 'def' }), now + 100)
    const entries = store.listResetEntries('M-1', 'S-1')
    expect(entries).toHaveLength(2)
    expect(entries.filter((e) => e.status === 'active')).toHaveLength(1)
    expect(entries.filter((e) => e.status === 'superseded')).toHaveLength(1)
    // 渲染只含 active（最新 commit），被推翻的不进摘要但留在账本
    const s = resetSummaryFromStore(store, 'M-1', 'S-1')
    expect(s).toContain('def')
    expect(s).not.toContain('abc')
  })
})