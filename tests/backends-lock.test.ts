import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BackendsLock,
  type BackendVersionSnapshot,
} from '../src/core/backends-lock.js'

/**
 * Berd-A / DoD-15：后端版本锁定（backends.lock.json）。
 * 三态：锁定一致放行 / 不一致拒绝 / POD_*_BIN override 绕过。
 */

let root: string

function makeLock() {
  root = mkdtempSync(join(tmpdir(), 'pod-lock-'))
  return new BackendsLock({ filePath: join(root, 'backends.lock.json') })
}

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
})

const snapshot: BackendVersionSnapshot = {
  claude: { installed: true, version: '2.1.129', bin: 'claude' },
  codex: { installed: true, version: '0.148.0-alpha.9', bin: 'codex' },
}

describe('BackendsLock（pin/check 三态，Berd-A / DoD-15）', () => {
  it('pin 记录实况并落盘；check 对照锁定一致 → 放行', () => {
    const lock = makeLock()
    lock.pin(snapshot)
    const check = lock.check(snapshot)
    expect(check.status).toBe('ok')
  })

  it('check 版本不一致 → 拒绝（拒绝 launch）', () => {
    const lock = makeLock()
    lock.pin(snapshot)
    const check = lock.check({ ...snapshot, claude: { installed: true, version: '2.1.130', bin: 'claude' } })
    expect(check.status).toBe('mismatch')
    expect(check.details).toContain('claude')
  })

  it('check 后装新后端（锁定时未装）→ 拒绝（新接口未锁定）', () => {
    const lock = makeLock()
    lock.pin({ ...snapshot, codex: { installed: false, version: undefined, bin: 'codex' } })
    const check = lock.check(snapshot)
    expect(check.status).toBe('mismatch')
  })

  it('POD_*_BIN 覆盖 → 绕过锁定（override 三态）', () => {
    const lock = makeLock()
    lock.pin(snapshot)
    const check = lock.check(snapshot, { claude: 'D:\\custom\\claude.cmd' })
    expect(check.status).toBe('override')
  })

  it('pin 幂等（重复 pin 不炸）且跨实例可读', () => {
    const lock = makeLock()
    lock.pin(snapshot)
    lock.pin(snapshot)
    const reloaded = new BackendsLock({ filePath: join(root, 'backends.lock.json') })
    expect(reloaded.check(snapshot).status).toBe('ok')
  })

  it('无 lock 文件时 check → 未锁定（首次运行，launch 前应 pin）', () => {
    const lock = makeLock()
    const check = lock.check(snapshot)
    expect(check.status).toBe('unlocked')
  })
})
