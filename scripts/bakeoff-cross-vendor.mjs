/**
 * Bake-off 跨 vendor 写码型 —— claude 实现（写码+测试+commit）+ ark 独立审查（跨 vendor）。
 *
 * 背景：CR-32 完成单后端写码链；本脚本验证跨 vendor 质量门：
 *   implement（claude）→ 独立 review（ark，文本审查）→ 审批卡
 * ark 无工具执行能力，但审查（读 diff + 输出结论）是纯文本任务，完全适合。
 *
 * 用法（先 build）：
 *   ARK_API_KEY=<key> node scripts/bakeoff-cross-vendor.mjs
 * 任务：pod-demo-repo 新增 subtract(a,b) + 减法测试（不与 multiply/divide 冲突）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { JsonStore } from '../dist/core/store.js'
import { MissionOrchestrator } from '../dist/core/orchestrator.js'
import { verifyTaskArtifacts, execGitClient } from '../dist/core/verifier.js'
import { ClaudeHeadlessBackend } from '../dist/workers/claude-headless.js'
import { ArkBackend } from '../dist/workers/ark-headless.js'
import { repairPath } from '../dist/workers/preflight.js'

repairPath()

const REPO = join(process.cwd(), '..', 'pod-demo-repo')
if (!existsSync(join(REPO, '.git'))) {
  console.error('not a git repo:', REPO)
  process.exit(2)
}

function arkKey() {
  const env = process.env.ARK_API_KEY
  if (env !== undefined && env.length > 0) return env
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'))
    return settings.ARK_API_KEY ?? ''
  } catch { return '' }
}

const SPEC =
  '在 src/util.ts 新增并导出函数 subtract(a: number, b: number): number（a-b），' +
  '并在 example.md 补充 subtract 用法示例，新增 tests/subtract.test.ts 用 node:test 断言 subtract(10,3)=7 与 subtract(0,5)=-5，' +
  '运行测试通过后 git commit（message 含 task-T-1）并输出 MISSION_REPORT。'

const startedAt = Date.now()
const runId = 'xvendor-' + Date.now()
const reportsDir = join('reports', 'bakeoff-cross-vendor')
mkdirSync(reportsDir, { recursive: true })
const worktreePath = join(REPO, '.pod-worktrees', 'bakeoff-' + runId)
execFileSync('git', ['-C', REPO, 'worktree', 'add', worktreePath, '-b', 'bakeoff-' + runId], { stdio: 'pipe' })

const report = {
  run_id: runId,
  started_at: new Date(startedAt).toISOString(),
  status: 'running',
  notes: [],
}

async function main() {
  const key = arkKey()
  if (key.length === 0) { console.error('[bakeoff-xvendor] ARK_API_KEY missing'); process.exit(2) }

  const dataDir = join(reportsDir, 'store-' + runId)
  mkdirSync(dataDir, { recursive: true })
  const store = new JsonStore({ rootDir: dataDir })
  store.open()

  const claude = new ClaudeHeadlessBackend({
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    taskTimeoutMs: 30 * 60_000,
  })
  const ark = new ArkBackend({ apiKey: key, timeoutMs: 10 * 60_000 })
  const arkDetect = await ark.detect()
  if (!arkDetect.authed) { console.error('[bakeoff-xvendor] ark auth failed:', arkDetect.error); process.exit(1) }
  console.log('[bakeoff-xvendor] ark authed, model=' + (arkDetect.models[0] ?? '?'))

  const orch = new MissionOrchestrator('M-BAKE-XVENDOR', {
    store,
    backends: { claude, ark },
    worktree: { async ensure() { return worktreePath } },
    verify: async (t, r) => {
      const result = await verifyTaskArtifacts({ git: execGitClient(), repoDir: worktreePath }, t, r)
      if (!result.ok) console.error('[bakeoff-xvendor-verify] FAIL', t.id, JSON.stringify(result.failures))
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
    name: 'bakeoff-xvendor-' + runId,
    goal: SPEC,
    cwd: REPO,
    budgetUsd: 3,
    slots: [
      { id: 'S-1', vendor: 'claude', role: 'implementer', capabilities: ['编码', '测试'], model: 'deepseek-v4-pro' },
      { id: 'S-2', vendor: 'ark', role: 'reviewer', capabilities: ['审查'], model: 'deepseek-v4-flash' },
    ],
  })
  orch.createTasks([
    { id: 'T-1', title: '新增 subtract 工具函数与测试', spec: SPEC, type: 'implement', skill_tags: ['编码', '测试'] },
    {
      id: 'T-2', title: '独立 review subtract 实现（ark 跨 vendor）',
      spec: '审查 T-1 的 diff（经 diffProvider 注入）：subtract 语义是否正确、测试是否覆盖边界、是否有明显错误。输出 MISSION_REPORT（task_type=review, status=done, summary 含审查结论，files_changed=[]）。',
      type: 'review', skill_tags: ['审查'], depends_on: ['T-1'],
    },
  ])

  const summary = await orch.run()
  report.metrics = {
    run_status: summary.status,
    done_tasks: summary.doneTasks,
    escalated: summary.escalatedTasks,
    approvals: summary.pendingApprovals.length,
    tokens: store.getMission('M-BAKE-XVENDOR')?.spent_tokens ?? 0,
    wall_clock_s: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
  }
  report.status = summary.status === 'awaiting_approval' ? 'done' : summary.status
  if (summary.pendingApprovals.length > 0) {
    const approval = store.getApproval(summary.pendingApprovals[0])
    report.approval = approval ? { id: approval.id, status: approval.status, summary: approval.patch.summary } : null
  }
  store.close()
  console.log('[bakeoff-xvendor]', JSON.stringify(report, null, 2))
}

main()
  .catch((error) => {
    report.status = 'failed'
    report.notes.push('exception: ' + (error instanceof Error ? error.message : String(error)))
    console.error('[bakeoff-xvendor] ERROR:', error instanceof Error ? error.message : error)
  })
  .finally(() => {
    writeFileSync(join(reportsDir, runId + '.json'), JSON.stringify(report, null, 2), 'utf8')
  })
