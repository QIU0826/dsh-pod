/**
 * 后端版本锁定 —— 方案书 3.9 / CR-08 Berd-A（DoD-15）。
 *
 * launch 写 ~/.dsh/pod/backends.lock.json；preflight --pin 记录实况 / --check 对照锁定：
 *   三态：ok（一致放行）/ mismatch（不一致拒绝 launch）/ override（POD_*_BIN 显式覆盖绕过）。
 * 锁定内容：claude/codex 精确版本 + 二进制路径；MISSION_REPORT 元数据携带 worker_version。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface BackendVersionSnapshot {
  /** key = vendor（claude/codex/dsh）。 */
  [vendor: string]: {
    installed: boolean
    version?: string
    bin: string
  }
}

export interface CheckResult {
  status: 'ok' | 'mismatch' | 'override' | 'unlocked'
  details?: string
}

export interface BackendsLockOptions {
  filePath: string
}

export class BackendsLock {
  private readonly filePath: string

  constructor(options: BackendsLockOptions) {
    this.filePath = options.filePath
  }

  /** --pin：记录实况并落盘（幂等）。 */
  pin(snapshot: BackendVersionSnapshot): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(
      this.filePath,
      JSON.stringify(
        {
          pinned_at: new Date().toISOString(),
          backends: snapshot,
        },
        null,
        2,
      ),
      'utf8',
    )
  }

  /** --check：对照锁定；POD_*_BIN 覆盖任一 vendor → override（绕过）。 */
  check(snapshot: BackendVersionSnapshot, binOverrides: Record<string, string> = {}): CheckResult {
    if (Object.keys(binOverrides).length > 0) {
      return { status: 'override', details: `POD_*_BIN overrides: ${Object.keys(binOverrides).join(', ')}` }
    }
    if (!existsSync(this.filePath)) return { status: 'unlocked', details: 'no lock file (run pin before launch)' }
    let locked: { backends: BackendVersionSnapshot }
    try {
      locked = JSON.parse(readFileSync(this.filePath, 'utf8')) as { backends: BackendVersionSnapshot }
    } catch {
      return { status: 'mismatch', details: 'lock file corrupt' }
    }
    const mismatches: string[] = []
    for (const [vendor, current] of Object.entries(snapshot)) {
      const pinned = locked.backends?.[vendor]
      if (pinned === undefined) {
        if (current.installed) mismatches.push(`${vendor}: not pinned`)
        continue
      }
      if (pinned.installed !== current.installed) {
        mismatches.push(`${vendor}: installed=${pinned.installed} -> ${current.installed}`)
        continue
      }
      if (current.installed && pinned.version !== current.version) {
        mismatches.push(`${vendor}: version ${pinned.version} -> ${current.version}`)
      }
    }
    if (mismatches.length > 0) {
      return { status: 'mismatch', details: mismatches.join('; ') }
    }
    return { status: 'ok', details: 'pinned versions match' }
  }
}
