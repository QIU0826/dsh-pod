/**
 * 进程注册表 —— 方案书 3.2 节进程治理。
 * pid ↔ slot ↔ task 唯一映射：单员工 kill 不影响 mission 其他成员；
 * DSH 重启时孤儿进程扫描清理（孤儿判定见 3.2 节）。
 */

import { PodError } from '../core/errors.js'

export interface RegistryEntry {
  pid: number
  slot_id: string
  task_id: string
  started_at: number
}

export type ProcessKiller = (pid: number) => Promise<void>

export interface ProcessRegistryOptions {
  clock?: () => number
}

export class ProcessRegistry {
  private readonly entries = new Map<number, RegistryEntry>()
  private readonly killer: ProcessKiller
  private readonly clock: () => number

  constructor(killer: ProcessKiller, options: ProcessRegistryOptions = {}) {
    this.killer = killer
    this.clock = options.clock ?? (() => Date.now())
  }

  register(entry: Omit<RegistryEntry, 'started_at'> & { started_at?: number }): void {
    if (this.entries.has(entry.pid)) {
      throw new PodError(
        `pid ${entry.pid} already registered`,
        'DUPLICATE_PID',
        { existing: this.entries.get(entry.pid) },
      )
    }
    this.entries.set(entry.pid, { ...entry, started_at: entry.started_at ?? this.clock() })
  }

  unregister(pid: number): void {
    this.entries.delete(pid)
  }

  list(): RegistryEntry[] {
    return [...this.entries.values()]
  }

  findBySlot(slotId: string): RegistryEntry[] {
    return this.list().filter((e) => e.slot_id === slotId)
  }

  findByTask(taskId: string): RegistryEntry[] {
    return this.list().filter((e) => e.task_id === taskId)
  }

  /** 单员工 kill：干净杀掉该槽位全部进程并清册。 */
  async killSlot(slotId: string): Promise<number> {
    const targets = this.findBySlot(slotId)
    for (const entry of targets) {
      await this.killer(entry.pid)
      this.entries.delete(entry.pid)
    }
    return targets.length
  }

  /** 全 mission 停止（全局终止操作）。 */
  async killAll(): Promise<number> {
    const targets = this.list()
    for (const entry of targets) {
      await this.killer(entry.pid)
      this.entries.delete(entry.pid)
    }
    return targets.length
  }

  /**
   * DSH 重启孤儿扫描（R7）：registry 不跨进程持久化，
   * 重启后本表为空，插件层用 preflight 探测到的 worker 进程特征另行清理。
   * 本方法提供「已知 pid 是否仍存活」的注入点。
   */
  contains(pid: number): boolean {
    return this.entries.has(pid)
  }
}
