/**
 * Planner 子系统单测（P1：goal → DAG 智能分解，AgentScope DAGPlanExecutor 借鉴）。
 * 核心不变量：LLM 提议、代码裁决——提案必须逐条过校验才允许落盘为任务。
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_PLAN_TASKS,
  PlanProposalSchema,
  REPLAN_LIMIT,
  bestConsultSlot,
  buildCapabilityFeedback,
  buildConsultPrompt,
  buildPlannerSpec,
  buildReviewGapFeedback,
  classifyPlanErrors,
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

  it('单槽名册契约引导自审；多槽仍要求独立审查', () => {
    const solo = buildPlannerSpec({
      goal: 'g',
      roster: [{ id: 'S-1', role: 'implementer', capabilities: ['编码', '审查'] }],
    })
    expect(solo).toContain('不要生成 review 任务')
    expect(solo).toContain('自审')
    expect(solo).not.toContain('独立审查不可省')
    const multi = buildPlannerSpec({
      goal: 'g',
      roster: [
        { id: 'S-P', role: 'planner', capabilities: ['规划'] },
        { id: 'S-1', role: 'implementer', capabilities: ['编码'] },
        { id: 'S-2', role: 'reviewer', capabilities: ['审查'] },
      ],
    })
    expect(multi).toContain('独立审查不可省')
    expect(multi).not.toContain('不要生成 review 任务')
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

  it('单槽阵型：implement 无 review 配对也通过（降级为自审）', () => {
    const solo = { slots: [{ capabilities: ['编码'] }], existingTaskIds: new Set<string>() }
    const r = validatePlanProposal(
      { tasks: [{ id: 'T-1', title: '实现', spec: 's', type: 'implement', skill_tags: ['编码'], depends_on: [] }], assumptions: [] },
      solo,
    )
    expect(r.ok).toBe(true)
  })

  it('拒绝：单槽阵型含 review 任务（独立审查物理不可行）', () => {
    const solo = { slots: [{ capabilities: ['编码', '审查'] }], existingTaskIds: new Set<string>() }
    const r = validatePlanProposal(proposal(), solo)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('independent review infeasible'))).toBe(true)
      expect(r.errors.some((e) => e.includes('T-2'))).toBe(true)
    }
  })

  it('空阵型：任何含 review 的提案都拒绝', () => {
    const empty = { slots: [], existingTaskIds: new Set<string>() }
    const r = validatePlanProposal(proposal(), empty)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some((e) => e.includes('independent review infeasible'))).toBe(true)
  })
  it('常量：REPLAN_LIMIT 有界；MAX_PLAN_TASKS 为正', () => {
    expect(REPLAN_LIMIT).toBeGreaterThan(0)
    expect(REPLAN_LIMIT).toBeLessThanOrEqual(3)
    expect(MAX_PLAN_TASKS).toBeGreaterThan(0)
  })
})

describe('classifyPlanErrors（P1 feedback 环：语义 vs 结构分类）', () => {
  it('capability gap → semantic + 缺口明细；其余 → structural', () => {
    const cls = classifyPlanErrors([
      'capability gap: task T-2 needs [运维] but no slot covers it',
      'capability gap: task T-3 needs [编码,数据库] but no slot covers it',
      'dependency cycle: T-1 -> T-2 -> T-1',
      'task id not allowed: ../evil',
      'plan has 17 tasks (max 16)',
    ])
    expect(cls.semantic).toHaveLength(2)
    expect(cls.structural).toHaveLength(3)
    expect(cls.capabilityGaps).toEqual([
      { taskId: 'T-2', tags: ['运维'] },
      { taskId: 'T-3', tags: ['编码', '数据库'] },
    ])
    expect(cls.structural).toContain('dependency cycle: T-1 -> T-2 -> T-1')
  })

  it('无能力缺口 → semantic 空，全 structural', () => {
    const cls = classifyPlanErrors(['duplicate task id: T-1', 'task T-1 depends on itself'])
    expect(cls.semantic).toHaveLength(0)
    expect(cls.capabilityGaps).toHaveLength(0)
    expect(cls.structural).toHaveLength(2)
  })

  it('buildCapabilityFeedback：列出缺口 + 名册实际能力', () => {
    const fb = buildCapabilityFeedback(
      [{ taskId: 'T-2', tags: ['运维'] }],
      [
        { id: 'S-1', role: 'implementer', capabilities: ['编码'] },
        { id: 'S-P', role: 'planner', capabilities: ['规划'] },
      ],
    )
    expect(fb).toContain('T-2 需求 [运维]')
    expect(fb).toContain('S-1（implementer）：编码')
    expect(fb).toContain('名册实际能力')
  })

  it('independent review infeasible → semantic + reviewGaps（区别于 capabilityGaps）', () => {
    const cls = classifyPlanErrors([
      'independent review infeasible: review task T-2 cannot be dispatched with only 1 slot(s) (DoD-5 quality gate needs a non-author reviewer)',
      'capability gap: task T-3 needs [运维] but no slot covers it',
      'duplicate task id: T-1',
    ])
    expect(cls.semantic).toHaveLength(2)
    expect(cls.structural).toHaveLength(1)
    expect(cls.reviewGaps).toEqual([{ taskId: 'T-2' }])
    expect(cls.capabilityGaps).toEqual([{ taskId: 'T-3', tags: ['运维'] }])
  })

  it('buildReviewGapFeedback：引导去掉 review 改为自审，措辞不混用「无槽位覆盖」', () => {
    const fb = buildReviewGapFeedback(
      [{ taskId: 'T-2' }],
      [{ id: 'S-1', role: 'implementer', capabilities: ['编码', '审查'] }],
    )
    expect(fb).toContain('T-2 需要独立审查')
    expect(fb).toContain('只有 1 名员工')
    expect(fb).toContain('自审')
    expect(fb).toContain('S-1（implementer）')
    expect(fb).not.toContain('无槽位覆盖')
  })
})

describe('feedback 环 v2（consult 咨询）', () => {
  it('bestConsultSlot：交集最大者优先；交集为 0 也返回 id 最小的槽位（边界交 LLM 判断）', () => {
    const gaps = [{ taskId: 'T-2', tags: ['运维'] }]
    const slots = [
      { id: 'S-2', role: 'reviewer', capabilities: ['审查'] },
      { id: 'S-1', role: 'implementer', capabilities: ['编码', '运维'] },
      { id: 'S-P', role: 'planner', capabilities: ['规划'] },
    ]
    expect(bestConsultSlot(gaps, slots)!.id).toBe('S-1') // 交集 1 最大
    // 全部交集 0：返回 id 升序最小（边界交 LLM 判断）
    expect(bestConsultSlot(gaps, [{ id: 'S-1', role: 'implementer', capabilities: ['编码'] }, { id: 'S-P', role: 'planner', capabilities: ['规划'] }])!.id).toBe('S-1')
    // 无槽位 / 空 gaps → undefined（回落 v1）
    expect(bestConsultSlot(gaps, [])).toBeUndefined()
    expect(bestConsultSlot([], slots)).toBeUndefined()
  })

  it('buildConsultPrompt：含缺口标签、目标槽位能力与截断的任务规格', () => {
    const prompt = buildConsultPrompt(
      [{ taskId: 'T-2', tags: ['运维'] }],
      { title: '实现部署脚本', spec: 'x'.repeat(3000) },
      { id: 'S-1', role: 'implementer', capabilities: ['编码'] },
    )
    expect(prompt).toContain('T-2 需求 [运维]')
    expect(prompt).toContain('S-1')
    expect(prompt).toContain('编码')
    expect(prompt).toContain('执行侧约束建议')
    expect(prompt).toContain('x'.repeat(1500)) // spec 截断到 MAX_CONSULT_SPEC_CHARS
    expect(prompt).not.toContain('x'.repeat(1600))
  })
})
