/**
 * 长期记忆子系统 —— 方案书 2.8.1 节（v2.1，借鉴 NVIDIA NOOA 记忆设计，CR-07）。
 *
 * 设计原则：记忆不是自动摘要管线，而是员工通过模型可调用工具主动策展的存储——
 * 主动写入（pod_mem_write）/ 查询（pod_mem_query）/ 纠正（pod_mem_correct）；
 * 类型化关系（supports/contradicts/derived-from）连成知识图谱而非平铺日志；
 * 后台 reflection 合并/关联/剪枝（输入 = 主动写入的策展记录，非原始对话转录）。
 *
 * v0.2 迁移：持久化抽成 MemoryPersistence 接口，JsonMemoryPersistence（memory.json，
 * 原子写）与 SqliteMemoryPersistence（~/.dsh/pod/pod.db 的 memory_* 表）双实现，
 * MemoryStore 算法与 API 完全不变（O12/R12：Store 抽象隔离，调用方零改动）。
 *
 * 关键纪律（CR-07-4）
 *   - 只注入与当前任务相关（importance+标签+关系匹配）的记录，不做万能全量注入；
 *   - 每个记忆工具能力测试走 pod_* 工具面（附录 F-18 自有资产），注册进 --allowedTools；
 *   - 不自动摘要会话日志（违背本设计）；蒸馏/剪枝输入是主动策展记录。
 */

import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWrite, sweepStaleTmp } from './atomic-write.js'
import { resolveConflicts } from './memory-conflict.js'
import type Database from 'better-sqlite3'
import { MemoryRecord, MemoryRelation, MemoryType } from './types.js'

export interface MemoryStoreOptions {
  /** JSON 持久化路径（v0.1/v0.2 默认 memory.json）。 */
  filePath?: string
  /** SQLite 持久化（v0.2 迁移：与 PodStore 共享 pod.db 连接）。传入即用 SQLite 后端。 */
  db?: Database.Database
  clock?: () => number
  idFn?: () => string
}

/** 纠正（correct）的变更历史（审计留痕，CR-07：可追溯）。 */
export interface MemoryChange {
  ts: number
  by?: string
  patch: Record<string, unknown>
}

/** 写入口（importance 收 number，内部 clamp 到 1-5）。 */
export interface MemoryWriteInput {
  owner_slot_id: string
  type?: MemoryType
  importance?: number
  tags?: string[]
  content_ref?: string
  live_ref?: string
  ts?: number
}

/** 纠正口（importance 收 number，内部 clamp）。 */
export interface MemoryPatch {
  type?: MemoryType
  importance?: number
  tags?: string[]
  content_ref?: string
  live_ref?: string
}

export interface MemoryData {
  schemaVersion: number
  records: Record<string, MemoryRecord>
  edges: Array<{ id: string; from_record: string; to_record: string; relation: MemoryRelation; ts: number }>
  history: Record<string, MemoryChange[]>
}

export interface MemoryQuery {
  owner_slot_id?: string
  type?: MemoryType
  tags?: string[]
  /** 最低 importance（含），1-5。 */
  importance_min?: number
  relation?: MemoryRelation
  /** 图谱遍历起点：返回与该记录相连的邻居及其边（含 relation 过滤）。 */
  relates_to?: string
  limit?: number
}

export interface ReflectionResult {
  merged: number
  /** P1-4 深化②：自动裁决的 contradicts 边数（同话题多版本收口）。 */
  conflictsResolved: number
  /** P1-4 深化②：因冲突降 importance 退活跃注入位的记录数。 */
  demoted: number
  supportsLinked: number
  pruned: number
}

/**
 * 团队级记忆归属（P1：经验从个体上升为团队资产，借鉴《从 ReAct 到 Agent Teams》「集体复盘」）。
 * owner_slot_id 是不透明字符串键——团队记录用「team:<mission_id>」作为 owner，与槽位记录天然隔离
 * （query 按 owner 精确匹配）。收口纪律（CR-07-4 同源）：团队记录由 commander（宿主 agent）主动策展
 * 写入，不做 mission 结束自动摘要；worker 个体记录仍走各自 owner_slot_id。
 */
export const TEAM_OWNER_PREFIX = 'team:'
/** mission 的团队 owner id（团队复盘记录的归属键）。 */
export function teamOwnerId(missionId: string): string {
  return TEAM_OWNER_PREFIX + missionId
}
/** 是否为团队级 owner（区别于槽位 owner）。 */
export function isTeamOwner(owner: string): boolean {
  return owner.startsWith(TEAM_OWNER_PREFIX)
}

function emptyMemoryData(): MemoryData {
  return { schemaVersion: 1, records: {}, edges: [], history: {} }
}

function clampImportance(v: number): 1 | 2 | 3 | 4 | 5 {
  const n = Math.max(1, Math.min(5, Math.round(v)))
  return n as 1 | 2 | 3 | 4 | 5
}

function diffRecord(before: MemoryRecord, after: MemoryRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (before.type !== after.type) out.type = after.type
  if (before.importance !== after.importance) out.importance = after.importance
  if (before.content_ref !== after.content_ref) out.content_ref = after.content_ref
  if (before.live_ref !== after.live_ref) out.live_ref = after.live_ref
  if (JSON.stringify(before.tags) !== JSON.stringify(after.tags)) out.tags = after.tags
  return out
}

/** 记忆持久化抽象（O12：SQLite 迁移只换后端，算法不变）。 */
export interface MemoryPersistence {
  open(): void
  /** 读取全量数据；无数据/损坏返回 undefined（fail-closed 空）。 */
  load(): MemoryData | undefined
  save(data: MemoryData): void
  close(): void
}

export interface JsonMemoryPersistenceOptions {
  filePath: string
}

/** JSON 后端（v0.1 默认）：tmp→bak→rename 原子写，可备份/审计。 */
export class JsonMemoryPersistence implements MemoryPersistence {
  private readonly filePath: string

  constructor(options: JsonMemoryPersistenceOptions) {
    this.filePath = options.filePath
  }

  open(): void {
    const dir = dirname(this.filePath)
    mkdirSync(dir, { recursive: true })
    // 扫掉崩溃进程遗留的 tmp 残骸（只删 pid 已死的），与 store.json 同源处置
    sweepStaleTmp(dir, '.memory.tmp-')
  }

  load(): MemoryData | undefined {
    const parsed = this.loadValidated(this.filePath)
    if (parsed !== undefined) return parsed
    // 主文件不存在 → 全新库（fail-closed 空，正常首次启动路径）
    if (!existsSync(this.filePath)) return undefined
    // 主文件损坏（2026-09-04 修复）：先试 .bak 自愈（atomicWrite 每次写前都把旧主文件
    // 转存 .bak，.bak = 最后一次成功写的内容），再把损坏主文件改名 .corrupt-* 留证。
    // 旧实现直接返回 undefined（注释声称「与 store 一致」，但 store.ts 实际是 .bak 自愈
    // + preserveCorrupt + 抛错）：空库起步后下一次 persist 的 backupPath 转存会把损坏
    // 主文件盖上 .bak——最后一份好备份被销毁，记忆全损且无证据残留。
    const fromBackup = this.loadValidated(`${this.filePath}.bak`)
    try {
      renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
    } catch {
      // 留证尽力而为；失败则维持现状（下次 persist 仍会把损坏内容转存 .bak）
    }
    return fromBackup
  }

  /** 解析 + 根形状校验（JSON 非法或根非对象 → undefined = 损坏，走 .bak/留证路径）。 */
  private loadValidated(path: string): MemoryData | undefined {
    if (!existsSync(path)) return undefined
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
      const p = parsed as Partial<MemoryData>
      return {
        schemaVersion: p.schemaVersion ?? 1,
        records: (p.records as Record<string, MemoryRecord> | undefined) ?? {},
        edges: (p.edges as MemoryData['edges'] | undefined) ?? [],
        history: (p.history as Record<string, MemoryChange[]> | undefined) ?? {},
      }
    } catch {
      return undefined
    }
  }

  save(data: MemoryData): void {
    // 与 store.json 同源的原子写内核：rename 失败（Windows EPERM）时清掉 tmp 残骸再重抛
    atomicWrite(this.filePath, JSON.stringify(data, null, 2), { backupPath: `${this.filePath}.bak` })
  }

  close(): void {}
}

/**
 * SQLite 后端（v0.2 迁移，方案书 251 行：memory 进同一 pod.db 单文件）：
 * memory_records / memory_edges / memory_history 三表，每行 JSON 存整条记录；
 * save 走事务整体替换（单机单用户数据量极小，简单可靠）。
 */
export class SqliteMemoryPersistence implements MemoryPersistence {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  open(): void {
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS memory_records (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS memory_edges (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS memory_history (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
    ].join(';'))
  }

  load(): MemoryData | undefined {
    const records: Record<string, MemoryRecord> = {}
    const edges: MemoryData['edges'] = []
    const history: Record<string, MemoryChange[]> = {}
    const recRows = this.db.prepare('SELECT id, data FROM memory_records').all() as Array<{ id: string; data: string }>
    for (const r of recRows) {
      try { records[r.id] = JSON.parse(r.data) as MemoryRecord } catch { /* 单条损坏跳过 */ }
    }
    const edgeRows = this.db.prepare('SELECT id, data FROM memory_edges').all() as Array<{ id: string; data: string }>
    for (const r of edgeRows) {
      try { edges.push(JSON.parse(r.data) as MemoryData['edges'][number]) } catch { /* skip */ }
    }
    const histRows = this.db.prepare('SELECT id, data FROM memory_history').all() as Array<{ id: string; data: string }>
    for (const r of histRows) {
      try { history[r.id] = JSON.parse(r.data) as MemoryChange[] } catch { /* skip */ }
    }
    if (recRows.length === 0 && edgeRows.length === 0 && histRows.length === 0) return undefined
    return { schemaVersion: 1, records, edges, history }
  }

  save(data: MemoryData): void {
    const replace = this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_records').run()
      this.db.prepare('DELETE FROM memory_edges').run()
      this.db.prepare('DELETE FROM memory_history').run()
      const insRec = this.db.prepare('INSERT INTO memory_records (id, data) VALUES (?, ?)')
      for (const [id, rec] of Object.entries(data.records)) insRec.run(id, JSON.stringify(rec))
      const insEdge = this.db.prepare('INSERT INTO memory_edges (id, data) VALUES (?, ?)')
      for (const e of data.edges) insEdge.run(e.id, JSON.stringify(e))
      const insHist = this.db.prepare('INSERT INTO memory_history (id, data) VALUES (?, ?)')
      for (const [id, changes] of Object.entries(data.history)) insHist.run(id, JSON.stringify(changes))
    })
    replace()
  }

  close(): void {
    // 连接由 PodStore 拥有（pod.db 单文件共享），此处不关
  }
}

/**
 * 记忆存储：算法与 API 与 v0.1 完全一致，仅持久化后端可换（JSON 或 SQLite）。
 * 「多 agent 共享存储但各自拥有」——records 按 owner_slot_id 隔离，
 * 查询可跨 owner 读公共经验（不传 owner_slot_id 即全量）。
 */
export class MemoryStore {
  private readonly persistence: MemoryPersistence
  private readonly clock: () => number
  private readonly idFn: () => string
  private data: MemoryData | undefined

  constructor(options: MemoryStoreOptions) {
    this.clock = options.clock ?? (() => Date.now())
    this.idFn = options.idFn ?? (() => `MEM-${this.clock()}-${Math.floor(Math.random() * 1e6)}`)
    if (options.db !== undefined) {
      this.persistence = new SqliteMemoryPersistence(options.db)
    } else if (options.filePath !== undefined) {
      this.persistence = new JsonMemoryPersistence({ filePath: options.filePath })
    } else {
      throw new Error('MemoryStore requires either filePath (JSON) or db (SQLite)')
    }
  }

  open(): void {
    this.persistence.open()
    this.data = this.persistence.load() ?? emptyMemoryData()
  }

  private require(): MemoryData {
    if (this.data === undefined) throw new Error('memory store not opened: call open() first')
    return this.data
  }

  private persist(): void {
    this.persistence.save(this.require())
  }

  /** pod_mem_write：主动写入策展记录（type/importance/tags/content_ref/live_ref）。 */
  write(input: MemoryWriteInput): MemoryRecord {
    const data = this.require()
    const now = this.clock()
    const type: MemoryType = input.type ?? 'fact'
    const importance = clampImportance(input.importance ?? 3)
    const record: MemoryRecord = {
      id: this.idFn(),
      owner_slot_id: input.owner_slot_id,
      type,
      importance,
      tags: input.tags ?? [],
      content_ref: input.content_ref ?? '',
      live_ref: input.live_ref,
      ts: input.ts ?? now,
      updated_ts: now,
    }
    data.records[record.id] = record
    this.persist()
    return record
  }

  get(id: string): MemoryRecord | undefined {
    return this.require().records[id]
  }

  all(): MemoryRecord[] {
    return Object.values(this.require().records)
  }

  /** pod_mem_query：按标签/类型/关系/owner/importance 查询 + 图谱遍历。 */
  query(q: MemoryQuery = {}): MemoryRecord[] {
    const data = this.require()
    const records = Object.values(data.records)
    let result = records.filter((r) => {
      if (q.owner_slot_id !== undefined && r.owner_slot_id !== q.owner_slot_id) return false
      if (q.type !== undefined && r.type !== q.type) return false
      if (q.importance_min !== undefined && r.importance < q.importance_min) return false
      if (q.tags !== undefined && q.tags.length > 0 && !q.tags.every((t) => r.tags.includes(t))) return false
      return true
    })
    // 图谱遍历：relates_to → 沿边找到邻居记录（relation 可选过滤）
    if (q.relates_to !== undefined) {
      const neighborIds = new Set<string>()
      for (const edge of data.edges) {
        if (q.relation !== undefined && edge.relation !== q.relation) continue
        if (edge.from_record === q.relates_to) neighborIds.add(edge.to_record)
        if (edge.to_record === q.relates_to) neighborIds.add(edge.from_record)
      }
      result = result.filter((r) => neighborIds.has(r.id))
    } else if (q.relation !== undefined) {
      // 无起点时按关系过滤：返回参与该关系的记录
      const involved = new Set<string>()
      for (const edge of data.edges) {
        if (edge.relation === q.relation) {
          involved.add(edge.from_record)
          involved.add(edge.to_record)
        }
      }
      result = result.filter((r) => involved.has(r.id))
    }
    // 排序：updated_ts 降序（最新优先）。必须在 limit 截断**之前**——此前无排序直接
    // slice，Object.values 返回插入序，limit 截断取到「最早写入的 N 条」；记忆库超限后
    // 新写入的记录（含跨 mission 经验，恰是最该注入的）会漏出候选池
    // （2026-09-03：injectRelevantMemory 全库候选路的语义漏洞，v11 命中只因当时总数 <32）。
    result.sort((a, b) => b.updated_ts - a.updated_ts)
    if (q.limit !== undefined) result = result.slice(0, q.limit)
    return result
  }

  /** pod_mem_correct：纠正/更新记录，保留变更历史（可审计）。 */
  correct(id: string, patch: MemoryPatch, by?: string): MemoryRecord {
    const data = this.require()
    const existing = data.records[id]
    if (existing === undefined) throw new Error(`memory record not found: ${id}`)
    const now = this.clock()
    const update: MemoryRecord = {
      ...existing,
      type: patch.type ?? existing.type,
      importance: patch.importance !== undefined ? clampImportance(patch.importance) : existing.importance,
      tags: patch.tags ?? existing.tags,
      content_ref: patch.content_ref ?? existing.content_ref,
      live_ref: patch.live_ref !== undefined ? patch.live_ref : existing.live_ref,
      updated_ts: now,
    }
    data.records[id] = update
    const hist = data.history[id] ?? (data.history[id] = [])
    hist.push({ ts: now, by, patch: diffRecord(existing, update) })
    this.persist()
    return update
  }

  historyOf(id: string): MemoryChange[] {
    return this.require().history[id] ?? []
  }

  addEdge(fromRecord: string, toRecord: string, relation: MemoryRelation): { id: string } {
    const data = this.require()
    if (data.records[fromRecord] === undefined || data.records[toRecord] === undefined) {
      throw new Error('memory edge requires both endpoints to exist')
    }
    const edge = { id: `ME-${this.idFn()}`, from_record: fromRecord, to_record: toRecord, relation, ts: this.clock() }
    data.edges.push(edge)
    this.persist()
    return { id: edge.id }
  }

  removeEdge(edgeId: string): void {
    const data = this.require()
    const idx = data.edges.findIndex((e) => e.id === edgeId)
    if (idx < 0) throw new Error(`memory edge not found: ${edgeId}`)
    data.edges.splice(idx, 1)
    this.persist()
  }

  edges(): Array<{ id: string; from_record: string; to_record: string; relation: MemoryRelation; ts: number }> {
    return this.require().edges
  }

  /**
   * 后台 reflection pass（复用 maintenanceTick 基础设施）：
   *   1) 合并同 owner+type+content_ref 的重复记录（保留最新，其余并入其历史）；
   *   2) 冲突收口（P1-4 深化②，Mem0 方法论）：同 owner+type+标签重叠+内容相似 →
   *      contradicts 边（旧→新）+ 旧记录降 importance 退出活跃注入位（不删除数据）；
   *      **必须先于 supports pass**——否则同话题对先被 supports 边标记为已裁决，
   *      冲突收口永不触发；
   *   3) 自动补 supports 边（同 owner 且共享 ≥2 标签的记录对）；
   *   4) 剪枝 importance<pruneMin 且 updated 早于 cutOff 且无任何边的过时记录。
   * 输入 = 主动写入的策展记录（非原始对话转录）；不做自动摘要（CR-07-4）。
   */
  runReflection(opts: { pruneMinImportance?: number; staleMaxMs?: number; autoLinkMinSharedTags?: number } = {}): ReflectionResult {
    const data = this.require()
    const pruneMin = opts.pruneMinImportance ?? 2
    const staleMax = opts.staleMaxMs ?? 30 * 24 * 60 * 60 * 1000
    const minShared = opts.autoLinkMinSharedTags ?? 2
    const now = this.clock()
    let merged = 0
    let conflictsResolved = 0
    let demoted = 0
    let supportsLinked = 0
    const ids = Object.keys(data.records)
    // 1) 合并重复：同 owner+type+content_ref，保留 updated_ts 最新者
    const keyOf = (r: MemoryRecord) => `${r.owner_slot_id}|${r.type}|${r.content_ref}`
    const latest: Record<string, MemoryRecord> = {}
    // 降序：最新记录先占 latest[key]，其后同键的陈旧副本并入历史——若升序则首次命中的是
    // 最旧记录，会把更新过的记录系统性淘汰（审计 H4，方向不可再反）。
    const order = ids.sort((a, b) => (data.records[b]!.updated_ts - data.records[a]!.updated_ts))
    for (const id of order) {
      const rec = data.records[id]!
      const key = keyOf(rec)
      const cur = latest[key]
      if (cur === undefined) {
        latest[key] = rec
      } else {
        // 并入历史后删除副本
        const hist = data.history[rec.id] ?? (data.history[rec.id] = [])
        hist.push({ ts: now, by: 'reflection', patch: { _merged_into: cur.id } })
        delete data.records[rec.id]
        data.edges = data.edges.filter((e) => e.from_record !== rec.id && e.to_record !== rec.id)
        merged++
      }
    }
    // 2) 冲突收口（P1-4 深化②）：纯函数裁决 → 落地 contradicts 边 + 旧者降级 + 历史留痕
    const recs = Object.values(data.records)
    const { edgesToAdd, demotions, candidates } = resolveConflicts(recs, data.edges, { minSharedTags: minShared })
    for (let k = 0; k < edgesToAdd.length; k++) {
      const e = edgesToAdd[k]!
      // ID 走 idFn（含随机后缀，与记录 ID 同契约）：旧实现 `MC-${now}-${k}` 计数器每次
      // run 归零——同毫秒两次 reflection（多实例共享 pod.db / 时钟回拨）产出重复 ID，
      // SQLite 后端 save 全量重插撞 PRIMARY KEY 抛错，内存态已变异、持久化从此次次
      // 失败（2026-09-04 修复）。
      data.edges.push({ id: `MC-${this.idFn()}`, from_record: e.from_record, to_record: e.to_record, relation: 'contradicts', ts: now })
      conflictsResolved++
    }
    for (const d of demotions) {
      const rec = data.records[d.id]
      if (rec !== undefined && rec.importance > d.importance) {
        rec.importance = d.importance
        rec.updated_ts = now
        const hist = data.history[d.id] ?? (data.history[d.id] = [])
        const target = candidates.find((c) => c.oldId === d.id)
        hist.push({ ts: now, by: 'reflection', patch: { _conflicted_into: target?.newId, importance: d.importance } })
        demoted++
      }
    }
    // 3) 自动补 supports 边（同 owner + 共享 ≥2 标签；已有任意边则跳过——含上一步 contradicts）
    for (let i = 0; i < recs.length; i++) {
      for (let j = i + 1; j < recs.length; j++) {
        const a = recs[i]!
        const b = recs[j]!
        if (a.owner_slot_id !== b.owner_slot_id) continue
        const shared = a.tags.filter((t) => b.tags.includes(t)).length
        if (shared < minShared) continue
        const exists = data.edges.some((e) =>
          (e.from_record === a.id && e.to_record === b.id) || (e.from_record === b.id && e.to_record === a.id)
        )
        if (!exists) {
          data.edges.push({ id: `ME-${this.idFn()}`, from_record: a.id, to_record: b.id, relation: 'supports', ts: now })
          supportsLinked++
        }
      }
    }
    // 4) 剪枝：importance < pruneMin 且超过 staleMax 未更新且无边
    let pruned = 0
    for (const id of Object.keys(data.records)) {
      const rec = data.records[id]!
      const hasEdge = data.edges.some((e) => e.from_record === id || e.to_record === id)
      if (rec.importance < pruneMin && now - rec.updated_ts > staleMax && !hasEdge) {
        const hist = data.history[rec.id] ?? (data.history[rec.id] = [])
        hist.push({ ts: now, by: 'reflection', patch: { _pruned: true } })
        delete data.records[id]
        pruned++
      }
    }
    this.persist()
    return { merged, conflictsResolved, demoted, supportsLinked, pruned }
  }

  flush(): void {
    this.persist()
  }

  close(): void {
    this.data = undefined
    this.persistence.close()
  }
}

export { emptyMemoryData }