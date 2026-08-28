/**
 * PodRuntime 装配 —— 独立模式（CR-38 P0）与 DSH 插件形态共用的纯 core 装配。
 * 零 dsh-* 依赖：store/approvals/ledger 全部来自 core，磁盘 ~/.dsh/pod 为唯一事实源。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ApprovalEngine } from './approvals.js'
import { Ledger } from './ledger.js'
import { openPodData, type StoreEngine } from './store-open.js'
import type { PodStore } from './store.js'
import type { MemoryStore } from './memory.js'

/** Pod 版本号（ping 路由与独立 server 共用）。 */
export const POD_VERSION = '0.3.0-alpha.1'

export interface PodRuntime {
  store: PodStore
  memory: MemoryStore
  approvals: ApprovalEngine
  ledger: Ledger
  dataDir: string
  engine: StoreEngine
  /** 释放磁盘句柄（SQLite 连接/JSON 引用）。插件卸载与测试清理必须调用。 */
  close(): void
}

/**
 * 构造运行时（磁盘唯一事实源）。SQLite 默认（pod.db），better-sqlite3 不可用回退 JSON；
 * store 损坏时显式抛出，调用方降级并留证。
 */
export function createPodRuntime(dataDir?: string, engine?: StoreEngine): PodRuntime {
  const root = dataDir && dataDir.length > 0 ? dataDir : join(homedir(), '.dsh', 'pod')
  const opened = openPodData({ rootDir: root, engine })
  return {
    store: opened.store,
    memory: opened.memory,
    approvals: new ApprovalEngine(opened.store),
    ledger: new Ledger(opened.store),
    dataDir: root,
    engine: opened.engine,
    close: () => {
      opened.memory.close()
      opened.store.close()
    },
  }
}
