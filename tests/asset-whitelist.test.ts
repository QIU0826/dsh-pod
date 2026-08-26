import { describe, expect, it } from 'vitest'
import { resolveAsset, contentTypeFor, type AssetFs } from '../src/core/asset-whitelist.js'
import { join } from 'node:path'

const ROOT = 'C:\\repo\\.pod-worktrees\\S-1'

interface TestFs extends AssetFs {
  __files: Set<string>
  __symlinks: Set<string>
}

/** 注入式 fs：isSymbolicLink / realpath / exists 全可编程（离线单测，DoD-17 穿越专项）。 */
function makeFs(over: Partial<AssetFs> = {}): TestFs {
  const files = new Set<string>()
  const symlinks = new Set<string>()
  return {
    isSymbolicLink: (abs: string) => symlinks.has(abs),
    realpath: (abs: string) => abs, // 默认无链接：realpath = 自身
    exists: (abs: string) => files.has(abs) || symlinks.has(abs),
    ...over,
    // 便于测试直接登记文件/链接
    __files: files,
    __symlinks: symlinks,
  }
}

describe('resolveAsset（DoD-17 / AS-4：Canvas 资产白名单穿越防护）', () => {
  it('白名单根内相对路径 → 放行并返回绝对路径', () => {
    const fs = makeFs()
    fs.__files.add(join(ROOT, 'out', 'task-T-1.diff'))
    const result = resolveAsset([ROOT], 'out/task-T-1.diff', fs)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.abs).toBe(join(ROOT, 'out', 'task-T-1.diff'))
  })

  it('拒绝 .. 穿越', () => {
    const fs = makeFs()
    const result = resolveAsset([ROOT], '../secret.txt', fs)
    expect(result.ok).toBe(false)
  })

  it('拒绝绝对路径（盘符）', () => {
    const fs = makeFs()
    expect(resolveAsset([ROOT], 'C:\\Windows\\win.ini', fs).ok).toBe(false)
    expect(resolveAsset([ROOT], 'D:/other/file.txt', fs).ok).toBe(false)
  })

  it('拒绝 / 与 \\\\ 前缀（绝对/UNC）', () => {
    const fs = makeFs()
    expect(resolveAsset([ROOT], '/etc/passwd', fs).ok).toBe(false)
    expect(resolveAsset([ROOT], '\\\\server\\share\\x', fs).ok).toBe(false)
    expect(resolveAsset([ROOT], '\\\\?\\C:\\Windows', fs).ok).toBe(false)
  })

  it('拒绝空路径', () => {
    const fs = makeFs()
    expect(resolveAsset([ROOT], '', fs).ok).toBe(false)
  })

  it('拒绝符号链接（Windows junction / symlink 专项）', () => {
    const fs = makeFs()
    fs.__symlinks.add(join(ROOT, 'link.log'))
    const result = resolveAsset([ROOT], 'link.log', fs)
    expect(result.ok).toBe(false)
  })

  it('拒绝 realpath 逃逸（链接/拼接绕过解析层防线）', () => {
    const fs = makeFs()
    fs.__files.add(join(ROOT, 'evil.txt'))
    // 文件真实路径逃逸到根外 → realpath 包含性校验拒绝
    fs.realpath = (abs: string) => (abs.endsWith('evil.txt') ? 'C:\\outside\\evil.txt' : abs)
    const result = resolveAsset([ROOT], 'evil.txt', fs)
    expect(result.ok).toBe(false)
  })

  it('多根：第一个不命中则尝试下一个根', () => {
    const root2 = 'C:\\repo2'
    const fs = makeFs()
    fs.__files.add(join(root2, 'readme.md'))
    const result = resolveAsset([ROOT, root2], 'readme.md', fs)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.abs).toBe(join(root2, 'readme.md'))
  })

  it('全部根都不命中 → 403 语义（outside whitelist roots）', () => {
    const fs = makeFs()
    const result = resolveAsset([ROOT], 'nope.txt', fs)
    expect(result.ok).toBe(false)
  })
})

describe('contentTypeFor', () => {
  it('按扩展名给安全 content-type 子集', () => {
    expect(contentTypeFor('a.json')).toContain('application/json')
    expect(contentTypeFor('a.md')).toContain('text/markdown')
    expect(contentTypeFor('a.diff')).toContain('text/plain')
    expect(contentTypeFor('a.ts')).toContain('text/plain')
    expect(contentTypeFor('a.bin')).toBe('application/octet-stream')
  })
})
