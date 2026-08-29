/**
 * Planner 子系统 —— goal → 任务 DAG 的智能分解层（P1，参照 AgentScope DAGPlanExecutor）。
 *
 * 设计不变量（与项目「LLM 提议、代码裁决」同源）：
 *   1. Planner 就是一个普通任务（type 'plan'、skill_tags ['规划']）：复用 WorkerBackend
 *      抽象、能力路由、watchdog、账本、审批门全套资产，编排层除提案裁决外零特判；
 *   2. 规划提案是数据不是指令：报告里的 plan 数组必须通过代码裁决
 *      （schema / id 白名单 / 环 / 能力覆盖体检 / implement-review 配对）才落盘为任务；
 *      非法提案 = silent_failure，走既有重试/转人工路径，不会污染任务图；
 *   3. 重规划有界（REPLAN_LIMIT）+ 预算门控：防「规划-失败-再规划」无限烧钱
 *      （AgentScope plan executor 反馈环的有界化）。
 */
import { z } from 'zod'
import { SAFE_ENTITY_ID } from './types.js'
import type { AgentSlot, MissionReport } from './types.js'
import type { PlanTaskInput } from './orchestrator.js'

/** planner 槽位的能力标签（charter planner.md 同源：capabilities 含「规划」即 planner）。 */
export const PLAN_TASK_SKILL = '规划'

/** 自动重规划上限（含人工触发的 requestReplan；超过后只能换阵型/人工接管）。 */
export const REPLAN_LIMIT = 2

/** 单次提案的任务数上限（fan-out 守门：防 planner 生成巨型 DAG 打爆预算）。 */
export const MAX_PLAN_TASKS = 16

/** 提案允许的任务类型：禁 'plan'（规划不可嵌套——规划产物是执行任务，不是新规划）。 */
const PLAN_TASK_TYPES = ['implement', 'review', 'test', 'doc', 'research'] as const

/** 规划提案 schema（zod 单一事实源；报告 plan 字段的结构化契约）。 */
export const PlanProposalSchema = z.object({
  goal_restatement: z.string().optional(),
  tasks: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        spec: z.string().min(1),
        type: z.enum(PLAN_TASK_TYPES),
        skill_tags: z.array(z.string()).default([]),
        depends_on: z.array(z.string()).default([]),
      }),
    )
    .min(1),
  assumptions: z.array(z.string()).default([]),
})

export type PlanProposal = z.infer<typeof PlanProposalSchema>

/** 阵型是否具备 planner 槽位（launch 分流依据：有 planner → 智能分解；无 → 默认链）。 */
export function hasPlannerSlot(slots: Array<Pick<AgentSlot, 'capabilities'>>): boolean {
  return slots.some((s) => s.capabilities.includes(PLAN_TASK_SKILL))
}

export interface PlannerRosterEntry {
  id: string
  role: string
  capabilities: string[]
}

export interface PlannerReplanContext {
  reason: string
  /** 未完成/已转人工任务的现状摘要（喂回 planner 重新分配）。 */
  failures: Array<{ id: string; title: string; status: string; fault?: string; last_error?: string }>
}

export interface PlannerSpecOptions {
  goal: string
  roster: PlannerRosterEntry[]
  replan?: PlannerReplanContext
}

/**
 * 构建 plan 任务的 spec（自包含契约：headless 后端不挂 charter 文本，规划纪律全部内联）。
 * 要点：目标重述、DAG 形状、能力覆盖体检、implement 必配独立 review、诚实假设、
 * MISSION_REPORT.plan 结构化输出。
 */
export function buildPlannerSpec(opts: PlannerSpecOptions): string {
  const roster = opts.roster
    .map((s) => `- ${s.id}（${s.role}）：${s.capabilities.join('、') || '（未声明能力）'}`)
    .join('\n')
  const lines: string[] = [
    '你是本次 Mission 的 Planner（规划者）。用户目标与员工名册如下，请输出任务分解 DAG。',
    '',
    '## 用户目标（一句话，可验收）',
    opts.goal,
    '',
    '## 员工名册（任务只能派给他们能干的事）',
    roster,
  ]
  if (opts.replan !== undefined) {
    const failures = opts.replan.failures
      .map((f) => `- ${f.id}（${f.title}）：status=${f.status}${f.fault !== undefined ? ` fault=${f.fault}` : ''}${f.last_error !== undefined ? ` —— ${f.last_error.slice(0, 160)}` : ''}`)
      .join('\n')
    lines.push(
      '',
      '## 重规划上下文（上一版计划执行受挫，请重新分解未完成部分）',
      `触发原因：${opts.replan.reason}`,
      failures.length > 0 ? failures : '（无具体失败任务）',
      '已 done 的任务不要重复规划；重新分配受挫任务或改用不同达成路径。',
    )
  }
  lines.push(
    '',
    '## 分解规则（必须全部满足，代码会逐条校验，违例 = 提案被拒）',
    '1. 每个任务：id（T-n 形式）/ title / spec（给员工的完整任务书）/ type / skill_tags / depends_on；',
    '2. type ∈ implement|review|test|doc|research（不允许 plan——规划不嵌套）；',
    '3. 每个 implement 任务必须配至少一个 review 任务，其 depends_on 指向该实现任务（独立审查不可省）；',
    '4. 每个任务的 skill_tags 必须被名册中至少一名员工的能力集合覆盖（能力覆盖体检）；',
    '5. 依赖必须无环、只引用提案内的任务 id；任务数 ≤ ' + MAX_PLAN_TASKS + '；',
    '6. 任务切分 = 窗口管理：每个任务上下文控制在「几个文件」量级，仓库级任务必须拆分；',
    '7. 你不写实现、不读实现者工作区；规划完成你的任务即结束。',
    '',
    '## 输出契约',
    '在 MISSION_REPORT 的 plan 字段输出结构化 DAG（数组），并在 assumptions 里写明不确定的技术假设（禁止编造）：',
    '```json',
    '"plan": [',
    '  { "id": "T-1", "title": "实现 X", "spec": "…完整任务书…", "type": "implement", "skill_tags": ["编码"], "depends_on": [] },',
    '  { "id": "T-2", "title": "独立 review T-1", "spec": "按最小上下文审查 T-1…", "type": "review", "skill_tags": ["审查"], "depends_on": ["T-1"] }',
    ']',
    '"assumptions": ["…"]',
    '```',
    'task_id 填本规划任务自身的 id；task_type 填 plan；不 commit、files_changed 填 []。',
  )
  return lines.join('\n')
}

/** 从规划任务的报告中提取提案：report.plan 是任务数组，包成提案对象再过 schema
 * （结构校验失败的提取返回 undefined，由调用方裁决）。 */
export function extractPlanProposal(report: MissionReport): PlanProposal | undefined {
  if (!Array.isArray(report.plan)) return undefined
  const parsed = PlanProposalSchema.safeParse({ tasks: report.plan, assumptions: [] })
  return parsed.success ? parsed.data : undefined
}

export type PlanValidation =
  | { ok: true; plan: PlanTaskInput[]; assumptions: string[]; goalRestatement?: string }
  | { ok: false; errors: string[] }

/**
 * 规划提案代码裁决（LLM 提议、代码裁决不变量的规划版）：
 * id 白名单/重复/冲突 → 自依赖/悬空依赖 → 环检测 → 能力覆盖体检 → implement-review
 * 配对 → 规模上限。全部通过才允许落盘为任务。
 */
export function validatePlanProposal(
  proposal: PlanProposal,
  ctx: { slots: Array<Pick<AgentSlot, 'capabilities'>>; existingTaskIds: Set<string> },
): PlanValidation {
  const errors: string[] = []
  // 归一化：直接调用（非 zod 提取路径）时 skill_tags/depends_on 可能缺省
  const tasks = proposal.tasks.map((t) => ({ ...t, skill_tags: t.skill_tags ?? [], depends_on: t.depends_on ?? [] }))
  if (tasks.length === 0) errors.push('plan is empty')
  if (tasks.length > MAX_PLAN_TASKS) errors.push(`plan has ${tasks.length} tasks (max ${MAX_PLAN_TASKS})`)

  const ids = new Set<string>()
  for (const t of tasks) {
    if (!SAFE_ENTITY_ID.test(t.id)) errors.push(`task id not allowed: ${t.id}`)
    if (ids.has(t.id)) errors.push(`duplicate task id: ${t.id}`)
    ids.add(t.id)
    if (ctx.existingTaskIds.has(t.id)) errors.push(`task id collides with existing task: ${t.id}`)
    if (t.depends_on.includes(t.id)) errors.push(`task ${t.id} depends on itself`)
  }
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!ids.has(dep)) errors.push(`task ${t.id} depends on unknown task ${dep}`)
    }
  }
  // 环检测（DFS 三色标记）
  const color = new Map<string, 1 | 2>()
  const visit = (id: string, path: string[]): boolean => {
    color.set(id, 1)
    for (const dep of tasks.find((t) => t.id === id)?.depends_on ?? []) {
      const c = color.get(dep)
      if (c === 1) { errors.push(`dependency cycle: ${[...path, dep].join(' -> ')}`); return true }
      if (c === undefined && visit(dep, [...path, dep])) return true
    }
    color.set(id, 2)
    return false
  }
  for (const t of tasks) {
    if (!color.has(t.id)) visit(t.id, [t.id])
  }
  // 能力覆盖体检：任务标签必须被某员工能力集合覆盖（无标签任务任意员工可干）
  for (const t of tasks) {
    if (t.skill_tags.length === 0) continue
    const covered = ctx.slots.some((s) => t.skill_tags.every((tag) => s.capabilities.includes(tag)))
    if (!covered) errors.push(`capability gap: task ${t.id} needs [${t.skill_tags.join(',')}] but no slot covers it`)
  }
  // implement-review 配对：每个实现任务至少被一个 review 任务依赖
  for (const t of tasks) {
    if (t.type !== 'implement') continue
    const reviewed = tasks.some((r) => r.type === 'review' && r.depends_on.includes(t.id))
    if (!reviewed) errors.push(`implement task ${t.id} has no review task depending on it (quality gate cannot be skipped at plan time)`)
  }
  if (!tasks.some((t) => t.type === 'implement')) errors.push('plan has no implement task')

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    plan: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      spec: t.spec,
      type: t.type,
      skill_tags: t.skill_tags,
      depends_on: t.depends_on,
    })),
    assumptions: proposal.assumptions,
    goalRestatement: proposal.goal_restatement,
  }
}
