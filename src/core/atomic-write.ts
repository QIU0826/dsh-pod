/**
 * 原子写共享内核（store.json / memory.json 同源，此前两处各写一份且都有同一缺陷）。
 *
 * 序列：tmp(fsync 尽力而为) → 旧主文件转 .bak → tmp 转正。
 *
 * ## 为什么要抽出来
 *
 * Windows 上 `renameSync` 在目标被占用（杀软扫描刚写完的文件、句柄未释放）时会抛
 * **EPERM**——实测可稳定复现。旧实现一旦在 rename 阶段抛错，`xxx.tmp-<pid>` 就永久
 * 留在数据目录里：每次失败留一个，只增不减。
 *
 * ## 失败时的处置原则
 *
 * - **tmp 必须清掉**：`main→bak` 已成功但 `tmp→main` 失败时，主文件缺失、.bak 完好，
 *   `open()` 的崩溃窗口恢复本就能从 .bak 重建——删掉 tmp 不会比留着多丢数据
 *   （留着也是被忽略的），但能杜绝残骸。其余失败分支同理（主文件仍是旧值）。
 * - **错误必须原样重抛**：落盘失败静默吞掉，会让上层以为写成功了。这比 tmp 残留
 *   危险得多——残留只是脏，假装成功是数据丢失。
 */

import { basename, dirname, join } from 'node:path'
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'

export interface AtomicWriteOptions {
  /** 提供则先把旧主文件转存到这里（.bak），再从 tmp 转正。 */
  backupPath?: string
  /** 是否尽力 fsync（掉电持久性提示；Windows 上对只读 fd 常返回 EPERM，失败仅降级）。 */
  fsync?: boolean
}

/** 以 pid 命名 tmp，避免多进程互相踩；也是崩溃后识别归属的依据。 */
export function tmpPathFor(filePath: string): string {
  return join(dirname(filePath), `${basename(filePath)}.tmp-${process.pid}`)
}

function fsyncBestEffort(path: string): void {
  try {
    const fd = openSync(path, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // best effort: durability hint rejected, atomicity unaffected
  }
}

/**
 * 原子写：把 content 落到 filePath，失败时清理 tmp 残骸后重抛。
 */
export function atomicWrite(filePath: string, content: string, options: AtomicWriteOptions = {}): void {
  const tmpPath = tmpPathFor(filePath)
  writeFileSync(tmpPath, content, 'utf8')
  try {
    if (options.fsync === true) fsyncBestEffort(tmpPath)
    if (options.backupPath !== undefined && existsSync(filePath)) {
      renameSync(filePath, options.backupPath)
    }
    renameSync(tmpPath, filePath)
  } catch (error) {
    // 清掉残骸再重抛：tmp 留着不会被任何人读到，只会堆积
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      // 清理本身也是尽力而为，不影响原始错误的抛出
    }
    throw error
  }
}

/** pid 存活探测（信号 0 不发信号，仅查存在性）。pid 非法一律按「已死」处理。 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 清理崩溃进程遗留的 tmp 残骸（open() 时调用一次）。
 *
 * 只删 **pid 已死** 的 tmp——活进程的 tmp 可能正处于「写完未转正」的窗口，删了会
 * 破坏它的原子写。pid 复用的理论风险下，最坏结果只是「这次没清掉」（维持现状），
 * 不会误删在途数据：失败方向是安全的。
 *
 * @returns 实际清理掉的文件数
 */
export function sweepStaleTmp(dir: string, prefix: string): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const pid = Number.parseInt(name.slice(prefix.length), 10)
    if (pidAlive(pid)) continue
    try {
      rmSync(join(dir, name), { force: true })
      removed += 1
    } catch {
      // 单文件清理失败不影响其余，也不阻断启动
    }
  }
  return removed
}
