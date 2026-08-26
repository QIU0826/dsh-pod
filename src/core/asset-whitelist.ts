/**
 * Canvas 资产读取白名单（Berd-C / DoD-17 / 迁移计划 AS-4）。
 *
 * 资产端点只允许读 mission worktree 白名单根集合内的文件——复用 makePathWhitelist
 * （语法层拒绝 .. / 绝对路径 / 盘符），再叠加两层纵深防御：
 *   - 符号链接拒绝（lstat.isSymbolicLink → 403，Windows \\?\ 前缀与 junction 专项）；
 *   - realpath 包含性（解析后真实路径必须仍在根真实路径之内，防拼接绕过/链接逃逸）。
 * 全部为纯逻辑 + 注入式 fs，可离线单测（穿越单测：.. / 绝对路径 / 盘符 / 符号链接）。
 */

import { join, normalize, sep } from 'node:path'
import { makePathWhitelist } from './verifier.js'

export interface AssetFs {
  /** 返回是否符号链接（lstat，不跟随）。 */
  isSymbolicLink(abs: string): boolean
  /** 返回真实路径（跟随链接/解析 ..）。 */
  realpath(abs: string): string
  exists(abs: string): boolean
}

export type AssetResolution = { ok: true; abs: string } | { ok: false; reason: string }

/** Windows 盘符（C:\…）与 UNC（\\?\…）绝对前缀检测（含 \\ 前缀——UNC 也是一种绝对路径）。 */
function isAbsoluteLike(p: string): boolean {
  return /^[a-zA-Z]:/.test(p) || p.startsWith('/') || p.startsWith('\\')
}

/**
 * 白名单解析：遍历 roots，找到第一个通过全部校验的命中。
 * 返回绝对路径供服务层读取；任何不通过 → 403 语义。
 */
export function resolveAsset(roots: string[], relPath: string, fs: AssetFs): AssetResolution {
  if (relPath.length === 0) return { ok: false, reason: 'empty path' }
  if (isAbsoluteLike(relPath)) return { ok: false, reason: 'absolute path rejected' }
  for (const root of roots) {
    const allowed = makePathWhitelist(root)(relPath)
    if (!allowed) continue
    const abs = join(root, relPath)
    if (!fs.exists(abs)) continue
    if (fs.isSymbolicLink(abs)) return { ok: false, reason: `symlink rejected: ${relPath}` }
    const rootReal = normalize(fs.realpath(root))
    const absReal = normalize(fs.realpath(abs))
    if (absReal !== rootReal && !absReal.startsWith(rootReal + sep)) {
      return { ok: false, reason: `realpath escape rejected: ${relPath}` }
    }
    return { ok: true, abs }
  }
  return { ok: false, reason: 'path outside whitelist roots' }
}

/** 按扩展名给最小 content-type（文本资产，安全子集；不做任意二进制 MIME 猜测）。 */
export function contentTypeFor(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8'
  if (lower.endsWith('.md')) return 'text/markdown; charset=utf-8'
  if (lower.endsWith('.diff') || lower.endsWith('.patch') || lower.endsWith('.txt') || lower.endsWith('.log')) {
    return 'text/plain; charset=utf-8'
  }
  if (lower.endsWith('.ts') || lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return 'text/plain; charset=utf-8'
  }
  return 'application/octet-stream'
}
