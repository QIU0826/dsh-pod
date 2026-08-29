import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSkill, listSkills, parseSkillFrontmatter, readSkill } from '../src/core/skills.js'

/**
 * Berd-D：可移植 charter/skills 安装（pod skills add）。
 * 装到 ~/.dsh/pod/skills/；frontmatter 声明 capabilities；记录来源 + hash。
 */

const SKILL_MD = `---
name: code-reviewer
role: reviewer
capabilities: [审查, 测试]
version: 1.0.0
---
# Code Reviewer

你是审查者。规则：只收 diff + 规格 + 测试输出。
`

let root: string

function makeSkillsDir() {
  root = mkdtempSync(join(tmpdir(), 'pod-skills-'))
  return root
}

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
})

describe('parseSkillFrontmatter（frontmatter 能力声明）', () => {
  it('解析 name/role/capabilities/version', () => {
    const meta = parseSkillFrontmatter(SKILL_MD)
    expect(meta).toBeDefined()
    expect(meta!.name).toBe('code-reviewer')
    expect(meta!.role).toBe('reviewer')
    expect(meta!.capabilities).toEqual(['审查', '测试'])
    expect(meta!.version).toBe('1.0.0')
  })

  it('无 frontmatter → undefined（非法 skill 拒绝安装）', () => {
    expect(parseSkillFrontmatter('# 无 frontmatter')).toBeUndefined()
  })
})

describe('installSkill（安装 + 来源记录 + hash）', () => {
  it('安装到 skills 目录并落 source.md 记录（来源 + hash）', () => {
    const dir = makeSkillsDir()
    const installed = installSkill({ dir, content: SKILL_MD, source: 'https://example.com/skills/reviewer.md' })
    expect(installed).toBe(true)
    const skillPath = join(dir, 'code-reviewer', 'SKILL.md')
    expect(existsSync(skillPath)).toBe(true)
    expect(readFileSync(skillPath, 'utf8')).toContain('# Code Reviewer')
    const sourcePath = join(dir, 'code-reviewer', 'source.md')
    expect(existsSync(sourcePath)).toBe(true)
    const source = readFileSync(sourcePath, 'utf8')
    expect(source).toContain('https://example.com/skills/reviewer.md')
    expect(source).toMatch(/sha256:/)
  })

  it('重名 skill 重复安装 → 拒绝（防覆盖不可审计）', () => {
    const dir = makeSkillsDir()
    installSkill({ dir, content: SKILL_MD, source: 'a' })
    expect(() => installSkill({ dir, content: SKILL_MD, source: 'b' })).toThrowError(/already installed|exists/)
  })

  it('无 frontmatter 内容 → 拒绝安装', () => {
    const dir = makeSkillsDir()
    expect(() => installSkill({ dir, content: '# nope', source: 'x' })).toThrowError(/frontmatter/)
  })
})

describe('listSkills / readSkill（安装清单与读取）', () => {
  it('列出已安装 skill；读取其内容', () => {
    const dir = makeSkillsDir()
    installSkill({ dir, content: SKILL_MD, source: 'a' })
    const skills = listSkills(dir)
    expect(skills).toEqual(['code-reviewer'])
    const content = readSkill(dir, 'code-reviewer')
    expect(content).toContain('Code Reviewer')
  })
})

describe('P1 路径遍历防护（name 来自不可信 frontmatter）', () => {
  it('installSkill：name 含路径分隔符/.. → 拒绝，不落盘', () => {
    const dir = makeSkillsDir()
    const evil = SKILL_MD.replace('name: code-reviewer', 'name: ../../.agents/pwned')
    expect(() => installSkill({ dir, content: evil, source: 'market' })).toThrow(/skill name rejected/)
    expect(() => installSkill({ dir, content: SKILL_MD.replace('name: code-reviewer', 'name: C:\\evil'), source: 'market' })).toThrow(/skill name rejected/)
    expect(existsSync(join(dir, 'code-reviewer'))).toBe(false)
    // 合法名字仍可安装
    expect(installSkill({ dir, content: SKILL_MD, source: 'market' })).toBe(true)
  })

  it('readSkill：name 走同一白名单 → 拒绝遍历读取', () => {
    const dir = makeSkillsDir()
    installSkill({ dir, content: SKILL_MD, source: 'market' })
    expect(() => readSkill(dir, '../../../etc/passwd')).toThrow(/skill name rejected/)
    expect(readSkill(dir, 'code-reviewer')).toContain('Code Reviewer')
  })
})
