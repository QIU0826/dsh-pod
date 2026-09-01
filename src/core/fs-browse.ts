/**
 * 本地目录浏览（P2 设置页「选择仓库路径」的数据源）——只列目录名，只读。
 *
 * 浏览器拿不到本地绝对路径（File System Access API 只给句柄），但控制台服务端
 * 与用户同机：loopback-only 的目录浏览端点是正解。安全边界：
 *   - 只返回目录名（不读文件内容、不返回文件）；
 *   - 隐藏 $ 系统目录；符号链接目录排除（防 junction 逃逸与环）；
 *   - 条目数上限（防超长列表）；路径必须是已存在的目录。
 */
import { readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

const MAX_ENTRIES = 300

export interface BrowseResult {
  /** 当前目录绝对路径（根级为 ''）。 */
  path: string
  /** 上一级目录（根级为 null；Windows 盘根的上一级是 '' 即盘符列表）。 */
  parent: string | null
  /** 子目录名（已排序、过滤、截断）。 */
  entries: string[]
  /** 根级（path=''）时的可选入口：Windows 盘符列表 / POSIX 为 null。 */
  roots: string[] | null
  /** 用户主目录（前端「主目录」快捷入口）。 */
  home: string
  /** 过滤后、截断前的子目录总数（与 entries.length 不等即表示被截断）。 */
  total: number
  /** entries 是否因超过 MAX_ENTRIES 被截断——静默截断会让用户以为看到的是全部。 */
  truncated: boolean
}

function listDrives(): string[] {
  const drives: string[] = []
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`
    if (existsSync(drive)) drives.push(drive)
  }
  return drives
}

/** 列目录（只读、只目录）。rawPath 为空 = 根级（Windows 盘符 / POSIX 根）。 */
export function browseDirectories(rawPath: string): BrowseResult {
  const home = homedir()
  if (rawPath.trim().length === 0) {
    if (process.platform === 'win32') {
      return { path: '', parent: null, entries: [], roots: listDrives(), home, total: 0, truncated: false }
    }
    const rootDirs = childDirs('/')
    return { path: '/', parent: null, entries: rootDirs.entries, roots: null, home, total: rootDirs.total, truncated: rootDirs.truncated }
  }
  const path = rawPath.trim()
  if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`not an absolute directory path: ${path}`)
  }
  if (!isAbsolute(path)) throw new Error(`not an absolute directory path: ${path}`)
  if (!existsSync(path)) throw new Error(`path not found: ${path}`)
  if (!statSync(path).isDirectory()) throw new Error(`not a directory: ${path}`)
  const parent = dirname(path)
  const dirs = childDirs(path)
  return {
    path,
    // Windows 盘根（C:\）的 dirname 还是自身 → 上一层是盘符列表（''）
    parent: parent === path ? '' : parent,
    entries: dirs.entries,
    roots: null,
    home,
    total: dirs.total,
    truncated: dirs.truncated,
  }
}

/**
 * 列子目录。返回总数而非静默截断——排序后截前 N 个意味着排在后面的目录彻底不可见，
 * 用户只会以为「这个文件夹下没有我要的目录」。
 */
function childDirs(path: string): { entries: string[]; total: number; truncated: boolean } {
  const dirents = readdirSync(path, { withFileTypes: true })
  // 只隐藏 $ 系统目录（$RECYCLE.BIN 等）；点开头目录保留——否则 .zcode 这类
  // 工作区路径下的仓库永远点不到（P2 实测踩坑）
  const all = dirents
    .filter((d) => d.isDirectory() && !d.isSymbolicLink() && !d.name.startsWith('$'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
  return capEntries(all)
}

/**
 * 截断 + 元数据（纯函数，抽出来好离线测边界）。排序后截前 N 个意味着排在后面的目录
 * 彻底不可见——所以必须把 total/truncated 一并带出去，前端才能提示「还有更多」。
 */
export function capEntries(all: string[]): { entries: string[]; total: number; truncated: boolean } {
  return { entries: all.slice(0, MAX_ENTRIES), total: all.length, truncated: all.length > MAX_ENTRIES }
}

/** 供路由层拼接子目录绝对路径（Windows 分隔符归一）。 */
export function joinChild(parent: string, name: string): string {
  return join(parent.length > 0 ? parent : '', name)
}
