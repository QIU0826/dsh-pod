/**
 * Bake-off claude 写码型 —— 真实写码完整链到审批卡（解锁前被阻塞项）。
 *
 * 背景：本机 DeepSeek 配置的 claude 后端此前 401（CR-26/27 边界如实记录），
 * 写码型 bake-off 一直「待 claude 后端有效」。用户提供可用的 claude settings 后，
 * ClaudeHeadlessBackend 实测可写文件/commit/跑测试 —— 本脚本跑真实写码链：
 *   implement（claude 写码+测试+commit）→ 独立 review（claude 审查 diff）→ 审批卡
 *
 * 用法（先 build）：node scripts/bakeoff-claude.mjs
 * 任务：pod-demo-repo 新增 divide(a,b) + 除法测试（增量，不与已有 multiply 冲突）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JsonStore } from '../dist/core/store.js'
import { MissionOrchestrator } from '../dist/core/orchestrator.js'
import { verifyTaskArtifacts, execGitClient } from '../dist/core/verifier.js'
import { ClaudeHeadlessBackend } from '../dist/workers/claude-headless.js'
import { repairPath } from '../dist/workers/preflight.js'

repairPath()

const REPO = join(process.cwd(), '..', 'pod-demo-repo')
if (!existsSync(join(REPO, '.git'))) {
  console.error('not a git repo:', REPO)
  process.exit(2)
}

const SPEC =
  '在 src/util.ts 新增并导出函数 divide(a: number, b: number): number（a/b，b 为 0 时返回 NaN），' +
  '并在 example.md 补充 divide 用法示例，新增 tests/util.test.ts 用 node:test 断言 divide(10,2)=5 与 divide(1,0) 为 NaN，' +
  '运行测试通过后 git commit（message 含 task-T-1）并输出 MISSION_REPORT。'

const startedAt = Date.now()
const runId = 'claude-' + Date.now()
const reportsDir = join('reports', 'bakeoff-claude')
mkdirSync(reportsDir, { recursive: true })
const worktreePath = join(REPO, '.pod-worktrees', 'bakeoff-' + runId)
execFileSync('git', ['-C', REPO, 'worktree', 'add', worktreePath, '-b', 'bakeoff-' + runId], { stdio: 'pipe' })

const progress = []
const report = {
  run_id: runId,
  started_at: new Date(startedAt).toISOString(),
  status: 'running',
  notes: [],
}

async function main() {
  const dataDir = join(reportsDir, 'store-' + runId)
  mkdirSync(dataDir, { recursive: true })
  const store = new JsonStore({ rootDir: dataDir })
  store.open()

  const claude = new ClaudeHeadlessBackend({
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    taskTimeoutMs: 30 * 60_000,
  })

  const orch = new MissionOrchestrator('M-BAKE-CLAUDE', {
    store,
    backends: { claude },
    worktree: { async ensure() { return worktreePath } },
    verify: async (t, r) => {
      const result = await verifyTaskArtifacts({ git: execGitClient(), repoDir: worktreePath }, t, r)
      if (!result.ok) console.error('[bakeoff-claude-verify] FAIL', t.id, JSON.stringify(result.failures))
      return result
    },
    diffProvider: async (t) => {
      const target = store.getTask((t.depends_on ?? [])[0] ?? '')
      if (target?.parent_sha === undefined || target?.commit_sha === undefined) return '（无 diff）'
      return execFileSync('git', ['-C', worktreePath, 'diff', target.parent_sha, target.commit_sha], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
    },
  })

  orch.launch({
    name: 'bakeoff-claude-' + runId,
    goal: SPEC,
    cwd: REPO,
    budgetUsd: 3,
    slots: [
      { id: 'S-1', vendor: 'claude', role: 'implementer', capabilities: ['编码', '测试'], model: 'deepseek-v4-pro' },
      { id: 'S-2', vendor: 'claude', role: 'reviewer', capabilities: ['审查'], model: 'deepseek-v4-pro' },
    ],
  })
  orch.createTasks([
    { id: 'T-1', title: '新增 divide 工具函数与测试', spec: SPEC, type: 'implement', skill_tags: ['编码', '测试'] },
    {
      id: 'T-2', title: '独立 review divide 实现',
      spec: '按最小上下文审查 T-1 的 diff：divide 语义是否正确（0 返回 NaN）、测试是否覆盖边界、是否有明显错误。输出 MISSION_REPORT（task_type=review, status=done, summary 含审查结论）。',
      type: 'review', skill_tags: ['审查'], depends_on: ['T-1'],
    },
  ])

  const summary = await orch.run()
  report.metrics = {
    run_status: summary.status,
    done_tasks: summary.doneTasks,
    escalated: summary.escalatedTasks,
    approvals: summary.pendingApprovals.length,
    tokens: store.getMission('M-BAKE-CLAUDE')?.spent_tokens ?? 0,
    wall_clock_s: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
  }
  report.status = summary.status === 'awaiting_approval' ? 'done' : summary.status
  if (summary.pendingApprovals.length > 0) {
    const approval = store.getApproval(summary.pendingApprovals[0])
    report.approval = approval ? { id: approval.id, status: approval.status, summary: approval.patch.summary } : null
  }
  store.close()
  console.log('[bakeoff-claude]', JSON.stringify(report, null, 2))
}

main()
  .catch((error) => {
    report.status = 'failed'
    report.notes.push('exception: ' + (error instanceof Error ? error.message : String(error)))
    console.error('[bakeoff-claude] ERROR:', error instanceof Error ? error.message : error)
  })
  .finally(() => {
    writeFileSync(join(reportsDir, runId + '.json'), JSON.stringify(report, null, 2), 'utf8')
    writeFileSync(join(reportsDir, runId + '.progress.log'), progress.join('\n'), 'utf8')
  })
