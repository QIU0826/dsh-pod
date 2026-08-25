/**
 * Bake-off 全量批次驱动（W6 / DoD-10）：
 *   5 任务 × baseline/pod 两条件 = 10 次运行，串行执行避免 API 429 限流。
 *   复用 reports/bakeoff 中已 done 的正式结果（按 taskId-condition 前缀匹配）。
 * 用法：node scripts/bakeoff-all.mjs
 * 产物：reports/bakeoff/<runId>.json + .progress.log + all-summary.json + all-progress.log
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REPORTS = join('reports', 'bakeoff')
mkdirSync(REPORTS, { recursive: true })

const TASKS = JSON.parse(readFileSync(join('tasks', 'bakeoff-tasks.json'), 'utf8'))
const TASK_IDS = Object.keys(TASKS) // [small-1, small-2, medium-1, medium-2, long-1]
const CONDITIONS = ['baseline', 'pod']

const summary = {
  started_at: new Date().toISOString(),
  runs: [],
  totals: { planned: 0, reused: 0, ran: 0, done: 0, failed: 0 },
}

function hasDoneResult(taskId, condition) {
  // runId = <taskId>-<condition>-<ts>；按前缀匹配 status=done 的正式报告
  for (const f of existsSync(REPORTS) ? readdirSyncSorted(REPORTS) : []) {
    if (!f.endsWith('.json')) continue
    if (!f.startsWith(`${taskId}-${condition}-`)) continue
    try {
      const r = JSON.parse(readFileSync(join(REPORTS, f), 'utf8'))
      if (r.status === 'done') return { run_id: r.run_id, file: f }
    } catch {
      /* 损坏报告不视为已存在 */
    }
  }
  return null
}

function readdirSyncSorted(dir) {
  return readdirSync(dir).sort()
}

function log(line) {
  const ts = new Date().toISOString()
  appendFileSync(join(REPORTS, 'all-progress.log'), `[${ts}] ${line}\n`)
  console.log(`[bakeoff-all] ${line}`)
}

for (const condition of CONDITIONS) {
  for (const taskId of TASK_IDS) {
    summary.totals.planned += 1
    const reused = hasDoneResult(taskId, condition)
    if (reused) {
      summary.runs.push({ task_id: taskId, condition, status: 'reused', run_id: reused.run_id })
      summary.totals.reused += 1
      log(`reuse ${taskId}-${condition} <- ${reused.run_id}`)
      continue
    }
    log(`start ${taskId}-${condition} (worktree isolated, serial)`)
    const t0 = Date.now()
    const res = spawnSync(
      process.execPath,
      ['scripts/bakeoff-run.mjs', '--task', taskId, '--condition', condition],
      { encoding: 'utf8', timeout: 90 * 60_000 }, // 单轮上限 90 分钟
    )
    const wall = ((Date.now() - t0) / 1000).toFixed(1)
    if (res.status === 0 && res.stdout.includes('"status": "done"')) {
      summary.runs.push({ task_id: taskId, condition, status: 'done', wall_s: Number(wall) })
      summary.totals.done += 1
      log(`done ${taskId}-${condition} in ${wall}s`)
    } else {
      // 收集 runner 写入的报告（含 failed 样本，纪律：不选择性过滤）
      const fresh = findLatestReport(taskId, condition)
      summary.runs.push({
        task_id: taskId,
        condition,
        status: 'failed',
        wall_s: Number(wall),
        exit_code: res.status,
        report: fresh ? fresh.run_id : null,
        stderr_tail: (res.stderr ?? '').split('\n').slice(-3).join(' '),
      })
      summary.totals.failed += 1
      log(`FAIL ${taskId}-${condition} in ${wall}s (exit ${res.status})`)
    }
  }
}

function findLatestReport(taskId, condition) {
  const matches = readdirSyncSorted(REPORTS)
    .filter((f) => f.endsWith('.json') && f.startsWith(`${taskId}-${condition}-`))
    .sort()
  if (matches.length === 0) return null
  const f = matches[matches.length - 1]
  try {
    return { run_id: JSON.parse(readFileSync(join(REPORTS, f), 'utf8')).run_id, file: f }
  } catch {
    return null
  }
}

summary.finished_at = new Date().toISOString()
writeFileSync(join(REPORTS, 'all-summary.json'), JSON.stringify(summary, null, 2), 'utf8')
log(`finished: ${summary.totals.done} done / ${summary.totals.failed} failed / ${summary.totals.reused} reused of ${summary.totals.planned}`)
console.log('[bakeoff-all] SUMMARY', JSON.stringify(summary.totals))
