/**
 * 审批规则层 —— 方案书 2.6 节 / CR-08 AgentScope-A（DoD-18）。
 *
 * PermissionRule（tool+pattern → allow/deny/ask）命中优先，未命中走模式默认策略；
 * bash 只读命令运行时自动放行（开箱规则）；「记住此规则」（suggested-rules）落 Store 后
 * 同类调用免重复审批（AgentScope-B）。
 *
 * 与 approvals.ts 的关系：approvals 管「合并审批卡」生命周期；本模块管「工具级权限裁决」，
 * 是审批引擎的前置拦截层（2.6 节 v2.1 规则层 + 模式）。
 */

export type PermissionDecisionValue = 'allow' | 'deny' | 'ask'

export interface PermissionDecision {
  behavior: PermissionDecisionValue
  /** 命中规则 id（未命中 undefined）。 */
  rule_id?: string
  reason: string
}

/** 审批规则（3.4 数据模型 ApprovalRule）。 */
export interface PermissionRule {
  /** 工具名（Bash/Read/Write/apply_patch 等）。 */
  tool: string
  /** 命令/模式匹配（子串匹配；省略则匹配该工具全部调用）。 */
  pattern?: string
  decision: PermissionDecisionValue
  scope: 'mission' | 'global'
  source?: string
  ts?: number
}

export interface PermissionContext {
  tool: { name: string; input?: Record<string, unknown> }
  rules: PermissionRule[]
  /** 未命中规则时的默认策略（模式默认：mode 1 = ask）。 */
  defaultMode: PermissionDecisionValue
}

/** 只读命令探测：git 只读子命令 / 列表类 / 版本探测。 */
const READONLY_GIT = /^git\s+(status|diff|log|show|rev-parse|branch|remote|tag|ls-files|blame|grep)\b/
const READONLY_LEAD = /^(ls|dir|Get-ChildItem|Get-Content|cat|type|pwd|echo|node\s+--version|npm\s+--version|git\s+--version)\b/

export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim()
  if (READONLY_GIT.test(trimmed)) return true
  if (READONLY_LEAD.test(trimmed)) return true
  return false
}

/** 规则匹配：工具名相等 + pattern（子串，忽略大小写）。 */
function ruleMatches(rule: PermissionRule, toolName: string, input: Record<string, unknown> | undefined): boolean {
  if (rule.tool !== toolName) return false
  if (rule.pattern === undefined || rule.pattern.length === 0) return true
  // apply_patch 类工具命中 file 字段（文件名）；Bash 类命中 command；URL 类命中 url
  const target = String(input?.file ?? input?.command ?? input?.url ?? input?.path ?? '')
  return target.toLowerCase().includes(rule.pattern.toLowerCase())
}

/** 裁决：规则命中优先（mission 级优先于 global），未命中走 defaultMode + 只读放行。 */
export function decidePermission(context: PermissionContext): PermissionDecision {
  const { tool, rules, defaultMode } = context
  const input = tool.input ?? {}

  // 1) 显式规则：scope=mission 优先于 global（近者先，AgentScope-A）
  const sorted = [...rules].sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'mission' ? -1 : 1))
  for (const rule of sorted) {
    if (ruleMatches(rule, tool.name, input)) {
      return { behavior: rule.decision, rule_id: rule.tool + ':' + (rule.pattern ?? '*'), reason: `rule ${rule.scope} hit` }
    }
  }

  // 2) 未命中：bash 只读命令自动放行（开箱行为，DoD-18）
  if (tool.name === 'Bash') {
    const command = String(input.command ?? '')
    if (isReadOnlyCommand(command)) {
      return { behavior: 'allow', reason: 'read-only command auto-allowed' }
    }
  }

  // 3) 模式默认
  return { behavior: defaultMode, reason: `default mode ${defaultMode}` }
}

/** 开箱规则（2.6 节 v2.1）：bash 只读放行 / apply_patch ask / git push deny。 */
export const DEFAULT_RULES: PermissionRule[] = [
  { tool: 'Bash', pattern: 'git push', decision: 'deny', scope: 'global', source: 'pod-default' },
  { tool: 'apply_patch', decision: 'ask', scope: 'global', source: 'pod-default' },
  { tool: 'Bash', decision: 'allow', scope: 'global', source: 'pod-default-readonly' },
]

/** suggested-rules 落 Store 的持久化载体（AgentScope-B）。 */
export function buildSuggestedRule(toolName: string, input: Record<string, unknown> | undefined, decision: PermissionDecisionValue): PermissionRule {
  const pattern = input?.command !== undefined ? String(input.command).split(/\s+/).slice(0, 2).join(' ') : undefined
  return { tool: toolName, pattern, decision, scope: 'global', source: 'user-suggested', ts: Date.now() }
}

/** 审批卡数据（AS-2 依赖的最小形状，避免硬依赖 approvals 模块）。 */
export interface ApprovalLikePatch {
  slot_id: string
  worktree_path: string
  base_commit?: string
  head_commit?: string
  diff_path?: string
  summary: string
}

/**
 * AS-2（AgentScope-B）：审批通过 → 生成建议规则 → 同类免弹卡。
 * 从已批准的 patch 推导 mission 级规则：tool=apply_patch（合并唯一入口）、
 * pattern=被合并文件路径（diff_path 基名；缺省用 summary 首个 token），
 * decision=allow、scope=mission（mission 结束清理，source 标记自动来源）。
 */
export function buildSuggestedRuleFromApproval(patch: ApprovalLikePatch, idFn: () => string): ApprovalRuleLike {
  const pattern =
    patch.diff_path !== undefined && patch.diff_path.length > 0
      ? patch.diff_path.split(/[\\/]/).pop()
      : patch.summary.trim().split(/\s+/)[0]
  return {
    id: idFn(),
    tool: 'apply_patch',
    pattern: pattern !== undefined && pattern.length > 0 ? pattern : undefined,
    decision: 'allow',
    scope: 'mission',
    source: 'auto-from-approval',
    ts: Date.now(),
  }
}

/** AS-2 落 Store 的最小形状（与 types.ts ApprovalRule 字段一致）。 */
export interface ApprovalRuleLike {
  id: string
  tool: string
  pattern?: string
  decision: 'allow' | 'deny' | 'ask'
  scope: 'mission' | 'global'
  source?: string
  ts: number
}
