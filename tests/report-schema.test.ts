import { describe, expect, it } from 'vitest'
import { MISSION_REPORT_SCHEMA_VERSION } from '../src/core/report-schema.js'
import {
  MissionReportSchema,
  renderReportPromptFragment,
  validateMissionReport,
} from '../src/core/report-schema.js'
import type { MissionReport } from '../src/core/report-schema.js'

/**
 * Berd-B / DoD-16：报告契约单一事实源。
 * 类型、校验器、提示词片段同源生成，禁止手写字段清单（grep 漂移测试）。
 */

function doneReport(over: Partial<MissionReport> = {}): MissionReport {
  return {
    task_id: 'T-1',
    task_type: 'implement',
    status: 'done',
    summary: '实现完成',
    files_changed: ['src/x.ts'],
    commit_sha: 'a'.repeat(40),
    test_command: 'npm test',
    test_result: 'pass',
    test_evidence: '12/12 ✓',
    decisions: [],
    blockers: [],
    questions: [],
    usage: { tokens_in: 10, tokens_out: 5 },
    ...over,
  }
}

describe('report-schema 单一事实源（Berd-B / DoD-16）', () => {
  it('schema 版本号存在且为字符串', () => {
    expect(typeof MISSION_REPORT_SCHEMA_VERSION).toBe('string')
    expect(MISSION_REPORT_SCHEMA_VERSION.length).toBeGreaterThan(0)
  })

  it('validateMissionReport：合法报告通过（零 errors）', () => {
    const result = validateMissionReport(doneReport())
    expect(result.ok).toBe(true)
    if (!result.ok) expect(result.errors).toEqual([])
  })

  it('validateMissionReport：缺必填字段被拒（task_id / summary / test_result）', () => {
    for (const patch of [
      { task_id: undefined },
      { summary: undefined },
      { test_result: undefined },
      { files_changed: undefined },
    ]) {
      const result = validateMissionReport(doneReport(patch as Partial<MissionReport>))
      expect(result.ok).toBe(false)
    }
  })

  it('validateMissionReport：非写码任务（review）可省略 commit_sha', () => {
    const review = doneReport({ task_type: 'review', commit_sha: undefined, files_changed: [] })
    const result = validateMissionReport(review)
    expect(result.ok).toBe(true)
  })

  it('validateMissionReport：可空字段显式 null 与省略等价（CR-32）', () => {
    // LLM 对「可省略」字段倾向显式输出 null 而非省略：commit_sha/diff_path/test_evidence 为 null 应通过
    const review = doneReport({ task_type: 'review', commit_sha: null as never, diff_path: null as never, test_evidence: null as never, files_changed: [] })
    const result = validateMissionReport(review)
    expect(result.ok).toBe(true)
  })

  it('validateMissionReport：status 枚举外值被拒', () => {
    const result = validateMissionReport(doneReport({ status: 'weird' as never }))
    expect(result.ok).toBe(false)
  })

  it('validateMissionReport：usage tokens 负数被拒', () => {
    const result = validateMissionReport(doneReport({ usage: { tokens_in: -1, tokens_out: 5 } }))
    expect(result.ok).toBe(false)
  })

  it('renderReportPromptFragment：包含 MISSION_REPORT 头与任务类型替换位', () => {
    const fragment = renderReportPromptFragment('review')
    expect(fragment).toContain('MISSION_REPORT')
    expect(fragment).toContain('review')
    expect(fragment).toContain('test_result')
    expect(fragment).toContain('CR-06-8')
  })

  it('schema 字段与提示词片段同源（提示词由 schema 渲染，无第二份手写清单）', () => {
    const fragment = renderReportPromptFragment('implement')
    // 提示词片段必须覆盖 schema 的全部顶层字段名
    for (const key of Object.keys(MissionReportSchema.shape)) {
      expect(fragment).toContain(key)
    }
  })

  it('Drift 测试：提示词 schema 必须来自 report-schema 渲染（grep 哨兵，禁止手写字段清单）', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const workerSource = readFileSync(join(process.cwd(), 'src', 'workers', 'claude-headless.ts'), 'utf8')
    // 提示词构建必须引用 report-schema 的渲染函数
    expect(workerSource).toContain('renderReportPromptFragment')
    // 不得在 worker 内手写 schema 字段（残留手写清单 = 漂移）
    expect(workerSource).not.toContain('"test_result": "pass | fail | not_run"')
    expect(workerSource).not.toContain('"files_changed": ["相对 worktree 根的路径"]')
  })
})
