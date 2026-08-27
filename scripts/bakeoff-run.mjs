/**
 * DSH-Pod Bake-off 运行器 —— 方案书 1.6 节（有效性自证，硬性 DoD-10）。
 *
 * 用法：node scripts/bakeoff-run.mjs --task <id> --condition baseline|pod [--repo <dir>]
 * 条件：
 *   baseline —— 最强单员工（claude）独立完成全程（实现+测试+commit+报告）
 *   pod      —— claude 实现 + codex 独立 review（质量门）全链
 * 指标四维：功能正确性（test_result）/ 审查结论（pod 条件）/ wall-clock / tokens 实测。
 * 纪律：失败样本完整留存（报告 JSON + 进度日志），禁止选择性过滤（D1/1.6 节）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JsonStore } from '../dist/core/store.js'
import { MissionOrchestrator } from '../dist/core/orchestrator.js'
import { verifyTaskArtifacts, execGitClient } from '../dist/core/verifier.js'
import { ClaudeHeadlessBackend, buildTaskPrompt } from '../dist/workers/claude-headless.js'
import { CodexHeadlessBackend, codexBinaryCandidates } from '../dist/workers/codex-headless.js'
import { repairPath } from '../dist/workers/preflight.js'

repairPath()

const args = Object.fromEntries(
  process.argv
    .map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null))
    .filter(Boolean),
)
const condition = args.condition ?? 'baseline'
const taskId = args.task ?? 'small-1'

const TASKS = JSON.parse(readFileSync(join('tasks', 'bakeoff-tasks.json'), 'utf8'))
const task = TASKS[taskId]
if (task === undefined) {
  console.error('unknown task:', taskId, 'candidates:', Object.keys(TASKS).join(', '))
  process.exit(2)
}
const repo = args.repo ?? task.repo
if (!existsSync(join(repo, '.git'))) {
  console.error('not a git repo:', repo)
  process.exit(2)
}

const reportsDir = join('reports', 'bakeoff')
mkdirSync(reportsDir, { recursive: true })
const runId = `${taskId}-${condition}-${Date.now()}`

// 每轮独立 worktree（隔离 + 可复现；轮次结束保留供检查）
const worktreePath = join(repo, '.pod-worktrees', `bakeoff-${runId}`)
execFileSync('git', ['-C', repo, 'worktree', 'add', worktreePath, '-b', `bakeoff-${runId}`], { stdio: 'pipe' })

const startedAt = Date.now()
const progress = []
// DoD-15：每条 run 记录后端版本（worker_version），可复现/可追溯（CR-08 Berd-A）
function workerVersions() {
  const v = {}
  try { v.claude = execFileSync('claude --version', { encoding: 'utf8', shell: process.platform === 'win32' }).trim().split('\n')[0] ?? null } catch { v.claude = null }
  const codexBin = codexBinaryCandidates('win32').find((c) => existsSync(c)) ?? 'codex'
  try { v.codex = execFileSync(codexBin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim().split('\n')[0] ?? null } catch { v.codex = null }
  return v
}
const report = {
  run_id: runId,
  task_id: taskId,
  condition,
  repo,
  started_at: new Date(startedAt).toISOString(),
  model_implementer: 'deepseek-v4-pro',
  worker_version: workerVersions(),
  metrics: {},
  status: 'running',
  notes: [],
}

async function main() {
  try {
    if (condition === 'baseline') {
      // 任务超时 = est_minutes 上浮 50% + 5 分钟缓冲（长任务如 SQLite 需远超默认 15 分钟）
      const estMin = task.est_minutes ?? 30
      const taskTimeoutMs = (estMin * 60 + 5 * 60) * 1000
      const backend = new ClaudeHeadlessBackend({
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        taskTimeoutMs,
      })
      const slot = {
        id: 'S-1', mission_id: 'M-BAKE', vendor: 'claude', role: 'implementer',
        capabilities: ['编码'], model: 'deepseek-v4-pro', effort: 'medium',
        session_tier: 'transient', status: 'idle', tokens_in: 0, tokens_out: 0,
        ctx_usage_pct: 0, window_tokens: 200_000,
      }
      const taskDef = {
        id: 'T-1', mission_id: 'M-BAKE', title: task.title, spec: task.spec,
        skill_tags: task.skill_tags ?? [], type: 'implement', depends_on: [], status: 'running',
        attempts: 0, soft_attempts: 0, max_wall_clock_ms: 3600_000, created_at: startedAt, updated_at: startedAt,
      }
      const completion = await new Promise((resolve) => {
        buildTaskPrompt({ task: taskDef, worktreePath }) // prompt 经后端 stdin 注入，此处仅预热构建
        backend
          .start(slot, taskDef, worktreePath, {
            onProgress: (e) => {
              if (e.kind === 'text' && e.text) progress.push(e.text)
              if (e.kind === 'tool_call') progress.push(`[tool] ${e.tool ?? ''}`)
            },
            onExit: resolve,
          })
          .catch((error) => {
            resolve({
              exit: 'failed',
              fault: 'crash',
              usage: { tokens_in: 0, tokens_out: 0, source: 'measured' },
              artifacts: [],
              error: String(error),
            })
          })
      })
      report.metrics = {
        exit: completion.exit,
        test_result: completion.report?.test_result ?? 'not_run',
        status: completion.report?.status ?? 'no_report',
        commit_sha: completion.report?.commit_sha ?? null,
        tokens_in: completion.usage.tokens_in,
        tokens_out: completion.usage.tokens_out,
        wall_clock_s: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      }
      report.status = completion.exit === 'done' && completion.report?.status === 'done' ? 'done' : 'failed'
    } else {
      // pod 条件：claude 实现 + codex 独立 review（复用编排器真实链路）
      const dataDir = join('reports', 'bakeoff', `store-${runId}`)
      mkdirSync(dataDir, { recursive: true })
      const store = new JsonStore({ rootDir: dataDir })
      store.open()
      const codexBin = codexBinaryCandidates('win32').find((c) => existsSync(c)) ?? 'codex'
      const estMin = task.est_minutes ?? 30
      const taskTimeoutMs = (estMin * 60 + 5 * 60) * 1000
      const orch = new MissionOrchestrator('M-BAKE', {
        store,
        backends: {
          claude: new ClaudeHeadlessBackend({
            allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
            taskTimeoutMs,
          }),
          codex: new CodexHeadlessBackend({ binary: codexBin }),
        },
        worktree: {
          async ensure() {
            return worktreePath
          },
        },
        verify: async (t, r) => {
          const result = await verifyTaskArtifacts({ git: execGitClient(), repoDir: worktreePath }, t, r)
          if (!result.ok) {
            console.error('[bakeoff-verify] FAIL task=', t.id, 'failures=', JSON.stringify(result.failures))
            console.error('[bakeoff-verify] report=', JSON.stringify(r))
            console.error('[bakeoff-verify] worktree=', worktreePath)
          }
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
        name: `bakeoff-${runId}`,
        goal: task.spec,
        cwd: repo,
        budgetUsd: 5,
        slots: [
          // 实现者能力 = 任务标签全集（capabilitiesMatch 要求标签 ⊆ 能力；缺标签 → escalated）
          { id: 'S-1', vendor: 'claude', role: 'implementer', capabilities: [...new Set(task.skill_tags ?? [])], model: 'deepseek-v4-pro' },
          { id: 'S-2', vendor: 'codex', role: 'reviewer', capabilities: ['审查'], model: '' },
        ],
      })
      orch.createTasks([
        { id: 'T-1', title: task.title, spec: task.spec, type: 'implement', skill_tags: task.skill_tags ?? [] },
        { id: 'T-2', title: `独立 review ${task.title}`, spec: '按最小上下文审查 T-1 diff', type: 'review', skill_tags: ['审查'], depends_on: ['T-1'] },
      ])
      const summary = await orch.run()
      report.metrics = {
        run_status: summary.status,
        done_tasks: summary.doneTasks,
        escalated: summary.escalatedTasks,
        tokens: store.getMission('M-BAKE')?.spent_tokens ?? 0,
        wall_clock_s: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      }
      report.status = summary.status === 'awaiting_approval' ? 'done' : summary.status
      store.close()
    }
  } catch (error) {
    report.status = 'failed'
    report.notes.push(`exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  } finally {
    writeFileSync(join(reportsDir, `${runId}.json`), JSON.stringify(report, null, 2), 'utf8')
    writeFileSync(join(reportsDir, `${runId}.progress.log`), progress.join('\n'), 'utf8')
    console.log('[bakeoff]', JSON.stringify(report, null, 2))
  }
}

void main()
