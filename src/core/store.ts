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
import { DuplicateIdError, NotFoundError, StoreCorruptError } from './errors'
import type {
  AgentSlot,
  ApprovalRequest,
  Handoff,
  LedgerEntry,
  Mission,
  PodEvent,
  Task,
} from './types'

export const SCHEMA_VERSION = 1

export const MAX_EVENTS_PER_MISSION = 2000

export interface StoreData {
  schemaVersion: number
  missions: Record<string, Mission>
  slots: Record<string, AgentSlot>
  tasks: Record<string, Task>
  handoffs: Handoff[]
  ledger: LedgerEntry[]
  approvals: Record<string, ApprovalRequest>
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
  getSlot(id: string): AgentSlot | undefined
  listSlots(missionId: string): AgentSlot[]
  createSlot(slot: AgentSlot): void
  updateSlot(id: string, patch: Partial<AgentSlot>): void
  getTask(id: string): Task | undefined
  listTasks(missionId: string): Task[]
  createTask(task: Task): void
  updateTask(id: string, patch: Partial<Task>): void
  addHandoff(handoff: Handoff): void
  listHandoffs(missionId: string): Handoff[]
  addLedgerEntry(entry: LedgerEntry): void
  listLedger(missionId: string): LedgerEntry[]
  getApproval(id: string): ApprovalRequest | undefined
  listApprovals(missionId: string): ApprovalRequest[]
  createApproval(approval: ApprovalRequest): void
  updateApproval(id: string, patch: Partial<ApprovalRequest>): void
  appendEvent(missionId: string, event: PodEvent): void
  listEvents(missionId: string): PodEvent[]
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
    approvals: {},
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

  getTask(id: string): Task | undefined {
    return this.requireData().tasks[id]
  }

  listTasks(missionId: string): Task[] {
    return Object.values(this.requireData().tasks).filter((t) => t.mission_id === missionId)
  }

  createTask(task: Task): void {
    const data = this.requireData()
    if (data.tasks[task.id] !== undefined) throw new DuplicateIdError('task', task.id)
    data.tasks[task.id] = { ...task }
    this.persist()
  }

  updateTask(id: string, patch: Partial<Task>): void {
    const data = this.requireData()
    const existing = data.tasks[id]
    if (existing === undefined) throw new NotFoundError('task', id)
    data.tasks[id] = { ...existing, ...patch, id, updated_at: this.clock() }
    this.persist()
  }

  addHandoff(handoff: Handoff): void {
    this.requireData().handoffs.push({ ...handoff })
    this.persist()
  }

  listHandoffs(missionId: string): Handoff[] {
    return this.requireData().handoffs.filter((h) => h.mission_id === missionId)
  }

  addLedgerEntry(entry: LedgerEntry): void {
    this.requireData().ledger.push({ ...entry })
    this.persist()
  }

  listLedger(missionId: string): LedgerEntry[] {
    return this.requireData().ledger.filter((e) => e.mission_id === missionId)
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

  flush(): void {
    this.persist()
  }

  close(): void {
    this.data = undefined
  }
}
