import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWrite, sweepStaleTmp, pidAlive, tmpPathFor } from '../src/core/atomic-write.js'
import { JsonStore } from '../src/core/store.js'
import { MemoryStore } from '../src/core/memory.js'

// 与 memory.test.ts 同源纪律：临时目录建在系统 tmp 并统一登记，afterAll 兜底清理。
const made: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pod-atomic-'))
  made.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/** 取一个确定已退出的 pid（spawnSync 返回时子进程已结束）。 */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
  return child.pid
}

describe('atomicWrite：原子写内核（tmp→bak→rename）', () => {
  it('正常路径：内容落到主文件，旧主文件转 .bak', () => {
    const dir = tempDir()
    const main = join(dir, 'store.json')
    const bak = join(dir, 'store.json.bak')
    writeFileSync(main, '{"v":1}', 'utf8')
    atomicWrite(main, '{"v":2}', { backupPath: bak })
    expect(readFileSync(main, 'utf8')).toBe('{"v":2}')
    expect(readFileSync(bak, 'utf8')).toBe('{"v":1}')
    // 转正成功 → 无 tmp 残骸
    expect(existsSync(tmpPathFor(main))).toBe(false)
  })

  it('rename tmp→main 失败（Windows EPERM 实测路径）→ 清掉 tmp 残骸并原样重抛', () => {
    const dir = tempDir()
    const main = join(dir, 'store.json')
    // 主文件路径是目录 → rename(file → dir) 在 Windows 抛 EPERM（实测可复现）
    mkdirSync(main, { recursive: true })
    const tmp = tmpPathFor(main)
    expect(() => atomicWrite(main, '{"v":2}')).toThrow()
    // 核心断言：旧实现会把 tmp 永久留在数据目录里
    expect(existsSync(tmp)).toBe(false)
  })

  it('rename main→bak 失败 → 同样清掉 tmp 残骸，主文件保持旧值', () => {
    const dir = tempDir()
    const main = join(dir, 'store.json')
    const bak = join(dir, 'store.json.bak')
    writeFileSync(main, '{"v":1}', 'utf8')
    // .bak 是已存在的目录 → rename(file → dir) 失败
    mkdirSync(bak, { recursive: true })
    expect(() => atomicWrite(main, '{"v":2}', { backupPath: bak })).toThrow()
    expect(existsSync(tmpPathFor(main))).toBe(false)
    expect(readFileSync(main, 'utf8')).toBe('{"v":1}')
  })

  it('错误不被吞掉：落盘失败必须上抛（静默成功比 tmp 残留危险得多）', () => {
    const dir = tempDir()
    const main = join(dir, 'store.json')
    mkdirSync(main, { recursive: true })
    let threw = false
    try {
      atomicWrite(main, '{}')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

describe('sweepStaleTmp / pidAlive：崩溃进程 tmp 残骸清理', () => {
  it('pid 已死的 tmp 被清掉', () => {
    const dir = tempDir()
    const stale = join(dir, `store.json.tmp-${deadPid()}`)
    writeFileSync(stale, '{}', 'utf8')
    expect(sweepStaleTmp(dir, 'store.json.tmp-')).toBe(1)
    expect(existsSync(stale)).toBe(false)
  })

  it('活进程（含自己）的 tmp 一律保留——可能正处于「写完未转正」窗口', () => {
    const dir = tempDir()
    const live = join(dir, `store.json.tmp-${process.pid}`)
    writeFileSync(live, '{}', 'utf8')
    expect(sweepStaleTmp(dir, 'store.json.tmp-')).toBe(0)
    expect(existsSync(live)).toBe(true)
  })

  it('前缀不匹配的文件不动（.bak / 主文件 / 无关文件都安全）', () => {
    const dir = tempDir()
    const keep = [join(dir, 'store.json'), join(dir, 'store.json.bak'), join(dir, 'pod.db')]
    for (const p of keep) writeFileSync(p, '{}', 'utf8')
    expect(sweepStaleTmp(dir, 'store.json.tmp-')).toBe(0)
    for (const p of keep) expect(existsSync(p)).toBe(true)
  })

  it('目录不存在时安全返回 0（不抛）', () => {
    expect(sweepStaleTmp(join(tempDir(), 'no-such-dir'), 'store.json.tmp-')).toBe(0)
  })

  it('pidAlive：自己存活、已退出子进程不存活、非法 pid 按不存活处理', () => {
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(deadPid())).toBe(false)
    expect(pidAlive(0)).toBe(false)
    expect(pidAlive(-1)).toBe(false)
    expect(pidAlive(1.5)).toBe(false)
  })
})

describe('接入点：JsonStore / MemoryStore open() 扫残骸', () => {
  // 注：「活进程 tmp 要保留」的断言放在 sweepStaleTmp 单测里（用 process.pid + 隔离目录）。
  // 这里不能放——JsonStore.open() 随后的 persist() 用的正是 `store.json.tmp-<process.pid>`，
  // 同名文件会被正常消费转正（那是正确行为，不是残留）。
  it('JsonStore.open() 清掉崩溃残留的 store.json.tmp-<pid>，且开库本身不受影响', () => {
    const dir = tempDir()
    const stale = join(dir, `store.json.tmp-${deadPid()}`)
    writeFileSync(stale, '{}', 'utf8')
    const store = new JsonStore({ rootDir: dir, clock: () => 1_700_000_000_000 })
    store.open()
    expect(existsSync(stale)).toBe(false)
    // 扫残骸不能破坏正常开库：空目录 → 建空库并落盘
    expect(store.listMissions()).toEqual([])
    expect(existsSync(join(dir, 'store.json'))).toBe(true)
  })

  it('MemoryStore.open() 清掉崩溃残留的 memory.json.tmp-<pid>（真实 tmpPathFor 前缀）', () => {
    const dir = tempDir()
    // 前缀必须是 tmpPathFor(memory.json) 的产物 `memory.json.tmp-`——旧用例跟着实现里
    // 的错误字面量 '.memory.tmp-' 一起写错，清扫是死代码（2026-09-05 修正后同步用例）。
    const stale = join(dir, `memory.json.tmp-${deadPid()}`)
    writeFileSync(stale, '{}', 'utf8')
    new MemoryStore({ filePath: join(dir, 'memory.json'), clock: () => 1_700_000_000_000 }).open()
    expect(existsSync(stale)).toBe(false)
  })
})
