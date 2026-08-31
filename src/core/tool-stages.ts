/**
 * P0-1 工具定义分层加载（技术优化调研 §1.1）：stage 清单 + 呈现构建器。
 *
 * 目标：把每轮全量注入的 pod_* 工具定义（实测 ≈2,838 tokens / 15 工具）按 mission stage
 * 分层——CORE（编排器每轮必用）+ 当前 stage 工具给完整 schema，其余给一行索引，
 * 需要时经 pod_expand_tool 展开。确定性 tag 过滤起步（ADOL Approach 2，零 embedding）。
 *
 * 本模块纯函数、可单测：commander（DSH 宿主侧呈现）与 mcp-server（tools/list --short）共用。
 */

/** mission 阶段（与 ledger by_stage 同枚举口径的扩展）。 */
export type PodToolStage = 'launch' | 'plan' | 'dispatch' | 'verify' | 'approve' | 'ops' | 'memory' | 'cron'

/** 工具 → 阶段。缺省未列出的工具视为 CORE（每轮必给完整 schema）。 */
export const POD_TOOL_STAGES: Record<string, PodToolStage> = {
  pod_launch: 'launch',
  pod_plan: 'plan',
  pod_reassign: 'dispatch',
  pod_mem_write: 'memory',
  pod_mem_query: 'memory',
  pod_mem_correct: 'memory',
  pod_cron_list: 'cron',
}

/** CORE 工具：编排器每轮都要用的编排面（含安全终止），始终给完整 schema。 */
export const POD_CORE_TOOLS: readonly string[] = [
  'pod_status',
  'pod_collect',
  'pod_dispatch',
  'pod_steer',
  'pod_approve',
  'pod_pause',
  'pod_resume',
  'pod_abort',
]

/** 工具是否属于 CORE（每轮全量）。 */
export function isCoreTool(name: string): boolean {
  return POD_CORE_TOOLS.includes(name)
}

/** 工具所属阶段；CORE 返回 undefined（不属于任何 stage 分组）。 */
export function stageOf(name: string): PodToolStage | undefined {
  return POD_TOOL_STAGES[name]
}

export interface ToolBrief {
  name: string
  /** 一句话用途（index 行用；供呈现层从完整 description 截取或单独提供）。 */
  brief: string
  stage?: PodToolStage
}

export interface ToolPresentation {
  /** 给完整 schema 的工具名（CORE + 当前 stage）。 */
  full: string[]
  /** 其余工具的一行索引（name + brief + stage）。 */
  index: string[]
}

export interface PresentOptions {
  /** 当前 mission 阶段；缺省 = 不额外展开任何 stage（只 CORE 全量）。 */
  activeStage?: PodToolStage
  /** 参与呈现的全部工具名（缺省从 POD_TOOL_STAGES + CORE 推导）。 */
  all?: readonly string[]
}

/**
 * 按 stage 分层呈现：CORE + 当前 stage → 完整 schema；其余 → 一行索引。
 * 纯函数：token 削减可据此直接量化（见 scripts/measure-tools.mjs）。
 */
export function presentTools(opts: PresentOptions = {}): ToolPresentation {
  const all = opts.all ?? [...POD_CORE_TOOLS, ...Object.keys(POD_TOOL_STAGES)]
  const full: string[] = []
  const index: string[] = []
  for (const name of all) {
    if (isCoreTool(name) || stageOf(name) === opts.activeStage) full.push(name)
    else index.push(name)
  }
  return { full, index }
}

/**
 * 一行索引文本（进模型上下文的最小呈现）：「name — brief — stage 标签 — expand 提示」。
 * brief 缺省按 name 生成占位（呈现层应传真实一句话用途）。
 */
export function buildToolIndexLine(t: ToolBrief): string {
  const stage = t.stage !== undefined ? ` [stage:${t.stage}]` : ''
  return `pod_expand_tool("${t.name}") — ${t.brief}${stage}`
}

/**
 * 呈现的 token 估算（中文/JSON 混合粗估：3.5 字符/token）。
 * full 用实测 schema 字符数（由调用方传入），index 行按固定均价估算。
 */
export function estimatePresentationTokens(
  fullNames: string[],
  indexLines: string[],
  schemaChars: Record<string, number>,
  indexLineChars = 70,
): number {
  const fullChars = fullNames.reduce((sum, n) => sum + (schemaChars[n] ?? 400), 0)
  return Math.round((fullChars + indexLines.length * indexLineChars) / 3.5)
}

/** pod_expand_tool 元工具的固定契约（name 枚举 = 全部 pod_* 工具）。 */
export const EXPAND_TOOL_NAME = 'pod_expand_tool'
