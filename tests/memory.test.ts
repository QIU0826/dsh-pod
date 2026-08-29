import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryStore } from '../src/core/memory.js'

function makeStore() {
  const dir = mkdtempSync(join(import.meta.dirname, '.mem-'))
  const store = new MemoryStore({ filePath: join(dir, 'memory.json'), clock: () => 1_700_000_000_000 })
  store.open()
  return { store, dir }
}

describe('记忆子系统 2.8.1（MemoryStore，主动策展 + 图谱 + reflection）', () => {
  it('write 创建策展记录（默认 type=fact / importance=3）', () => {
    const { store, dir } = makeStore()
    const rec = store.write({ owner_slot_id: 'S-1', tags: ['route'], content_ref: 'deepseek-v4-pro cost 低' })
    expect(rec.type).toBe('fact')
    expect(rec.importance).toBe(3)
    expect(store.get(rec.id)).toBeDefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('query：按 owner / type / tags / importance 过滤', () => {
    const { store, dir } = makeStore()
    store.write({ owner_slot_id: 'S-1', type: 'lesson', importance: 5, tags: ['review', 'quality'], content_ref: '审查必须给反例' })
    store.write({ owner_slot_id: 'S-2', type: 'fact', importance: 3, tags: ['route'], content_ref: 'X 更快' })
    expect(store.query({ owner_slot_id: 'S-1' })).toHaveLength(1)
    expect(store.query({ type: 'fact' })).toHaveLength(1)
    expect(store.query({ tags: ['review'] })).toHaveLength(1)
    expect(store.query({ importance_min: 4 })).toHaveLength(1)
    expect(store.query()).toHaveLength(2)
    rmSync(dir, { recursive: true, force: true })
  })

  it('图谱：addEdge + 沿 supports/contradicts 遍历邻居', () => {
    const { store, dir } = makeStore()
    const a = store.write({ owner_slot_id: 'S-1', type: 'decision', tags: ['stack'], content_ref: '选 A' })
    const b = store.write({ owner_slot_id: 'S-1', type: 'fact', tags: ['stack'], content_ref: 'A 实测稳定' })
    const c = store.write({ owner_slot_id: 'S-2', type: 'pattern', tags: ['stack'], content_ref: 'B 更简单' })
    store.addEdge(a.id, b.id, 'supports')
    store.addEdge(a.id, c.id, 'contradicts')
    const neighbors = store.query({ relates_to: a.id })
    expect(neighbors.map((r) => r.id).sort()).toEqual([b.id, c.id].sort())
    const supports = store.query({ relates_to: a.id, relation: 'supports' })
    expect(supports.map((r) => r.id)).toEqual([b.id])
    rmSync(dir, { recursive: true, force: true })
  })

  it('correct 更新并保留变更历史（审计留痕）', () => {
    const { store, dir } = makeStore()
    const rec = store.write({ owner_slot_id: 'S-1', type: 'fact', importance: 3, content_ref: '旧', tags: ['a'] })
    const updated = store.correct(rec.id, { importance: 5, content_ref: '新', tags: ['a', 'b'] }, 'user')
    expect(updated.importance).toBe(5)
    expect(updated.content_ref).toBe('新')
    const hist = store.historyOf(rec.id)
    expect(hist).toHaveLength(1)
    expect(hist[0]!.by).toBe('user')
    expect(hist[0]!.patch.importance).toBe(5)
    rmSync(dir, { recursive: true, force: true })
  })

  it('持久化：重开后跨实例读取（memory.json 磁盘事实源）', () => {
    const dir = mkdtempSync(join(import.meta.dirname, '.mem-'))
    const s1 = new MemoryStore({ filePath: join(dir, 'memory.json'), clock: () => 1 })
    s1.open()
    const rec = s1.write({ owner_slot_id: 'S-1', type: 'lesson', content_ref: '经验' })
    s1.addEdge(rec.id, rec.id, 'supports')
    s1.close()
    const s2 = new MemoryStore({ filePath: join(dir, 'memory.json'), clock: () => 2 })
    s2.open()
    expect(s2.get(rec.id)?.content_ref).toBe('经验')
    expect(s2.edges()).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it('runReflection：合并重复 + 自动补 supports 边 + 剪枝过时低重要记录', () => {
    const dir = mkdtempSync(join(import.meta.dirname, '.mem-'))
    let t = 1_800_000_000_000
    const clock = () => (t += 1000)
    const store = new MemoryStore({ filePath: join(dir, 'memory.json'), clock })
    store.open()
    // 重复（同 owner+type+content_ref）→ 合并为 1
    store.write({ owner_slot_id: 'S-1', type: 'lesson', content_ref: '重复经验' })
    store.write({ owner_slot_id: 'S-1', type: 'lesson', content_ref: '重复经验' })
    // 相关联（共享 2 标签）→ 自动补 supports
    store.write({ owner_slot_id: 'S-1', type: 'decision', tags: ['db', 'spec'], content_ref: '选 SQLite' })
    store.write({ owner_slot_id: 'S-1', type: 'fact', tags: ['db', 'spec'], content_ref: 'SQLite 单文件' })
    // 低 importance 无边 → 剪枝（把 updated_ts 推老）
    const old = store.write({ owner_slot_id: 'S-1', type: 'fact', importance: 1, content_ref: '过时' })
    ;(store as unknown as { data?: { records: Record<string, { updated_ts: number }> } }).data!.records[old.id]!.updated_ts = 1
    const result = store.runReflection({ staleMaxMs: 10 })
    expect(result.merged).toBe(1)
    expect(result.supportsLinked).toBe(1)
    expect(result.pruned).toBe(1)
    expect(store.all()).toHaveLength(3) // 2 去重后为1 + decision + fact = 3；过时已剪
    rmSync(dir, { recursive: true, force: true })
  })

  it('runReflection 合并方向：同键保留 updated_ts 最新者（H4 回归——方向反了会系统性淘汰新记忆）', () => {
    const dir = mkdtempSync(join(import.meta.dirname, '.mem-'))
    let t = 1_800_000_000_000
    const clock = () => (t += 1000)
    const store = new MemoryStore({ filePath: join(dir, 'memory.json'), clock })
    store.open()
    const first = store.write({ owner_slot_id: 'S-1', type: 'lesson', content_ref: '同一经验' })
    const second = store.write({ owner_slot_id: 'S-1', type: 'lesson', content_ref: '同一经验' })
    expect(second.updated_ts).toBeGreaterThan(first.updated_ts)
    const result = store.runReflection()
    expect(result.merged).toBe(1)
    const ids = store.all().map((r) => r.id)
    expect(ids).toContain(second.id) // 保留最新
    expect(ids).not.toContain(first.id) // 淘汰最旧
    rmSync(dir, { recursive: true, force: true })
  })
})