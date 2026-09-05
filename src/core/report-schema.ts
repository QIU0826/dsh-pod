/**
 * 报告契约唯一事实源 —— 方案书 2.5 节 / 附录 C / CR-08 Berd-B（DoD-16）。
 *
 * MISSION_REPORT 的类型、校验器、提示词片段全部从此 schema 生成：
 *   - MissionReport 类型（zod 推断）
 *   - validateMissionReport()：字段齐全性校验（取代 verifier 内手写清单）
 *   - renderReportPromptFragment()：提示词 schema 片段（取代 claude-headless 内手写 REPORT_SCHEMA_HINT）
 *
 * 纪律：禁止在别处手写字段清单；新增字段只改这里（grep 漂移测试保障）。
 */

import { z } from 'zod'

/** schema 版本（Berd-B：漂移可检测）。 */
export const MISSION_REPORT_SCHEMA_VERSION = 'pod-report-schema-2026-08-25'

const NON_NEG_INT = z.number().int().min(0)

/** 附录 C MISSION_REPORT schema（zod 单一事实源）。 */
export const MissionReportSchema = z.object({
  task_id: z.string().min(1),
  task_type: z.enum(['implement', 'review', 'plan', 'test', 'doc', 'research']),
  status: z.enum(['done', 'blocked', 'need_clarify']),
  summary: z.string().min(1),
  files_changed: z.array(z.string()),
  // 可空字段容错（CR-32 实证）：LLM 对「可省略」字段倾向显式输出 null 而非省略，
  // null 与省略等价（nullable().optional()），避免 review 报告因 commit_sha:null 被 schema 误拒。
  commit_sha: z.string().nullable().optional(),
  diff_path: z.string().nullable().optional(),
  test_command: z.string().nullable().optional(),
  test_result: z.enum(['pass', 'fail', 'not_run']),
  test_evidence: z.string().nullable().optional(),
  decisions: z.array(z.string()),
  blockers: z.array(z.string()),
  questions: z.array(z.string()),
  usage: z
    .object({
      tokens_in: NON_NEG_INT,
      tokens_out: NON_NEG_INT,
    })
    .optional(),
  // 仅 plan 任务（P1 规划层）：任务分解 DAG 提案；形状与 types.ts MissionReport.plan 同源，
  // 落盘前经 planner.ts validatePlanProposal 代码裁决（LLM 提议、代码裁决不变量）
  plan: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        spec: z.string().min(1),
        type: z.enum(['implement', 'review', 'test', 'doc', 'research']),
        skill_tags: z.array(z.string()).optional(),
        depends_on: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  // 仅 plan 任务：planner 的诚实假设与目标重述（buildPlannerSpec 输出契约要求 LLM 输出，
  // extractPlanProposal 透传进 plan_expanded 审计面）。可选字段——非 plan 任务无此字段；
  // zod 默认剥离未知键，不声明则 dsh-subagent 校验路径会把它们丢掉（2026-09-04 修复）。
  assumptions: z.array(z.string()).optional(),
  goal_restatement: z.string().optional(),
})

/** 类型 = schema 推断（单一事实源，types.ts 不重复定义）。 */
export type MissionReport = z.infer<typeof MissionReportSchema>

export type ReportValidationResult =
  | { ok: true; report: MissionReport }
  | { ok: false; errors: string[] }

/** 校验器：失败时返回逐字段错误（供 UI/Verifier 展示），成功时返回规范化报告。 */
export function validateMissionReport(input: unknown): ReportValidationResult {
  const parsed = MissionReportSchema.safeParse(input)
  if (parsed.success) return { ok: true, report: parsed.data }
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) }
}

/** 兼容薄壳：校验 + 返回布尔（旧调用方渐迁）。 */
export function isMissionReport(input: unknown): input is MissionReport {
  return MissionReportSchema.safeParse(input).success
}

/** 顶层字段清单（提示词渲染与漂移测试共用；顺序即提示词展示顺序）。 */
const FIELD_ORDER: Array<keyof MissionReport> = [
  'task_id',
  'task_type',
  'status',
  'summary',
  'files_changed',
  'commit_sha',
  'diff_path',
  'test_command',
  'test_result',
  'test_evidence',
  'decisions',
  'blockers',
  'questions',
  'usage',
  'plan',
  // 仅 plan 任务（与 plan 字段同模式：hint 标注「仅 plan 任务」，非 plan 任务省略）。
  // 必须进 FIELD_ORDER——「schema 字段与提示词片段同源」是锁定不变量（DoD-16 漂移测试）。
  'assumptions',
  'goal_restatement',
]

/**
 * 提示词 schema 片段（附录 C 渲染）。
 * 唯一手写源已消除：字段来自 FIELD_ORDER + schema 描述，任务类型按 taskType 注入。
 */
export function renderReportPromptFragment(taskType: string): string {
  const fields = FIELD_ORDER.map((key) => {
    const description = fieldHint(key)
    return `  "${key}": ${description}`
  }).join(',\n')
  return `## MISSION_REPORT（必须输出，JSON，schema v${MISSION_REPORT_SCHEMA_VERSION}）
{
${fields}
}

test_result 判定（CR-06-8，务必遵守）：
- 仓库有测试框架且测试真实失败 → fail（test_evidence 附失败输出）
- 仓库无测试框架 / 测试命令不存在（如 npm test 报 ENOENT、无 package.json）→ 必须填 not_run（禁止 fail），
  test_evidence 注明原因（如：npm ENOENT：仓库无 package.json，测试框架不存在）

非写码任务（${taskType}）：
- review/plan/research/doc：不 commit、files_changed 填 []、commit_sha 省略
- review 结论：status 用 done（结论 pass）或 blocked（结论 fail，blockers 逐条列出）`
}

/** 每字段的提示词提示（语义不变，随 schema 演进一并维护）。 */
function fieldHint(key: keyof MissionReport): string {
  switch (key) {
    case 'task_id':
      return '"<id>"'
    case 'task_type':
      return '"<任务类型: implement|review|plan|test|doc|research>"'
    case 'status':
      return '"done | blocked | need_clarify"'
    case 'summary':
      return '"≤5 句事实陈述（禁止成功叙事）"'
    case 'files_changed':
      return '["相对 worktree 根的路径（非写码任务填 []）"]'
    case 'commit_sha':
      return '"<40 位 sha，非写码任务可省略>"'
    case 'diff_path':
      return '"out/task-<id>.diff（非写码任务可省略）"'
    case 'test_command':
      return '"npm test（或探测到的测试命令；未运行可省略）"'
    case 'test_result':
      return '"pass | fail | not_run（必填）"'
    case 'test_evidence':
      return '"12/12 ✓（输出路径 out/task-<id>.testlog；not_run 时注明原因）"'
    case 'decisions':
      return '[]'
    case 'blockers':
      return '[]'
    case 'questions':
      return '[]'
    case 'usage':
      return '{ "tokens_in": 0, "tokens_out": 0 }'
    case 'plan':
      return '[{"id":"T-1","title":"…","spec":"…","type":"implement","skill_tags":["编码"],"depends_on":[]}]（仅 plan 任务：任务分解 DAG，其余任务省略此字段）'
    // 仅保 keyof MissionReport 穷举：不在 FIELD_ORDER 中（提示词片段形状对非 plan 任务
    // 保持不变），planner 的 assumptions 输出契约由 buildPlannerSpec 单独指示。
    case 'assumptions':
      return '["…诚实假设（仅 plan 任务：不确定的技术点如实注明，不冒充事实）"]'
    case 'goal_restatement':
      return '"对用户目标的一句话重述（仅 plan 任务，可省略）"'
  }
}
