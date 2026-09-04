import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, TEAM_OWNER_PREFIX, isTeamOwner, teamOwnerId } from '../src/core/memory.js'

// 临时目录必须建在系统 tmp，不能建在源码树里：清理写在各测试末尾，一旦断言先失败
// 或 Windows 下 rmSync 偶发 EPERM（全套并行时实测会漏），残留目录就会污染 git status。
// 兜底：统一登记，afterAll 无条件再清一遍。
const made: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pod-mem-'))
  made.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function makeStore() {
  const dir = tempDir()
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

  it('团队级归属：team:<mission_id> 与槽位记录隔离（P1 团队复盘资产）', () => {
    const { store, dir } = makeStore()
    const team = teamOwnerId('M-1')
    expect(team).toBe('team:M-1')
    expect(TEAM_OWNER_PREFIX).toBe('team:')
    expect(isTeamOwner(team)).toBe(true)
    expect(isTeamOwner('S-1')).toBe(false)
    store.write({ owner_slot_id: team, type: 'lesson', importance: 5, tags: ['team', 'review'], content_ref: '本组合复盘：审查必须给可复现反例' })
    store.write({ owner_slot_id: 'S-1', type: 'fact', content_ref: '个体记录' })
    // 团队 owner 查询只命中团队记录；槽位查询互不串扰
    const teamRecs = store.query({ owner_slot_id: team })
    expect(teamRecs).toHaveLength(1)
    expect(teamRecs[0]!.tags).toContain('team')
    expect(store.query({ owner_slot_id: 'S-1' })).toHaveLength(1)
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

  it('query limit：updated_ts 降序截断——最新优先，非插入序（候选池语义修复）', () => {
    const dir = tempDir()
    let t = 1_700_000_000_000
    const clock = () => (t += 1000)
    const store = new MemoryStore({ filePath: join(dir, 'memory.json'), clock })
    store.open()
    const oldest = store.write({ owner_slot_id: 'S-1', content_ref: '老经验' })
    const mid = store.write({ owner_slot_id: 'S-1', content_ref: '中间' })
    const newest = store.write({ owner_slot_id: 'S-1', content_ref: '新经验（跨 mission 最该注入）' })
    // limit 截断取最新 N 条：此前无排序 slice 取到「最早写入的 N 条」，新经验漏出候选池
    const top2 = store.query({ limit: 2 })
    expect(top2.map((r) => r.id)).toEqual([newest.id, mid.id])
    expect(top2.some((r) => r.id === oldest.id)).toBe(false)
    // 无 limit 全量也按最新优先（Web 看板 / 注入一致语义）
    const all = store.query()
    expect(all[0]!.id).toBe(newest.id)
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
    const dir = tempDir()
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
    const dir = tempDir()
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
    const dir = tempDir()
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
describe('JsonMemoryPersistence 损坏自愈（2026-09-04）', () => {
  it('主文件损坏 → 从 .bak 自愈；损坏内容改名 .corrupt-* 留证，后续写不销毁好备份', () => {
    const dir = tempDir()
    const filePath = join(dir, 'memory.json')
    const store = new MemoryStore({ filePath, clock: () => 1_700_000_000_000 })
    store.open()
    const rec1 = store.write({ owner_slot_id: 'S-1', type: 'fact', importance: 3, tags: ['x'], content_ref: 'v1' })
    store.write({ owner_slot_id: 'S-1', type: 'fact', importance: 3, tags: ['x'], content_ref: 'v2' })
    store.close()
    // 此时 .bak = v1（rec1），主文件 = v2（rec1+rec2）。模拟损坏：垃圾字节覆盖主文件。
    writeFileSync(filePath, '{"records": {"MEM-1"', 'utf8')
    const reopened = new MemoryStore({ filePath, clock: () => 1_700_000_000_001 })
    reopened.open()
    // 修复前：load 返回 undefined → 空库起步 → rec1 丢失，且下一次写把损坏主文件
    // 转存为 .bak（最后一份好备份被销毁）。修复后：从 .bak 自愈。
    expect(reopened.get(rec1.id)).toBeDefined()
    expect(reopened.all()).toHaveLength(1)
    // 自愈后正常写入：损坏主文件已改名让位 → persist 不触 backupPath，.bak 保持 v1
    reopened.write({ owner_slot_id: 'S-1', type: 'fact', importance: 3, tags: ['y'], content_ref: 'v3' })
    reopened.close()
    const third = new MemoryStore({ filePath, clock: () => 1_700_000_000_002 })
    third.open()
    expect(third.all()).toHaveLength(2)
    const corruptName = readdirSync(dir).find((n) => n.startsWith('memory.json.corrupt-'))
    expect(corruptName).toBeDefined()
    expect(readFileSync(join(dir, 'memory.json.bak'), 'utf8')).toContain('v1')
    rmSync(dir, { recursive: true, force: true })
  })

  it('主文件与 .bak 双损坏 → 留证 + 空库起步（fail-closed 不阻断启动），后续写入正常', () => {
    const dir = tempDir()
    const filePath = join(dir, 'memory.json')
    const store = new MemoryStore({ filePath, clock: () => 1_700_000_000_000 })
    store.open()
    store.write({ owner_slot_id: 'S-1', type: 'fact', importance: 3, tags: ['x'], content_ref: 'a' })
    store.close()
    writeFileSync(filePath, 'not-json{', 'utf8')
    writeFileSync(`${filePath}.bak`, 'also-bad{', 'utf8')
    const reopened = new MemoryStore({ filePath, clock: () => 1_700_000_000_001 })
    reopened.open()
    expect(reopened.all()).toHaveLength(0)
    expect(readdirSync(dir).some((n) => n.startsWith('memory.json.corrupt-'))).toBe(true)
    reopened.write({ owner_slot_id: 'S-1', type: 'fact', importance: 3, tags: ['y'], content_ref: 'b' })
    expect(reopened.all()).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  })
})
