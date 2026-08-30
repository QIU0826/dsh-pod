/**
 * 控制台本地设置（localStorage 持久化）——发射默认值 + 对话行为 + 外观。
 * v1 兼容迁移：旧 slots 字符串名册 → 结构化点选名册。
 */

/** 名册成员（点选构建，拒绝打字）：vendor + 职责 + 能力，全为受控词表。 */
export interface RosterMember {
  vendor: 'claude' | 'codex' | 'opencode' | 'dsh'
  role: string
  capabilities: string[]
  /** 毕加索动物形象（avatars.ts 词表；可空 = 默认猫）。 */
  avatar?: string
}

/** 员工类型（standalone 壳实际接线的 backend）。 */
export const VENDOR_OPTIONS: Array<{ id: RosterMember['vendor']; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'dsh', label: 'DSH' },
]

/** 职责（点选角色 = 自动带默认能力，可再点增删）。 */
export const ROLE_OPTIONS: Array<{ id: string; label: string; caps: string[] }> = [
  { id: 'planner', label: '规划', caps: ['规划'] },
  { id: 'implementer', label: '实现', caps: ['编码'] },
  { id: 'reviewer', label: '审查', caps: ['审查'] },
  { id: 'tester', label: '测试', caps: ['测试'] },
  { id: 'researcher', label: '调研', caps: ['调研'] },
  { id: 'docs', label: '文档', caps: ['文档'] },
]

/** 能力词表（引擎按中文名匹配，含「规划」的槽位发射后先做任务分解）。 */
export const CAPABILITY_OPTIONS = ['规划', '编码', '审查', '测试', '文档', '调研']

export const DEFAULT_ROSTER: RosterMember[] = [
  { vendor: 'claude', role: 'planner', capabilities: ['规划'], avatar: 'owl' },
  { vendor: 'claude', role: 'implementer', capabilities: ['编码'], avatar: 'cat' },
  { vendor: 'codex', role: 'reviewer', capabilities: ['审查'], avatar: 'fox' },
]

export type Density = 'compact' | 'standard' | 'verbose'

export type BudgetMode = 'unlimited' | 'tokens'

export interface ConsoleSettings {
  cwd: string
  /** 旧 USD 预算（v1 兼容读取；主计价已改 token，此字段退役不再展示）。 */
  budgetUsd: string
  /** 预算模式：不限 / Token 上限（token 是主计价单位）。 */
  budgetMode: BudgetMode
  budgetTokens: string
  /** 并行执行上限（1-8；更高 = 更快但 token 消耗更集中）。 */
  parallel: string
  roster: RosterMember[]
  density: Density
  defaultView: 'chat' | 'board' | 'dag'
  agentMsgMax: number
}

export const DEFAULT_SETTINGS: ConsoleSettings = {
  cwd: '',
  budgetUsd: '3',
  budgetMode: 'tokens',
  budgetTokens: '2000000',
  parallel: '2',
  roster: DEFAULT_ROSTER,
  density: 'standard',
  defaultView: 'chat',
  agentMsgMax: 600,
}

export const SETTINGS_KEY = 'pod-console-settings-v1'

/** 旧版名册字符串（"vendor 角色 能力；…"）→ 结构化 roster（localStorage 迁移）。 */
export function parseRosterString(raw: string): RosterMember[] {
  const vendors = VENDOR_OPTIONS.map((v) => v.id) as string[]
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [vendorRaw, roleRaw, ...caps] = part.split(/\s+/)
      const vendor = (vendorRaw !== undefined && vendors.includes(vendorRaw) ? vendorRaw : 'claude') as RosterMember['vendor']
      const capabilities = caps.filter((c) => CAPABILITY_OPTIONS.includes(c))
      return { vendor, role: roleRaw ?? 'implementer', capabilities: capabilities.length > 0 ? capabilities : ['编码'] }
    })
}

export function loadSettings(): ConsoleSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<ConsoleSettings> & { slots?: unknown; density?: unknown }
      const merged: ConsoleSettings = { ...DEFAULT_SETTINGS, ...parsed }
      // 迁移：旧版 slots 字符串 → 结构化点选名册
      if (!Array.isArray(parsed.roster)) {
        merged.roster = typeof parsed.slots === 'string' ? parseRosterString(parsed.slots) : DEFAULT_ROSTER.map((m) => ({ ...m }))
      }
      // 迁移：旧三值密度枚举兼容（compact/verbose 仍在词表内）
      if (parsed.density !== undefined && !['compact', 'standard', 'verbose'].includes(String(parsed.density))) {
        merged.density = 'standard'
      }
      if (merged.defaultView !== 'chat' && merged.defaultView !== 'board' && merged.defaultView !== 'dag') {
        merged.defaultView = parsed.defaultView === 'board' ? 'board' : 'chat'
      }
      // 迁移（token 主计价）：旧数据无 budgetMode → 按旧 token 值或默认 2M
      if (parsed.budgetMode !== 'unlimited' && parsed.budgetMode !== 'tokens') {
        merged.budgetMode = 'tokens'
      }
      if (merged.budgetMode === 'tokens' && merged.budgetTokens.trim().length === 0) {
        merged.budgetTokens = '2000000'
      }
      merged.roster = merged.roster.map((m, i) => ({ ...m, avatar: m.avatar ?? DEFAULT_ROSTER[i % DEFAULT_ROSTER.length]!.avatar }))
      return merged
    }
  } catch { /* 损坏则回默认 */ }
  return { ...DEFAULT_SETTINGS, roster: DEFAULT_ROSTER.map((m) => ({ ...m })) }
}

export function saveSettings(settings: ConsoleSettings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch { /* 私密模式等：不持久化 */ }
}
