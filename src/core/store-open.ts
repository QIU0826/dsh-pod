/**
 * 存储/记忆工厂（方案书 O12/R12）：SQLite 默认，JSON 回退，存量迁移。
 * 独立文件避免 store.ts <-> sqlite-store.ts 循环依赖。
 */

import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { JsonStore, type PodStore } from './store.js'
import { SqliteStore } from './sqlite-store.js'
import { JsonMemoryPersistence, MemoryStore, SqliteMemoryPersistence, type MemoryPersistence } from './memory.js'

/** Store 引擎（方案书 O12：SQLite 主，JSON 回退）。 */
export type StoreEngine = 'sqlite' | 'json'

export interface OpenPodDataOptions {
  rootDir: string
  /** 默认 'sqlite'；显式 'json' 强制 JSON 回退。 */
  engine?: StoreEngine
  clock?: () => number
  /** memory.json 迁移源（默认 rootDir/memory.json）。 */
  memoryMigrateFrom?: string
}

export interface OpenPodDataResult {
  store: PodStore
  memory: MemoryStore
  engine: StoreEngine
  db?: Database.Database
  rootDir: string
  closed?: boolean
}

/**
 * 打开 Pod 数据面（store + memory 共享同一 pod.db 单文件，SQLite 引擎时）。
 * SQLite 打开失败 → 回退 JSON（R12）。存量 store.json / memory.json 迁移见各实现。
 */
export function openPodData(options: OpenPodDataOptions): OpenPodDataResult {
  const engine = options.engine ?? 'sqlite'
  const rootDir = options.rootDir
  const clock = options.clock
  if (engine === 'json') {
    const store = new JsonStore({ rootDir, clock })
    store.open()
    const memory = openMemoryJson(rootDir, clock, options.memoryMigrateFrom)
    return { store, memory, engine: 'json', rootDir }
  }
  let sqlite: SqliteStore | undefined
  try {
    sqlite = new SqliteStore({ rootDir, clock })
    sqlite.open()
    const db = sqlite.getDb()
    // SQLite 引擎：memory 与 store 共享同一 pod.db（方案书 251 行单文件）；
    // 先迁存量 memory.json 再 open（保证 memory 首次 load 即含已迁移数据）
    migrateMemoryJsonToSqlite(rootDir, db, options.memoryMigrateFrom)
    const memory = new MemoryStore({ db, clock })
    memory.open()
    return { store: sqlite, memory, engine: 'sqlite', db, rootDir }
  } catch (error) {
    // R12 回退：native 不可用 → JSON，绝不静默开空库；先释放半开的 SQLite 句柄
    console.error('[dsh-pod] sqlite open failed, falling back to JSON:', error)
    if (sqlite !== undefined) { try { sqlite.close() } catch { /* best effort */ } }
    const store = new JsonStore({ rootDir, clock })
    store.open()
    const memory = openMemoryJson(rootDir, clock, options.memoryMigrateFrom)
    return { store, memory, engine: 'json', rootDir }
  }
}

function openMemoryJson(rootDir: string, clock: (() => number) | undefined, migrateFrom: string | undefined): MemoryStore {
  const filePath = migrateFrom ?? join(rootDir, 'memory.json')
  const memory = new MemoryStore({ filePath, clock })
  memory.open()
  return memory
}

/**
 * 存量 memory.json → pod.db 迁移（非破坏，保留原 record id + history）：
 * 直接 JsonMemoryPersistence.load() → SqliteMemoryPersistence.save()，
 * 旧文件转 .migrated（绝不删除用户数据）；pod.db 已有记忆时不重复导入。
 */
export function migrateMemoryJsonToSqlite(rootDir: string, db: Database.Database, migrateFrom?: string): void {
  const jsonPath = migrateFrom ?? join(rootDir, 'memory.json')
  if (!existsSync(jsonPath)) return
  const sqlitePersistence: MemoryPersistence = new SqliteMemoryPersistence(db)
  sqlitePersistence.open() // 确保 memory 表存在（正常路径由 MemoryStore.open 建，迁移先于它）
  const existing = sqlitePersistence.load()
  if (existing !== undefined && (Object.keys(existing.records).length > 0 || existing.edges.length > 0)) {
    // pod.db 里已有记忆 → 不重复导入（避免覆盖），保留 memory.json 不动
    return
  }
  const jsonPersistence: MemoryPersistence = new JsonMemoryPersistence({ filePath: jsonPath })
  jsonPersistence.open()
  const data = jsonPersistence.load()
  if (data === undefined) return
  sqlitePersistence.save(data)
  renameSync(jsonPath, join(rootDir, 'memory.json.migrated'))
}