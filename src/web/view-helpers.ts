/** 视图共享的领域映射：状态中文标签 / 色调 / 数字与时间格式化。 */

export const MISSION_LABEL: Record<string, string> = {
  planning: '规划中',
  running: '运行中',
  awaiting_approval: '待审批',
  awaiting_dispatch: '待派发',
  paused: '已暂停',
  escalated: '已转人工',
  done: '已完成',
  aborted: '已中止',
}

export const MISSION_TONE: Record<string, string> = {
  planning: 'plan',
  running: 'run',
  awaiting_approval: 'wait',
  awaiting_dispatch: 'wait',
  paused: 'block',
  done: 'done',
  aborted: 'idle',
  escalated: 'error',
}

export const SLOT_LABEL: Record<string, string> = {
  idle: '空闲',
  working: '运行中',
  dispatched: '已派发',
  waiting_approval: '等待审批',
  error: '错误',
  rate_limited: '限流',
  stopped: '已停止',
}

export const TASK_TYPE_LABEL: Record<string, string> = {
  implement: '实现',
  review: '评审',
  test: '测试',
  doc: '文档',
  research: '调研',
  plan: '规划',
}

export const TASK_STATUS_LABEL: Record<string, string> = {
  ready: '待办',
  dispatched: '执行中',
  running: '执行中',
  blocked: '受阻',
  done: '完成',
  escalated: '转人工',
}

export function shortSlotId(id: string | undefined): string {
  if (id === undefined || id.length === 0) return '—'
  const idx = id.indexOf('-S-')
  return idx >= 0 ? id.slice(idx + 1) : id
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function budgetPct(spent: number, budget: number): number {
  if (budget <= 0) return 0
  return Math.min(100, Math.round((spent / budget) * 100))
}

/** 结构化名册 → 发射槽位（id 按序号；claude 指定 deepseek，其余走 CLI 默认）。 */
export function rosterToSlots(roster: Array<{ vendor: string; role: string; capabilities: string[]; avatar?: string }>): Array<{ id: string; vendor: string; role: string; capabilities: string[]; model: string; avatar?: string }> {
  return roster.map((m, i) => ({
    id: `S-${i + 1}`,
    vendor: m.vendor,
    role: m.role,
    capabilities: m.capabilities,
    model: m.vendor === 'claude' ? 'deepseek-v4-pro' : '',
    avatar: m.avatar,
  }))
}

/** token 预算百分比；无上限（unlimited）返回 null。 */
export function tokenBudgetPct(spentTokens: number, budgetTokens: number | null | undefined): number | null {
  if (budgetTokens === null || budgetTokens === undefined || budgetTokens <= 0) return null
  return Math.min(100, Math.round((spentTokens / budgetTokens) * 100))
}
