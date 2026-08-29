import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browseDirectories } from '../src/core/fs-browse.js'

function makeSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'pod-fs-browse-'))
}

describe('browseDirectories（设置页目录点选器数据源）', () => {
  it('列出子目录并过滤：文件与 $ 系统目录不出现；点开头目录保留（.zcode 类工作区可达）', () => {
    const box = makeSandbox()
    try {
      for (const name of ['beta', 'alpha', '.hidden', '$RECYCLE']) mkdirSync(join(box, name))
      writeFileSync(join(box, 'file.txt'), 'x')
      const result = browseDirectories(box)
      expect(result.path).toBe(box)
      expect(result.entries).toEqual(['.hidden', 'alpha', 'beta'])
      expect(result.parent).toBe(join(box, '..'))
    } finally {
      rmSync(box, { recursive: true, force: true })
    }
  })

  it('根级（空路径）：Windows 给盘符列表，POSIX 给根目录', () => {
    const result = browseDirectories('')
    expect(result.home.length).toBeGreaterThan(0)
    if (process.platform === 'win32') {
      expect(result.roots).not.toBeNull()
      if (existsSync('C:\\')) expect(result.roots).toContain('C:\\')
      expect(result.entries).toEqual([])
    } else {
      expect(result.path).toBe('/')
      expect(result.roots).toBeNull()
      expect(Array.isArray(result.entries)).toBe(true)
    }
  })

  it('盘根的上一级是盘符列表（parent 为空串），普通目录的上一级是父目录', () => {
    if (process.platform === 'win32') {
      if (!existsSync('C:\\')) return
      expect(browseDirectories('C:\\').parent).toBe('')
    } else {
      expect(browseDirectories('/').parent).toBeNull()
    }
    const box = makeSandbox()
    try {
      const sub = join(box, 'sub')
      mkdirSync(sub)
      expect(browseDirectories(sub).parent).toBe(box)
    } finally {
      rmSync(box, { recursive: true, force: true })
    }
  })

  it('拒绝：相对路径 / 不存在 / 文件', () => {
    expect(() => browseDirectories('relative/path')).toThrow()
    expect(() => browseDirectories(join(tmpdir(), 'pod-no-such-dir-xyz'))).toThrow()
    const box = makeSandbox()
    try {
      const file = join(box, 'plain.txt')
      writeFileSync(file, 'x')
      expect(() => browseDirectories(file)).toThrow(/not a directory/)
    } finally {
      rmSync(box, { recursive: true, force: true })
    }
  })

  it('条目数上限 300（超长列表截断，防 UI 爆炸）', () => {
    const box = makeSandbox()
    try {
      for (let i = 0; i < 305; i += 1) mkdirSync(join(box, `d${String(i).padStart(3, '0')}`))
      expect(browseDirectories(box).entries.length).toBe(300)
    } finally {
      rmSync(box, { recursive: true, force: true })
    }
  })
})
