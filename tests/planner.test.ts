/**
 * Planner 子系统单测（P1：goal → DAG 智能分解，AgentScope DAGPlanExecutor 借鉴）。
 * 核心不变量：LLM 提议、代码裁决——提案必须逐条过校验才允许落盘为任务。
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_PLAN_TASKS,
  PlanProposalSchema,
  REPLAN_LIMIT,
  buildPlannerSpec,
  extractPlanProposal,
  hasPlannerSlot,
  validatePlanProposal,
  type PlanProposal,
} from '../src/core/planner.js'
import type { MissionReport } from '../src/core/types.js'

const SLOTS = [
  { capabilities: ['规划'] },
  { capabilities: ['编码'] },
  { capabilities: ['审查'] },
]

function proposal(over: Partial<PlanProposal['tasks'][number]>[] = [], extra: Partial<PlanProposal> = {}): PlanProposal {
  const base = [
    { id: 'T-1', title: '实现', spec: 's', type: 'implement' as const, skill_tags: ['编码'], depends_on: [] },
    { id: 'T-2', title: '审查', spec: 'r', type: 'review' as const, skill_tags: ['审查'], depends_on: ['T-1'] },
  ]
  return { tasks: base.map((t, i) => ({ ...t, ...(over[i] ?? {}) })), assumptions: [], ...extra }
}

describe('buildPlannerSpec（规划任务书自包含契约）', () => {
  it('包含目标、名册能力、分解规则与输出契约；重规划附失败上下文', () => {
    const spec = buildPlannerSpec({
      goal: '给仓库加登录功能',
      roster: [{ id: 'S-P', role: 'planner', capabilities: ['规划'] }, { id: 'S-1', role: 'implementer', capabilities: ['编码'] }],
    })
    expect(spec).toContain('给仓库加登录功能')
    expect(spec).toContain('S-P（planner）：规划')
    expect(spec).toContain('独立 review')
    expect(spec).toContain('"plan"')
    const replan = buildPlannerSpec({
      goal: 'g',
      roster: [{ id: 'S-P', role: 'planner', capabilities: ['规划'] }],
      replan: { reason: 'T-1 反复失败', failures: [{ id: 'T-1', title: '实现', status: 'escalated', fault: 'crash', last_error: 'boom' }] },
    })
    expect(replan).toContain('重规划上下文')
    expect(replan).toContain('T-1 反复失败')
    expect(replan).toContain('fault=crash')
  })
})

describe('hasPlannerSlot', () => {
  it('capabilities 含「规划」即 planner 槽位', () => {
    expect(hasPlannerSlot([{ capabilities: ['编码', '规划'] }])).toBe(true)
    expect(hasPlannerSlot([{ capabilities: ['编码'] }, { capabilities: ['审查'] }])).toBe(false)
    expect(hasPlannerSlot([])).toBe(false)
  })
})

describe('extractPlanProposal（报告 plan 字段提取）', () => {
  const report = (plan: unknown): MissionReport =>
    ({ task_id: 'P-1', task_type: 'plan', status: 'done', summary: 'ok', files_changed: [], test_result: 'not_run', decisions: [], blockers: [], questions: [], plan }) as MissionReport

  it('合法提案提取；非法/缺失返回 undefined', () => {
    expect(extractPlanProposal(report([{ id: 'T-1', title: 't', spec: 's', type: 'implement' }]))).toBeDefined()
    expect(extractPlanProposal(report([]))).toBeUndefined()
    expect(extractPlanProposal(report([{ id: 'T-1', title: 't', spec: 's', type: 'plan' }]))).toBeUndefined() // 规划不可嵌套
    expect(extractPlanProposal(report(undefined))).toBeUndefined()
    expect(extractPlanProposal(report('not an array'))).toBeUndefined()
  })

  it('PlanProposalSchema 默认值：skill_tags/depends_on/assumptions 缺省可解析', () => {
    const parsed = PlanProposalSchema.parse({ tasks: [{ id: 'T-1', title: 't', spec: 's', type: 'doc' }] })
    expect(parsed.tasks[0]!.skill_tags).toEqual([])
    expect(parsed.assumptions).toEqual([])
  })
})

describe('validatePlanProposal（代码裁决）', () => {
  const ctx = { slots: SLOTS, existingTaskIds: new Set<string>() }

  it('合法提案通过并映射为 PlanTaskInput', () => {
    const r = validatePlanProposal(proposal(), ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.map((t) => t.id)).toEqual(['T-1', 'T-2'])
      expect(r.plan[1]!.depends_on).toEqual(['T-1'])
    }
  })

  it('拒绝：空提案 / 超 MAX_PLAN_TASKS / 非法 id / 重复 id / 与现存任务冲突', () => {
    expect(validatePlanProposal({ tasks: [], assumptions: [] }, ctx).ok).toBe(false)
    const big = Array.from({ length: MAX_PLAN_TASKS + 1 }, (_, i) => ({ id: `T-${i + 1}`, title: 't', spec: 's', type: 'review' as const, skill_tags: [], depends_on: [] }))
    // 注：全 review 提案会另触「无 implement」错误——此处断言的是规模错误也存在
    const rBig = validatePlanProposal({ tasks: big, assumptions: [] }, ctx)
    expect(rBig.ok).toBe(false)
    if (!rBig.ok) expect(rBig.errors.some((e) => e.includes('max'))).toBe(true)
    expect(validatePlanProposal(proposal([{ id: '../evil' }]), ctx).ok).toBe(false)
    const dup = validatePlanProposal(proposal([{ id: 'T-2' }]), ctx)
    expect(dup.ok).toBe(false)
    const clash = validatePlanProposal(proposal(), { ...ctx, existingTaskIds: new Set(['T-1']) })
    expect(clash.ok).toBe(false)
  })

  it('拒绝：悬空依赖 / 自依赖 / 依赖环', () => {
    const unknown = validatePlanProposal(proposal([{ depends_on: ['T-9'] }]), ctx)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.errors.some((e) => e.includes('unknown task'))).toBe(true)
    const self = validatePlanProposal(proposal([{ depends_on: ['T-1'] }, {}]), ctx)
    expect(self.ok).toBe(false)
    if (!self.ok) expect(self.errors.some((e) => e.includes('itself'))).toBe(true)
    const cycle = validatePlanProposal(
      { tasks: [
        { id: 'A', title: 'a', spec: 's', type: 'implement', skill_tags: ['编码'], depends_on: ['B'] },
        { id: 'B', title: 'b', spec: 's', type: 'review', skill_tags: ['审查'], depends_on: ['A'] },
      ], assumptions: [] },
      ctx,
    )
    expect(cycle.ok).toBe(false)
    if (!cycle.ok) expect(cycle.errors.some((e) => e.includes('cycle'))).toBe(true)
  })

  it('拒绝：能力缺口（覆盖性体检）', () => {
    const r = validatePlanProposal(proposal([{ skill_tags: ['编码', '运维'] }]), ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some((e) => e.includes('capability gap'))).toBe(true)
  })

  it('拒绝：implement 无独立 review 配对；无 implement 任务', () => {
    const noReview = validatePlanProposal(
      { tasks: [{ id: 'T-1', title: 't', spec: 's', type: 'implement', skill_tags: ['编码'], depends_on: [] }], assumptions: [] },
      ctx,
    )
    expect(noReview.ok).toBe(false)
    if (!noReview.ok) expect(noReview.errors.some((e) => e.includes('no review task'))).toBe(true)
    const onlyDoc = validatePlanProposal({ tasks: [{ id: 'T-1', title: 't', spec: 's', type: 'doc', skill_tags: [], depends_on: [] }], assumptions: [] }, ctx)
    expect(onlyDoc.ok).toBe(false)
    if (!onlyDoc.ok) expect(onlyDoc.errors.some((e) => e.includes('no implement'))).toBe(true)
  })
  it('常量：REPLAN_LIMIT 有界；MAX_PLAN_TASKS 为正', () => {
    expect(REPLAN_LIMIT).toBeGreaterThan(0)
    expect(REPLAN_LIMIT).toBeLessThanOrEqual(3)
    expect(MAX_PLAN_TASKS).toBeGreaterThan(0)
  })
})
