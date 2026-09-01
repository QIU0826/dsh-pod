/**
 * Store 抽象 —— 方案书 3.9 节 O12：
 * W0 决策为 JSON + 原子写回退（零原生依赖，单机单用户数据量极小）；
 * v0.2 迁移 SQLite 时实现同一 PodStore 接口即可，调用方零改动。
 *
 * 磁盘为唯一事实源（durable execution 范式，附录 F-6）：
 * 每次变更同步完成 tmp→bak→rename 原子序列，跨重启无状态丢失；
 * 损坏恢复：主文件坏 → .bak 兜底；两者皆坏 → 显式报错并保留损坏文件（fail fast，绝不静默开空库）。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { DuplicateIdError, NotFoundError, StoreCorruptError } from './errors.js'
import type {
  AgentSlot,
  ApprovalRequest,
  ApprovalRule,
  Handoff,
  LedgerEntry,
  Mission,
  PodEvent,
  ResetEntry,
  Task,
} from './types.js'

export const SCHEMA_VERSION = 1

export const MAX_EVENTS_PER_MISSION = 2000

export interface StoreData {
  schemaVersion: number
  missions: Record<string, Mission>
  slots: Record<string, AgentSlot>
  tasks: Record<string, Task>
  handoffs: Handoff[]
  ledger: LedgerEntry[]
  /** P1-1 delta 账本：会话重置摘要增量条目（ACE 化，可审计）。 */
  resetEntries: ResetEntry[]
  approvals: Record<string, ApprovalRequest>
  /** v2.1 审批规则层（suggested-rules 持久化，AgentScope-B）。 */
  rules: Record<string, ApprovalRule>
  events: Record<string, PodEvent[]>
}

/**
 * 未来的 schema 迁移表：key = 当前版本，value = 迁移到下一版本的函数。
 * MVP 只有 v1，表留空但机制就位（v0.2 SQLite 迁移同样走这里）。
 */
export const MIGRATIONS: Record<number, (data: StoreData) => StoreData> = {}

/** Store 接口（SQLite 与 JSON 双实现共用，3.9 节）。 */
export interface PodStore {
  getSchemaVersion(): number
  getMission(id: string): Mission | undefined
  listMissions(): Mission[]
  getActiveMission(): Mission | undefined
  createMission(mission: Mission): void
  updateMission(id: string, patch: Partial<Mission>): void
  /**
   * 删除整条 mission 及其全部归属数据（slots/tasks/handoffs/ledger/reset_entries/
   * approvals/events 按 mission_id 级联）。规则与 memory 等 mission 无关的知识层
   * 不在此列（知识层跨会话沉淀，2.8.1）。不存在抛 NotFoundError。
   */
  deleteMission(id: string): void
  getSlot(id: string): AgentSlot | undefined
  listSlots(missionId: string): AgentSlot[]
  createSlot(slot: AgentSlot): void
  updateSlot(id: string, patch: Partial<AgentSlot>): void
  /** 任务主键按 mission 复合（跨会话短 id 合法；实证：连续会话 P-1 全局撞键 DUPLICATE_TASK）。 */
  getTask(missionId: string, id: string): Task | undefined
  /** 兼容重载：单参按短 id 全表精确匹配（旧调用/测试；多 mission 同名取先建者）。 */
  // eslint-disable-next-line @typescript-eslint/unified-signatures
  getTask(id: string): Task | undefined
  listTasks(missionId: string): Task[]
  createTask(task: Task): void
  updateTask(missionId: string, id: string, patch: Partial<Task>): void
  // eslint-disable-next-line @typescript-eslint/unified-signatures
  updateTask(id: string, patch: Partial<Task>): void
  addHandoff(handoff: Handoff): void
  listHandoffs(missionId: string): Handoff[]
  updateHandoff(missionId: string, id: string, patch: Partial<Handoff>): void
  addLedgerEntry(entry: LedgerEntry): void
  listLedger(missionId: string): LedgerEntry[]
  /** P1-1 delta 账本：重置摘要增量条目。 */
  listResetEntries(missionId: string, slotId?: string): ResetEntry[]
  addResetEntry(entry: ResetEntry): void
  /** 把条目置 superseded（保留留痕，可审计）；不存在抛 NotFoundError。 */
  supersedeResetEntry(missionId: string, id: string, ts?: number): void
  getApproval(id: string): ApprovalRequest | undefined
  listApprovals(missionId: string): ApprovalRequest[]
  createApproval(approval: ApprovalRequest): void
  updateApproval(id: string, patch: Partial<ApprovalRequest>): void
  getRule(id: string): ApprovalRule | undefined
  listRules(): ApprovalRule[]
  createRule(rule: ApprovalRule): void
  deleteRule(id: string): void
  appendEvent(missionId: string, event: PodEvent): void
  listEvents(missionId: string): PodEvent[]
  /**
   * 丢弃满足条件的事件，返回被丢弃条数。
   * 用途：抑制高频重复事件（如任务重试时 task_context 的重复落盘）——
   * 事件流是遥测而非状态真相源，同一语义的旧副本留着只会挤占上限与 payload。
   */
  dropEvents(missionId: string, predicate: (event: PodEvent) => boolean): number
  /** 需要 mission 存在时的便捷写入：追加事件并写盘（单事件一写）。 */
  flush(): void
  close(): void
}

export interface JsonStoreOptions {
  rootDir: string
  /** 可注入时钟（测试确定性）。 */
  clock?: () => number
}

function emptyData(): StoreData {
  return {
    schemaVersion: SCHEMA_VERSION,
    missions: {},
    slots: {},
    tasks: {},
    handoffs: [],
    ledger: [],
    resetEntries: [],
    approvals: {},
    rules: {},
    events: {},
  }
}

function isStoreData(value: unknown): value is StoreData {
  if (typeof value !== 'object' || value === null) return false
  const data = value as Partial<StoreData>
  return (
    typeof data.schemaVersion === 'number' &&
    typeof data.missions === 'object' && data.missions !== null &&
    typeof data.slots === 'object' && data.slots !== null &&
    typeof data.tasks === 'object' && data.tasks !== null &&
    Array.isArray(data.handoffs) &&
    Array.isArray(data.ledger) &&
    typeof data.approvals === 'object' && data.approvals !== null &&
    typeof data.events === 'object' && data.events !== null
  )
}

export class JsonStore implements PodStore {
  /** 存量迁移：旧版任务键为短 id（单 mission 时代），改复合键；幂等（懒执行一次）。 */
  private static migrateTaskKeys(data: StoreData): void {
    for (const [key, task] of Object.entries(data.tasks)) {
      const full = `${task.mission_id}::${task.id}`
      if (key !== full) {
        delete data.tasks[key]
        data.tasks[full] = task
      }
    }
  }
  private taskKeysMigrated = false
  private ensureTaskKeysMigrated(): void {
    if (this.data === undefined) return
    if (!this.taskKeysMigrated) {
      JsonStore.migrateTaskKeys(this.data)
      this.taskKeysMigrated = true
    }
  }
  private data: StoreData | undefined
  private readonly rootDir: string
  private readonly clock: () => number
  private readonly mainPath: string
  private readonly backupPath: string

  constructor(options: JsonStoreOptions) {
    this.rootDir = options.rootDir
    this.clock = options.clock ?? (() => Date.now())
    this.mainPath = join(this.rootDir, 'store.json')
    this.backupPath = join(this.rootDir, 'store.json.bak')
  }

  open(): void {
    mkdirSync(this.rootDir, { recursive: true })
    if (!existsSync(this.mainPath)) {
      // 崩溃窗口恢复：persist() 在「main→bak」与「tmp→main」两次 rename 之间中断时，
      // 磁盘上 main 缺失而 .bak 完好——先回读 .bak 再决定开空库，绝不静默清库。
      const fromBackup = this.loadFile(this.backupPath)
      if (fromBackup !== undefined) {
        this.data = this.applyMigrations(fromBackup)
        this.persist()
        return
      }
      this.data = emptyData()
      this.persist()
      return
    }
    const loaded = this.loadFile(this.mainPath)
    if (loaded !== undefined) {
      this.data = this.applyMigrations(loaded)
      return
    }
    // 主文件损坏：保留证据 → 尝试 .bak 兜底。
    this.preserveCorrupt(this.mainPath)
    const fromBackup = this.loadFile(this.backupPath)
    if (fromBackup === undefined) {
      throw new StoreCorruptError(this.mainPath, existsSync(this.backupPath) ? this.backupPath : undefined)
    }
    this.data = this.applyMigrations(fromBackup)
    this.persist()
  }

  private applyMigrations(data: StoreData): StoreData {
    let current = data
    while (current.schemaVersion < SCHEMA_VERSION) {
      const migrate = MIGRATIONS[current.schemaVersion]
      if (migrate === undefined) {
        throw new StoreCorruptError(
          this.mainPath,
          `no migration from schema v${current.schemaVersion}`,
        )
      }
      current = migrate(current)
    }
    // v2.1 兼容：旧 store 文件无 rules 表 → 补空表（不 bump schema，字段可选）
    if (current.rules === undefined) current.rules = {}
    // P1-1 兼容：旧 store 文件无 resetEntries → 补空数组（delta 账本可选字段）
    if (current.resetEntries === undefined) current.resetEntries = []
    return current
  }

  private loadFile(path: string): StoreData | undefined {
    if (!existsSync(path)) return undefined
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      return isStoreData(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  private preserveCorrupt(path: string): void {
    try {
      renameSync(path, `${path}.corrupt-${this.clock()}`)
    } catch {
      // 证据保留是尽力而为；真正失败会在后续读写暴露。
    }
  }

  /** 原子写：tmp(fsync 尽力而为) → 旧主文件转 .bak → tmp 转正。任何一步崩溃都可从 .bak 恢复。 */
  private persist(): void {
    if (this.data === undefined) throw new Error('store not opened')
    const tmpPath = join(this.rootDir, `store.json.tmp-${process.pid}`)
    writeFileSync(tmpPath, JSON.stringify(this.data))
    // fsync 只是掉电持久性提示：沙箱/部分文件系统返回 EPERM 属于正常情况，
    // 写入正确性与崩溃恢复由 tmp→bak→rename 原子序列保证，故失败仅降级不阻断。
    try {
      const fd = openSync(tmpPath, 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch {
      // best effort: durability hint rejected, atomicity unaffected
    }
    if (existsSync(this.mainPath)) {
      renameSync(this.mainPath, this.backupPath)
    }
    renameSync(tmpPath, this.mainPath)
  }

  private requireData(): StoreData {
    if (this.data === undefined) throw new Error('store not opened: call open() first')
    return this.data
  }

  getSchemaVersion(): number {
    return this.requireData().schemaVersion
  }

  getMission(id: string): Mission | undefined {
    return this.requireData().missions[id]
  }

  listMissions(): Mission[] {
    return Object.values(this.requireData().missions)
  }

  getActiveMission(): Mission | undefined {
    return this.listMissions().find((m) => m.status !== 'done' && m.status !== 'aborted')
  }

  createMission(mission: Mission): void {
    const data = this.requireData()
    if (data.missions[mission.id] !== undefined) throw new DuplicateIdError('mission', mission.id)
    data.missions[mission.id] = { ...mission }
    data.events[mission.id] = []
    this.persist()
  }

  updateMission(id: string, patch: Partial<Mission>): void {
    const data = this.requireData()
    const existing = data.missions[id]
    if (existing === undefined) throw new NotFoundError('mission', id)
    data.missions[id] = { ...existing, ...patch, id, updated_at: this.clock() }
    this.persist()
  }

  deleteMission(id: string): void {
    const data = this.requireData()
    if (data.missions[id] === undefined) throw new NotFoundError('mission', id)
    delete data.missions[id]
    delete data.events[id]
    for (const key of Object.keys(data.slots)) {
      if (data.slots[key]!.mission_id === id) delete data.slots[key]
    }
    for (const key of Object.keys(data.tasks)) {
      if (data.tasks[key]!.mission_id === id) delete data.tasks[key]
    }
    data.handoffs = data.handoffs.filter((h) => h.mission_id !== id)
    data.ledger = data.ledger.filter((e) => e.mission_id !== id)
    data.resetEntries = data.resetEntries.filter((e) => e.mission_id !== id)
    for (const key of Object.keys(data.approvals)) {
      if (data.approvals[key]!.mission_id === id) delete data.approvals[key]
    }
    this.persist()
  }

  getSlot(id: string): AgentSlot | undefined {
    return this.requireData().slots[id]
  }

  listSlots(missionId: string): AgentSlot[] {
    return Object.values(this.requireData().slots).filter((s) => s.mission_id === missionId)
  }

  createSlot(slot: AgentSlot): void {
    const data = this.requireData()
    if (data.slots[slot.id] !== undefined) throw new DuplicateIdError('slot', slot.id)
    data.slots[slot.id] = { ...slot }
    this.persist()
  }

  updateSlot(id: string, patch: Partial<AgentSlot>): void {
    const data = this.requireData()
    const existing = data.slots[id]
    if (existing === undefined) throw new NotFoundError('slot', id)
    data.slots[id] = { ...existing, ...patch, id }
    this.persist()
  }

  getTask(missionIdOrId: string, maybeId?: string): Task | undefined {
    this.ensureTaskKeysMigrated()
    const data = this.requireData()
    if (maybeId !== undefined) return data.tasks[`${missionIdOrId}::${maybeId}`]
    return Object.values(data.tasks).find((t) => t.id === missionIdOrId)
  }

  listTasks(missionId: string): Task[] {
    return Object.values(this.requireData().tasks).filter((t) => t.mission_id === missionId)
  }

  createTask(task: Task): void {
    const data = this.requireData()
    const fullKey = `${task.mission_id}::${task.id}`
    if (data.tasks[fullKey] !== undefined) throw new DuplicateIdError('task', task.id)
    data.tasks[fullKey] = { ...task }
    this.persist()
  }

  updateTask(missionIdOrId: string, idOrPatch: string | Partial<Task>, maybePatch?: Partial<Task>): void {
    this.ensureTaskKeysMigrated()
    const data = this.requireData()
    if (maybePatch !== undefined) {
      const key = `${missionIdOrId}::${idOrPatch}`
      const existing = data.tasks[key]
      if (existing === undefined) throw new NotFoundError('task', String(idOrPatch))
      data.tasks[key] = { ...existing, ...maybePatch, id: existing.id, updated_at: maybePatch.updated_at ?? this.clock() }
      this.persist()
      return
    }
    const patch = idOrPatch as Partial<Task>
    const entry = Object.entries(data.tasks).find(([, t]) => t.id === missionIdOrId)
    if (entry === undefined) throw new NotFoundError('task', missionIdOrId)
    data.tasks[entry[0]] = { ...entry[1], ...patch, id: entry[1].id, updated_at: this.clock() }
    this.persist()
  }

  addHandoff(handoff: Handoff): void {
    this.requireData().handoffs.push({ ...handoff })
    this.persist()
  }

  listHandoffs(missionId: string): Handoff[] {
    return this.requireData().handoffs.filter((h) => h.mission_id === missionId)
  }

  updateHandoff(missionId: string, id: string, patch: Partial<Handoff>): void {
    const data = this.requireData()
    const existing = data.handoffs.find((h) => h.mission_id === missionId && h.id === id)
    if (existing === undefined) throw new NotFoundError('handoff', id)
    const next = { ...existing, ...patch, id, mission_id: missionId }
    data.handoffs[data.handoffs.indexOf(existing)] = next
    this.persist()
  }

  addLedgerEntry(entry: LedgerEntry): void {
    this.requireData().ledger.push({ ...entry })
    this.persist()
  }

  listLedger(missionId: string): LedgerEntry[] {
    return this.requireData().ledger.filter((e) => e.mission_id === missionId)
  }

  listResetEntries(missionId: string, slotId?: string): ResetEntry[] {
    const all = this.requireData().resetEntries
    return all.filter((e) => e.mission_id === missionId && (slotId === undefined || e.slot_id === slotId))
  }

  addResetEntry(entry: ResetEntry): void {
    this.requireData().resetEntries.push({ ...entry })
    this.persist()
  }

  supersedeResetEntry(missionId: string, id: string, ts?: number): void {
    const data = this.requireData()
    const idx = data.resetEntries.findIndex((e) => e.id === id && e.mission_id === missionId)
    if (idx < 0) throw new NotFoundError('reset entry', id)
    data.resetEntries[idx] = { ...data.resetEntries[idx]!, status: 'superseded', superseded_ts: ts ?? this.clock() }
    this.persist()
  }

  getApproval(id: string): ApprovalRequest | undefined {
    return this.requireData().approvals[id]
  }

  listApprovals(missionId: string): ApprovalRequest[] {
    return Object.values(this.requireData().approvals).filter((a) => a.mission_id === missionId)
  }

  createApproval(approval: ApprovalRequest): void {
    const data = this.requireData()
    if (data.approvals[approval.id] !== undefined) throw new DuplicateIdError('approval', approval.id)
    data.approvals[approval.id] = { ...approval }
    this.persist()
  }

  updateApproval(id: string, patch: Partial<ApprovalRequest>): void {
    const data = this.requireData()
    const existing = data.approvals[id]
    if (existing === undefined) throw new NotFoundError('approval', id)
    data.approvals[id] = { ...existing, ...patch, id }
    this.persist()
  }

  getRule(id: string): ApprovalRule | undefined {
    return this.requireData().rules[id]
  }

  listRules(): ApprovalRule[] {
    return Object.values(this.requireData().rules)
  }

  createRule(rule: ApprovalRule): void {
    const data = this.requireData()
    if (data.rules[rule.id] !== undefined) throw new DuplicateIdError('rule', rule.id)
    data.rules[rule.id] = { ...rule }
    this.persist()
  }

  deleteRule(id: string): void {
    const data = this.requireData()
    if (data.rules[id] === undefined) throw new NotFoundError('rule', id)
    delete data.rules[id]
    this.persist()
  }

  appendEvent(missionId: string, event: PodEvent): void {
    const data = this.requireData()
    const events = data.events[missionId] ?? (data.events[missionId] = [])
    events.push({ ...event })
    if (events.length > MAX_EVENTS_PER_MISSION) {
      data.events[missionId] = events.slice(events.length - MAX_EVENTS_PER_MISSION)
    }
    // 事件流是高频遥测而非状态真相源：内存追加 + 上限裁剪，
    // 由 flush()（或任意状态变更触发的 persist）合并落盘，避免逐事件写盘。
  }

  listEvents(missionId: string): PodEvent[] {
    return this.requireData().events[missionId] ?? []
  }

  dropEvents(missionId: string, predicate: (event: PodEvent) => boolean): number {
    const data = this.requireData()
    const events = data.events[missionId] ?? []
    const kept = events.filter((e) => !predicate(e))
    const dropped = events.length - kept.length
    if (dropped > 0) {
      data.events[missionId] = kept
      this.persist()
    }
    return dropped
  }

  flush(): void {
    this.persist()
  }

  close(): void {
    this.data = undefined
  }
}
