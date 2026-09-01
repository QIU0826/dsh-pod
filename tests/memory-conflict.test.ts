/**
 * memory-conflict（P1-4 深化②）：reflection 冲突收口——借 Mem0 方法论，同话题多版本
 * 不再并存（contradicts 边 + 旧者降级退活跃注入位），纯函数层 + MemoryStore 集成。
 *
 * 锁定：
 *   - bigramDice 相似度（CJK bigram + ASCII 词，Dice 系数）；
 *   - 触发面：同 owner + 同 type + 共享标签 ≥2 + 相似度 ∈ [0.4, 1)；
 *   - 方向 = 旧 → 新（updated_ts 小者降级）；跨 type 互补事实不判冲突（supports 的职责）；
 *   - 已有 contradicts/supports 边 → 已裁决跳过；完全相同的文本归合并 pass（sim=1 排除）；
 *   - MemoryStore.runReflection：contradicts 边落地 + importance 降级 + 历史留痕，
 *     且先于 supports pass（顺序约束防抢占）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bigramDice, conflictCandidates, resolveConflicts, CONFLICT_SIM_MIN, CONFLICT_DEMOTE_TO } from '../src/core/memory-conflict.js'
import { MemoryStore } from '../src/core/memory.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pod-mem-conflict-'))
}

function rec(over: { id: string; owner_slot_id: string; type: string; tags: string[]; content_ref: string; updated_ts?: number; importance?: number }) {
  return { importance: 3, updated_ts: 1, ...over }
}

describe('bigramDice 相似度', () => {
  it('同话题近似文本高分、无关文本低分、完全相同为 1', () => {
    expect(bigramDice('SQLite 太慢换 Postgres', 'SQLite 太慢换 Postgres')).toBe(1)
    expect(bigramDice('SQLite 太慢换 Postgres', 'SQLite 太慢换 MySQL')).toBeGreaterThanOrEqual(CONFLICT_SIM_MIN)
    expect(bigramDice('用 SQLite 存记忆', '项目周报每周五汇总')).toBe(0)
  })
})

describe('conflictCandidates（触发面）', () => {
  it('同 owner+type+标签重叠+相似 → 候选；方向 = 旧 → 新', () => {
    const old = rec({ id: 'a', owner_slot_id: 'S-1', type: 'lesson', tags: ['db', 'storage'], content_ref: 'SQLite 太慢换 Postgres', updated_ts: 100 })
    const newer = rec({ id: 'b', owner_slot_id: 'S-1', type: 'lesson', tags: ['db', 'storage'], content_ref: 'SQLite 太慢换 MySQL', updated_ts: 200 })
    const out = conflictCandidates([old, newer], [])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ oldId: 'a', newId: 'b' })
  })

  it('跨 type（decision+fact）→ 互补事实不判冲突（supports 的职责）', () => {
    const decision = rec({ id: 'a', owner_slot_id: 'S-1', type: 'decision', tags: ['db', 'spec'], content_ref: '选 SQLite' })
    const fact = rec({ id: 'b', owner_slot_id: 'S-1', type: 'fact', tags: ['db', 'spec'], content_ref: 'SQLite 单文件' })
    expect(conflictCandidates([decision, fact], [])).toHaveLength(0)
  })

  it('不同 owner / 标签重叠不足 / 相似度过低 / 完全相同 → 均不判冲突', () => {
    const base = { type: 'lesson', tags: ['db', 'storage'], content_ref: '用 SQLite 存记忆', updated_ts: 100 }
    expect(conflictCandidates([rec({ id: 'a', owner_slot_id: 'S-1', ...base }), rec({ id: 'b', owner_slot_id: 'S-2', ...base })] , [])).toHaveLength(0)
    expect(conflictCandidates([
      rec({ id: 'a', owner_slot_id: 'S-1', ...base }),
      rec({ id: 'b', owner_slot_id: 'S-1', type: 'lesson', tags: ['db'], content_ref: 'SQLite 太慢换 Postgres', updated_ts: 200 }),
    ], [])).toHaveLength(0) // 共享标签 1 < 2
    expect(conflictCandidates([
      rec({ id: 'a', owner_slot_id: 'S-1', ...base }),
      rec({ id: 'b', owner_slot_id: 'S-1', type: 'lesson', tags: ['db', 'storage'], content_ref: '项目周报每周五汇总', updated_ts: 200 }),
    ], [])).toHaveLength(0) // 相似度 0 < 0.4
    expect(conflictCandidates([
      rec({ id: 'a', owner_slot_id: 'S-1', ...base }),
      rec({ id: 'b', owner_slot_id: 'S-1', ...base, updated_ts: 200 }),
    ], [])).toHaveLength(0) // 完全相同 → 合并 pass
  })

  it('已有 contradicts/supports 边 → 已裁决跳过（幂等）', () => {
    const a = rec({ id: 'a', owner_slot_id: 'S-1', type: 'lesson', tags: ['db', 'storage'], content_ref: 'SQLite 太慢换 Postgres', updated_ts: 100 })
    const b = rec({ id: 'b', owner_slot_id: 'S-1', type: 'lesson', tags: ['db', 'storage'], content_ref: 'SQLite 太慢换 MySQL', updated_ts: 200 })
    expect(conflictCandidates([a, b], [{ from_record: 'a', to_record: 'b', relation: 'contradicts' }])).toHaveLength(0)
    expect(conflictCandidates([a, b], [{ from_record: 'b', to_record: 'a', relation: 'supports' }])).toHaveLength(0)
  })
})

describe('resolveConflicts（收口输出）', () => {
  it('产出 contradicts 边 + 旧者降级（importance>1 才降）', () => {
    const old = rec({ id: 'a', owner_slot_id: 'S-1', type: 'lesson', tags: ['db', 'storage'], content_ref: 'SQLite 太慢换 Postgres', importance: 4, updated_ts: 100 })
    const newer = rec({ id: 'b', owner_slot_id: 'S-1', type: 'lesson', tags: ['db', 'storage'], content_ref: 'SQLite 太慢换 MySQL', updated_ts: 200 })
    const { edgesToAdd, demotions } = resolveConflicts([old, newer], [])
    expect(edgesToAdd).toEqual([{ from_record: 'a', to_record: 'b', relation: 'contradicts' }])
    expect(demotions).toEqual([{ id: 'a', importance: CONFLICT_DEMOTE_TO }])
  })
})

describe('MemoryStore.runReflection 集成（P1-4 深化②）', () => {
  it('同话题多版本：contradicts 边 + 旧者降级 + 历史留痕；先于 supports 不被抢占', () => {
    const dir = tempDir()
    let t = 1_800_000_000_000
    const clock = () => (t += 1000)
    const store = new MemoryStore({ filePath: join(dir, 'memory.json'), clock })
    store.open()
    const old = store.write({ owner_slot_id: 'S-1', type: 'lesson', importance: 4, tags: ['db', 'storage'], content_ref: 'SQLite 太慢换 Postgres' })
    store.write({ owner_slot_id: 'S-1', type: 'lesson', importance: 4, tags: ['db', 'storage'], content_ref: 'SQLite 太慢换 MySQL' })
    const result = store.runReflection()
    expect(result.conflictsResolved).toBe(1)
    expect(result.demoted).toBe(1)
    const oldRec = store.get(old.id)!
    expect(oldRec.importance).toBe(CONFLICT_DEMOTE_TO)
    const contrad = store.edges().filter((e) => e.relation === 'contradicts')
    expect(contrad).toHaveLength(1)
    expect(contrad[0]!.from_record).toBe(old.id)
    // 历史留痕（可审计：谁被谁的版本取代）
    const hist = store.historyOf(old.id)
    expect(hist.some((h) => (h.patch as { _conflicted_into?: string })._conflicted_into !== undefined)).toBe(true)
    // 该对被 contradicts 标记后，supports pass 不再补边（顺序约束生效）
    expect(store.edges().filter((e) => e.relation === 'supports')).toHaveLength(0)
    // 幂等：再次 reflection 不再重复裁决
    const again = store.runReflection()
    expect(again.conflictsResolved).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it('跨 type 互补事实不受冲突 pass 影响，仍正常补 supports 边', () => {
    const dir = tempDir()
    let t = 1_800_000_000_000
    const clock = () => (t += 1000)
    const store = new MemoryStore({ filePath: join(dir, 'memory.json'), clock })
    store.open()
    store.write({ owner_slot_id: 'S-1', type: 'decision', tags: ['db', 'spec'], content_ref: '选 SQLite' })
    store.write({ owner_slot_id: 'S-1', type: 'fact', tags: ['db', 'spec'], content_ref: 'SQLite 单文件' })
    const result = store.runReflection()
    expect(result.conflictsResolved).toBe(0)
    expect(result.demoted).toBe(0)
    expect(result.supportsLinked).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })
})
