import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RULES,
  decidePermission,
  isReadOnlyCommand,
  type PermissionRule,
} from '../src/core/permission-rules.js'

/**
 * AgentScope-A / DoD-18：审批规则层。
 * 规则命中优先（allow/deny/ask），未命中走模式默认；bash 只读命令自动放行。
 */

const tool = { name: 'Bash', input: { command: 'git status' } } as never

describe('isReadOnlyCommand（bash 只读命令自动放行，DoD-18）', () => {
  it('git status/diff/log 只读 → true', () => {
    expect(isReadOnlyCommand('git status')).toBe(true)
    expect(isReadOnlyCommand('git diff HEAD')).toBe(true)
    expect(isReadOnlyCommand('git log --oneline')).toBe(true)
  })

  it('Get-ChildItem / ls 只读 → true', () => {
    expect(isReadOnlyCommand('Get-ChildItem')).toBe(true)
    expect(isReadOnlyCommand('ls -la')).toBe(true)
  })

  it('npm test 非只读 → false', () => {
    expect(isReadOnlyCommand('npm test')).toBe(false)
  })

  it('git push / git commit 非只读 → false', () => {
    expect(isReadOnlyCommand('git push')).toBe(false)
    expect(isReadOnlyCommand('git commit -m x')).toBe(false)
  })

  it('node --version 只读探测 → true', () => {
    expect(isReadOnlyCommand('node --version')).toBe(true)
  })
})

describe('decidePermission（规则命中优先，未命中走模式默认）', () => {
  it('无规则 + 只读命令 → allow（开箱规则）', () => {
    const decision = decidePermission({ tool, rules: [], defaultMode: 'ask' })
    expect(decision.behavior).toBe('allow')
  })

  it('规则 deny 命中 → deny（即使命令只读）', () => {
    const rules: PermissionRule[] = [{ tool: 'Bash', pattern: 'git push', decision: 'deny', scope: 'global' }]
    const decision = decidePermission(
      { tool: { name: 'Bash', input: { command: 'git push origin' } } as never, rules, defaultMode: 'allow' },
    )
    expect(decision.behavior).toBe('deny')
  })

  it('规则 allow 命中 → allow', () => {
    const rules: PermissionRule[] = [{ tool: 'Bash', pattern: 'npm test', decision: 'allow', scope: 'mission' }]
    const decision = decidePermission(
      { tool: { name: 'Bash', input: { command: 'npm test' } } as never, rules, defaultMode: 'ask' },
    )
    expect(decision.behavior).toBe('allow')
  })

  it('未命中规则 + 非只读 + defaultMode=ask → ask', () => {
    const decision = decidePermission(
      { tool: { name: 'Bash', input: { command: 'npm test' } } as never, rules: [], defaultMode: 'ask' },
    )
    expect(decision.behavior).toBe('ask')
  })

  it('未命中规则 + defaultMode=deny → deny', () => {
    const decision = decidePermission(
      { tool: { name: 'Bash', input: { command: 'npm test' } } as never, rules: [], defaultMode: 'deny' },
    )
    expect(decision.behavior).toBe('deny')
  })

  it('mission 级规则优先于 global（scope 近者先）', () => {
    const rules: PermissionRule[] = [
      { tool: 'Bash', pattern: 'git push', decision: 'allow', scope: 'global' },
      { tool: 'Bash', pattern: 'git push', decision: 'deny', scope: 'mission' },
    ]
    const decision = decidePermission(
      { tool: { name: 'Bash', input: { command: 'git push' } } as never, rules, defaultMode: 'ask' },
    )
    expect(decision.behavior).toBe('deny')
  })

  it('工具名不匹配的规则不生效', () => {
    const rules: PermissionRule[] = [{ tool: 'Read', pattern: 'npm test', decision: 'deny', scope: 'global' }]
    const decision = decidePermission(
      { tool: { name: 'Bash', input: { command: 'npm test' } } as never, rules, defaultMode: 'allow' },
    )
    expect(decision.behavior).toBe('allow')
  })
})

describe('DEFAULT_RULES 开箱规则（DoD-18）', () => {
  it('默认含 bash 只读自动放行与 apply_patch ask', () => {
    expect(DEFAULT_RULES.some((r) => r.tool === 'Bash' && r.decision === 'allow')).toBe(true)
    expect(DEFAULT_RULES.some((r) => r.tool === 'apply_patch' && r.decision === 'ask')).toBe(true)
    expect(DEFAULT_RULES.some((r) => r.tool === 'Bash' && r.pattern === 'git push' && r.decision === 'deny')).toBe(true)
  })
})
