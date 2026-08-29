/**
 * SqliteStore —— 方案书 3.9 节 O12 / R12 的 v0.2 落地：
 * W0 已验证 better-sqlite3 在 Windows+Node22 的 prebuild 可用（本机实测：v13.0.3 下载成功且运行 OK，
 * 引擎声明 ^22.18 但 N-API 预编译对 Node 22.x 全系 ABI 兼容，CR-16 记录该边界）。
 *
 * 实现同一 PodStore 接口（调用方零改动），持久化到 ~/.dsh/pod/pod.db（单文件，WAL 模式）；
 * 每次变更即时提交（better-sqlite3 同步 API + 事务），跨重启无状态丢失（durable execution，附录 F-6）。
 *
 * 迁移（非破坏）：open() 时若 pod.db 不存在但存在存量 store.json → 读 JsonStore 数据导入 SQLite，
 * 旧文件转 store.json.migrated 保留为备份（绝不删除用户数据）。
 */

import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { DuplicateIdError, NotFoundError } from './errors.js'
import type {
  AgentSlot,
  ApprovalRequest,
  ApprovalRule,
  Handoff,
  LedgerEntry,
  Mission,
  PodEvent,
  Task,
} from './types.js'
import { JsonStore, MAX_EVENTS_PER_MISSION, SCHEMA_VERSION } from './store.js'
import type { PodStore } from './store.js'

export interface SqliteStoreOptions {
  /** 数据根目录（pod.db 落于此处）。 */
  rootDir: string
  /** 可注入时钟（测试确定性）。 */
  clock?: () => number
  /** 存量 store.json 的迁移源根目录（默认与 rootDir 相同）。 */
  migrateFrom?: string
}

/**
 * SQLite 后端。表结构：每行存完整实体 JSON（单机单用户数据量极小，
 * JSON 行 + SQLite 事务即可保证原子性与可审计性；查询按 id/mission 主键命中）。
 */
export class SqliteStore implements PodStore {
  private db: Database.Database | undefined
  private readonly rootDir: string
  private readonly clock: () => number

  constructor(options: SqliteStoreOptions) {
    this.rootDir = options.rootDir
    this.clock = options.clock ?? (() => Date.now())
  }

  /** 暴露底层连接（memory 等与 PodStore 共享同一 pod.db 单文件）。 */
  getDb(): Database.Database {
    return this.requireDb()
  }

  private requireDb(): Database.Database {
    if (this.db === undefined) throw new Error('store not opened: call open() first')
    return this.db
  }

  open(): void {
    mkdirSync(this.rootDir, { recursive: true })
    const dbPath = join(this.rootDir, 'pod.db')
    const fresh = !existsSync(dbPath)
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    this.db = db
    this.createTables()
    if (fresh) this.migrateFromJsonStore()
    this.migrateTaskKeys()
    this.ensureSchemaVersion()
  }

  private createTables(): void {
    this.requireDb().exec([
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS missions (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS slots (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS events (mission_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (mission_id, seq))',
    ].join(';'))
  }

  private ensureSchemaVersion(): void {
    const db = this.requireDb()
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined
    if (row === undefined) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
    }
  }

  /** 迁移：pod.db 首次创建时，若存在存量 store.json → 导入（旧文件转 .migrated 保留）。 */
  private migrateFromJsonStore(): void {
    const srcRoot = join(this.rootDir, 'store.json')
    if (!existsSync(srcRoot)) return
    // 复用 JsonStore 的读取/校验/迁移逻辑（含 rules 补表），避免重复解析
    const legacy = new JsonStore({ rootDir: this.rootDir, clock: this.clock })
    legacy.open()
    const db = this.requireDb()
    const tx = db.transaction(() => {
      const insMission = db.prepare('INSERT INTO missions (id, data) VALUES (?, ?)')
      for (const m of legacy.listMissions()) insMission.run(m.id, JSON.stringify(m))
      const insSlot = db.prepare('INSERT INTO slots (id, data) VALUES (?, ?)')
      const insTask = db.prepare('INSERT INTO tasks (id, data) VALUES (?, ?)')
      const insHandoff = db.prepare('INSERT INTO handoffs (id, data) VALUES (?, ?)')
      const insLedger = db.prepare('INSERT INTO ledger (data) VALUES (?)')
      const insApproval = db.prepare('INSERT INTO approvals (id, data) VALUES (?, ?)')
      const insRule = db.prepare('INSERT INTO rules (id, data) VALUES (?, ?)')
      const insEvent = db.prepare('INSERT INTO events (mission_id, seq, id, data) VALUES (?, ?, ?, ?)')
      for (const m of legacy.listMissions()) {
        for (const s of legacy.listSlots(m.id)) insSlot.run(s.id, JSON.stringify(s))
        for (const t of legacy.listTasks(m.id)) insTask.run(`${t.mission_id}::${t.id}`, JSON.stringify(t))
        for (const h of legacy.listHandoffs(m.id)) insHandoff.run(h.id, JSON.stringify(h))
        for (const e of legacy.listLedger(m.id)) insLedger.run(JSON.stringify(e))
        for (const a of legacy.listApprovals(m.id)) insApproval.run(a.id, JSON.stringify(a))
        legacy.listEvents(m.id).forEach((ev, i) => insEvent.run(m.id, i, ev.id, JSON.stringify(ev)))
      }
      for (const r of legacy.listRules()) insRule.run(r.id, JSON.stringify(r))
    })
    tx()
    // 非破坏：旧文件转 .migrated（保留用户数据，不删除）
    renameSync(srcRoot, join(this.rootDir, 'store.json.migrated'))
    legacy.close()
  }

  /** 存量迁移：tasks 表旧短键 → mission::id 复合键；幂等。 */
  private migrateTaskKeys(): void {
    const db = this.requireDb()
    const rows = db.prepare('SELECT id, data FROM tasks').all() as Array<{ id: string; data: string }>
    const renames: Array<[string, string]> = []
    for (const row of rows) {
      const task = JSON.parse(row.data) as { mission_id: string; id: string }
      const full = `${task.mission_id}::${task.id}`
      if (row.id !== full) renames.push([row.id, full])
    }
    if (renames.length === 0) return
    const tx = db.transaction(() => {
      const del = db.prepare('DELETE FROM tasks WHERE id = ?')
      const ins = db.prepare('INSERT INTO tasks (id, data) VALUES (?, ?)')
      for (const [oldKey, full] of renames) {
        const data = (db.prepare('SELECT data FROM tasks WHERE id = ?').get(oldKey) as { data: string } | undefined)?.data
        if (data === undefined) continue
        del.run(oldKey)
        ins.run(full, data)
      }
    })
    tx()
  }

  getSchemaVersion(): number {
    const row = this.requireDb().prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined
    return row === undefined ? SCHEMA_VERSION : Number(row.value)
  }

  private getJson<T>(table: string, id: string): T | undefined {
    const row = this.requireDb().prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined
    return row === undefined ? undefined : (JSON.parse(row.data) as T)
  }

  private listJson<T>(table: string, where?: string, params: unknown[] = []): T[] {
    const sql = where === undefined ? `SELECT data FROM ${table}` : `SELECT data FROM ${table} WHERE ${where}`
    const rows = this.requireDb().prepare(sql).all(...params) as Array<{ data: string }>
    return rows.map((r) => JSON.parse(r.data) as T)
  }

  private upsertJson(table: string, id: string, data: unknown): void {
    this.requireDb().prepare(`INSERT INTO ${table} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(id, JSON.stringify(data))
  }

  getMission(id: string): Mission | undefined {
    return this.getJson<Mission>('missions', id)
  }

  listMissions(): Mission[] {
    return this.listJson<Mission>('missions')
  }

  getActiveMission(): Mission | undefined {
    return this.listMissions().find((m) => m.status !== 'done' && m.status !== 'aborted')
  }

  createMission(mission: Mission): void {
    const db = this.requireDb()
    try {
      db.prepare('INSERT INTO missions (id, data) VALUES (?, ?)').run(mission.id, JSON.stringify({ ...mission }))
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateIdError('mission', mission.id)
      throw err
    }
  }

  updateMission(id: string, patch: Partial<Mission>): void {
    const existing = this.getMission(id)
    if (existing === undefined) throw new NotFoundError('mission', id)
    this.upsertJson('missions', id, { ...existing, ...patch, id, updated_at: this.clock() })
  }

  getSlot(id: string): AgentSlot | undefined {
    return this.getJson<AgentSlot>('slots', id)
  }

  listSlots(missionId: string): AgentSlot[] {
    return this.listJson<AgentSlot>('slots').filter((s) => s.mission_id === missionId)
  }

  createSlot(slot: AgentSlot): void {
    const db = this.requireDb()
    try {
      db.prepare('INSERT INTO slots (id, data) VALUES (?, ?)').run(slot.id, JSON.stringify({ ...slot }))
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateIdError('slot', slot.id)
      throw err
    }
  }

  updateSlot(id: string, patch: Partial<AgentSlot>): void {
    const existing = this.getSlot(id)
    if (existing === undefined) throw new NotFoundError('slot', id)
    this.upsertJson('slots', id, { ...existing, ...patch, id })
  }

  getTask(missionIdOrId: string, maybeId?: string): Task | undefined {
    if (maybeId !== undefined) return this.getJson<Task>('tasks', `${missionIdOrId}::${maybeId}`)
    return this.listJson<Task>('tasks').find((t) => t.id === missionIdOrId)
  }

  listTasks(missionId: string): Task[] {
    return this.listJson<Task>('tasks').filter((t) => t.mission_id === missionId)
  }

  createTask(task: Task): void {
    const db = this.requireDb()
    try {
      db.prepare('INSERT INTO tasks (id, data) VALUES (?, ?)').run(`${task.mission_id}::${task.id}`, JSON.stringify({ ...task }))
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateIdError('task', task.id)
      throw err
    }
  }

  updateTask(missionIdOrId: string, idOrPatch: string | Partial<Task>, maybePatch?: Partial<Task>): void {
    const db = this.requireDb()
    if (maybePatch !== undefined) {
      const key = `${missionIdOrId}::${idOrPatch}`
      const existing = this.getJson<Task>('tasks', key)
      if (existing === undefined) throw new NotFoundError('task', String(idOrPatch))
      this.upsertJson('tasks', key, { ...existing, ...maybePatch, id: existing.id, updated_at: maybePatch.updated_at ?? this.clock() })
      return
    }
    const patch = idOrPatch as Partial<Task>
    const row = db.prepare('SELECT id, data FROM tasks').all().find((r) => JSON.parse((r as { data: string }).data).id === missionIdOrId) as { id: string; data: string } | undefined
    if (row === undefined) throw new NotFoundError('task', missionIdOrId)
    const existing = JSON.parse(row.data) as Task
    this.upsertJson('tasks', row.id, { ...existing, ...patch, id: existing.id, updated_at: this.clock() })
  }

  addHandoff(handoff: Handoff): void {
    this.requireDb().prepare('INSERT INTO handoffs (id, data) VALUES (?, ?)').run(handoff.id, JSON.stringify({ ...handoff }))
  }

  listHandoffs(missionId: string): Handoff[] {
    return this.listJson<Handoff>('handoffs').filter((h) => h.mission_id === missionId)
  }

  addLedgerEntry(entry: LedgerEntry): void {
    this.requireDb().prepare('INSERT INTO ledger (data) VALUES (?)').run(JSON.stringify({ ...entry }))
  }

  listLedger(missionId: string): LedgerEntry[] {
    return this.listJson<LedgerEntry>('ledger').filter((e) => e.mission_id === missionId)
  }

  getApproval(id: string): ApprovalRequest | undefined {
    return this.getJson<ApprovalRequest>('approvals', id)
  }

  listApprovals(missionId: string): ApprovalRequest[] {
    return this.listJson<ApprovalRequest>('approvals').filter((a) => a.mission_id === missionId)
  }

  createApproval(approval: ApprovalRequest): void {
    const db = this.requireDb()
    try {
      db.prepare('INSERT INTO approvals (id, data) VALUES (?, ?)').run(approval.id, JSON.stringify({ ...approval }))
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateIdError('approval', approval.id)
      throw err
    }
  }

  updateApproval(id: string, patch: Partial<ApprovalRequest>): void {
    const existing = this.getApproval(id)
    if (existing === undefined) throw new NotFoundError('approval', id)
    this.upsertJson('approvals', id, { ...existing, ...patch, id })
  }

  getRule(id: string): ApprovalRule | undefined {
    return this.getJson<ApprovalRule>('rules', id)
  }

  listRules(): ApprovalRule[] {
    return this.listJson<ApprovalRule>('rules')
  }

  createRule(rule: ApprovalRule): void {
    const db = this.requireDb()
    try {
      db.prepare('INSERT INTO rules (id, data) VALUES (?, ?)').run(rule.id, JSON.stringify({ ...rule }))
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateIdError('rule', rule.id)
      throw err
    }
  }

  deleteRule(id: string): void {
    const db = this.requireDb()
    const res = db.prepare('DELETE FROM rules WHERE id = ?').run(id)
    if (res.changes === 0) throw new NotFoundError('rule', id)
  }

  appendEvent(missionId: string, event: PodEvent): void {
    const db = this.requireDb()
    // 取该 mission 当前最大 seq
    const maxRow = db.prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM events WHERE mission_id = ?').get(missionId) as { m: number }
    const nextSeq = maxRow.m + 1
    db.prepare('INSERT INTO events (mission_id, seq, id, data) VALUES (?, ?, ?, ?)').run(missionId, nextSeq, event.id, JSON.stringify({ ...event }))
    // 上限裁剪（与 JsonStore 同语义：保留最近 MAX_EVENTS_PER_MISSION 条）
    const del = db.prepare('DELETE FROM events WHERE mission_id = ? AND seq <= ?').run(missionId, nextSeq - MAX_EVENTS_PER_MISSION)
    void del
  }

  listEvents(missionId: string): PodEvent[] {
    return this.listJson<PodEvent>('events', 'mission_id = ?', [missionId])
  }

  flush(): void {
    // better-sqlite3 同步写 + 每操作即时提交（WAL），flush 为语义占位
  }

  close(): void {
    if (this.db !== undefined) {
      this.db.close()
      this.db = undefined
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && String((err as { code: unknown }).code).startsWith('SQLITE_CONSTRAINT')
}

