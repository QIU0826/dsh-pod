/**
 * 可移植 charter/skills 安装 —— 方案书 3.10 / CR-08 Berd-D（pod skills add）。
 *
 * 装到 ~/.dsh/pod/skills/<name>/SKILL.md；frontmatter 声明 name/role/capabilities/version；
 * 记录来源 + sha256（3.8-8 模板市场安全：首次加载展示全文后可启用）。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SkillMeta {
  name: string
  role?: string
  capabilities: string[]
  version?: string
}

export interface InstallOptions {
  dir: string
  content: string
  source: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** 解析 frontmatter（YAML 子集：key: value 或 key: [a, b]）。非法返回 undefined。 */
export function parseSkillFrontmatter(content: string): SkillMeta | undefined {
  const match = FRONTMATTER_RE.exec(content)
  if (match === null) return undefined
  const body = match[1]!
  const fields: Record<string, string> = {}
  for (const line of body.split(/\r?\n/)) {
    const sep = line.indexOf(':')
    if (sep <= 0) continue
    const key = line.slice(0, sep).trim()
    const value = line.slice(sep + 1).trim()
    fields[key] = value
  }
  const name = fields['name']
  if (name === undefined || name.length === 0) return undefined
  const capabilities = (fields['capabilities'] ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return {
    name,
    role: fields['role'],
    capabilities,
    version: fields['version'],
  }
}

/** 安装 skill：目标已存在 → 拒绝（防覆盖不可审计）。 */
export function installSkill(options: InstallOptions): boolean {
  const meta = parseSkillFrontmatter(options.content)
  if (meta === undefined) throw new Error(`skill install rejected: missing frontmatter (name/capabilities)`)
  const targetDir = join(options.dir, meta.name)
  if (existsSync(join(targetDir, 'SKILL.md'))) {
    throw new Error(`skill already installed: ${meta.name} (refusing silent overwrite)`)
  }
  mkdirSync(targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'SKILL.md'), options.content, 'utf8')
  const hash = createHash('sha256').update(options.content).digest('hex')
  const sourceDoc = [
    '# 来源记录',
    '',
    `- source: ${options.source}`,
    `- sha256: ${hash}`,
    `- installed_at: ${new Date().toISOString()}`,
    `- capabilities: ${meta.capabilities.join(', ')}`,
    '',
  ].join('\n')
  writeFileSync(join(targetDir, 'source.md'), sourceDoc, 'utf8')
  return true
}

/** 已安装 skill 清单（目录名）。 */
export function listSkills(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort()
}

/** 读取 skill 内容（SKILL.md）。 */
export function readSkill(dir: string, name: string): string {
  return readFileSync(join(dir, name, 'SKILL.md'), 'utf8')
}
