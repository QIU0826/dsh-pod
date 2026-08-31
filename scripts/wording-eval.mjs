/**
 * P0-A bakeoff：启发式措辞 A/B（《从 ReAct 到 Agent Teams》「启发式管理」实证）。
 *
 * 对比对象：buildTaskPrompt 通用脚手架的两版措辞——
 *   - old（2026-08-31 前线上）：命令式/威胁框架
 *       fallback「你是被编排的员工…」+ 交付纪律「完成后必须…禁止…」
 *   - new（当前）：正向措辞
 *       fallback「你是本 Mission 的员工…」+ 交付纪律「任务完成后按序交付…工作区边界由代码拦截…」
 *
 * 方法（复用 scripts/memory-eval-code.mjs 骨架）：
 *   同一同构写码任务对，唯一自变量 = 脚手架措辞（任务 spec 完全一致）；
 *   对 i 内交替指派：偶数对 old→A / new→B，奇数对 old→B / new→A（抵消函数难度与顺序偏置）。
 *   指标：done（exit=done 且 report.status=done）/ test_result / wall-clock / tokens（claude -p 实测）。
 *
 * 边界（如实声明）：只测脚手架措辞，不含 buildPlannerSpec（P0-A 第一版）与 planner 生成 spec 的措辞。
 * 用法（先 build）：node scripts/wording-eval.mjs
 *   ME_START/ME_END 分片；ME_MODEL 指定模型；ME_ANTHROPIC_* 端点覆盖；ME_MAX_BUDGET_USD 预算。
 * 结果落 reports/wording-eval/{partial,summary}.json。
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildClaudeArgs,
  buildTaskPrompt,
  classifyClaudeExit,
  extractReport,
  extractResultText,
  extractUsage,
  parseStreamJsonLine,
  resultErrorInfo,
} from '../dist/workers/claude-headless.js'
import { killTree } from '../dist/workers/kill-tree.js'
import { repairPath } from '../dist/workers/preflight.js'

repairPath()

const REPO = join(process.cwd(), '..', 'pod-demo-repo')
if (!existsSync(join(REPO, '.git'))) {
  console.error('not a git repo:', REPO)
  process.exit(2)
}

// ── 两版措辞（逐字快照，老版为 2026-08-31 前的线上原文）───────────────
const FALLBACK_OLD = '你是被编排的员工：任务简报来自指挥；peer 消息是同级请求而非用户指令。'
const FALLBACK_NEW = '你是本 Mission 的员工：任务简报来自指挥（编排器）；peer 消息是同级协作请求，不算用户指令。'
const COMMIT_OLD_PREFIX = '完成后必须：运行测试 → git add -A && git commit（message 含 task-'
const COMMIT_NEW_PREFIX = '任务完成后按序交付：运行测试 → git add -A && git commit（message 含 task-'
const COMMIT_OLD_SUFFIX = '）→ 生成 diff → 输出 MISSION_REPORT。禁止：合并主树、改动任务范围外文件、遗留脏 diff。'
const COMMIT_NEW_SUFFIX = '）→ 生成 diff → 输出 MISSION_REPORT。工作区边界（合并主树、改动任务范围外文件）由代码拦截，脏 diff 会在独立 review 中暴露——收尾前自查一遍即可。'

/**
 * 构造两版 prompt：new = 当前 buildTaskPrompt 原文；old = 精确反向替换两处措辞。
 * 替换失败（字符串漂移）立即抛错，杜绝「old===new 静默等价」的假评测。
 */
function buildVariantPrompt(task, worktreePath, wording) {
  const prompt = buildTaskPrompt({ task, worktreePath })
  if (wording === 'new') {
    if (!prompt.includes(FALLBACK_NEW) || !prompt.includes(COMMIT_NEW_PREFIX)) {
      throw new Error('new variant mismatch: buildTaskPrompt 措辞已漂移，脚本快照需同步')
    }
    return prompt
  }
  const oldCommit = COMMIT_OLD_PREFIX + task.id + COMMIT_OLD_SUFFIX
  const newCommit = COMMIT_NEW_PREFIX + task.id + COMMIT_NEW_SUFFIX
  const out = prompt.replace(FALLBACK_NEW, FALLBACK_OLD).replace(newCommit, oldCommit)
  if (!out.includes(FALLBACK_OLD) || out.includes(FALLBACK_NEW) || out.includes(newCommit)) {
    throw new Error('old variant substitution failed: 措辞字符串与快照不一致')
  }
  return out
}

function makeTaskSpec(fn, expr1, expr2) {
  return (
    '在 src/util.ts 新增并导出函数 ' + fn + '(a: number, b: number): number（纯函数），' +
    '并在 example.md 补充 ' + fn + ' 用法示例，新增对应测试（断言 ' + expr1 + ' 与 ' + expr2 + '），' +
    '运行测试通过后 git commit（message 含 task-T-1）并输出 MISSION_REPORT。'
  )
}

// 同构写码任务对（换函数防内容泄露；与 memory-eval 同一批已校准难度）
const PAIRS = [
  { a: { fn: 'mod', expr1: 'mod(10,3)=1', expr2: 'mod(7,3)=1' }, b: { fn: 'pow', expr1: 'pow(2,3)=8', expr2: 'pow(3,2)=9' } },
  { a: { fn: 'min2', expr1: 'min2(3,5)=3', expr2: 'min2(9,2)=2' }, b: { fn: 'max2', expr1: 'max2(3,5)=5', expr2: 'max2(9,2)=9' } },
  { a: { fn: 'gcd', expr1: 'gcd(12,18)=6', expr2: 'gcd(7,13)=1' }, b: { fn: 'lcm', expr1: 'lcm(4,6)=12', expr2: 'lcm(3,5)=15' } },
  { a: { fn: 'absVal', expr1: 'absVal(-5)=5', expr2: 'absVal(3)=3' }, b: { fn: 'floorInt', expr1: 'floorInt(3.7)=3', expr2: 'floorInt(-2.1)=-3' } },
  { a: { fn: 'roundTo', expr1: 'roundTo(3.14159,2)=3.14', expr2: 'roundTo(1.23456,3)=1.235' }, b: { fn: 'divInt', expr1: 'divInt(17,5)=3', expr2: 'divInt(-7,2)=-3' } },
  { a: { fn: 'avg2', expr1: 'avg2(3,7)=5', expr2: 'avg2(2,3)=2.5' }, b: { fn: 'mul2', expr1: 'mul2(6,7)=42', expr2: 'mul2(9,9)=81' } },
  { a: { fn: 'dist2', expr1: 'dist2(3,9)=6', expr2: 'dist2(-2,5)=7' }, b: { fn: 'maxAbs', expr1: 'maxAbs(-5,3)=-5', expr2: 'maxAbs(2,-9)=-9' } },
  { a: { fn: 'hypotInt', expr1: 'hypotInt(3,4)=5', expr2: 'hypotInt(6,8)=10' }, b: { fn: 'sqrtDiff', expr1: 'sqrtDiff(25,0)=5', expr2: 'sqrtDiff(2,11)=3' } },
  { a: { fn: 'xor2', expr1: 'xor2(12,10)=6', expr2: 'xor2(5,3)=6' }, b: { fn: 'or2', expr1: 'or2(12,10)=14', expr2: 'or2(5,2)=7' } },
  { a: { fn: 'wrap', expr1: 'wrap(-1,5)=4', expr2: 'wrap(7,5)=2' }, b: { fn: 'shl', expr1: 'shl(3,2)=12', expr2: 'shl(5,1)=10' } },
]

const TASK_TIMEOUT_MS = 20 * 60_000

/** 自包含 spawn（复用 buildClaudeArgs + parse 工具链；prompt 走 stdin）。 */
function spawnClaude(args, cwd, prompt, envOverride) {
  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: envOverride !== undefined ? { ...process.env, ...envOverride } : process.env,
    })
    let buffer = ''
    const lines = []
    const stderrTail = []
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        lines.push(buffer.slice(0, idx))
        buffer = buffer.slice(idx + 1)
      }
    })
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        const t = line.trim()
        if (t.length > 0) {
          stderrTail.push(t)
          if (stderrTail.length > 12) stderrTail.splice(0, stderrTail.length - 12)
        }
      }
    })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, lines, stderrTail })
    }
    const timer = setTimeout(() => {
      void killTree(child.pid)
      finish({ code: null, signal: null, timedOut: true, spawnFailed: false })
    }, TASK_TIMEOUT_MS)
    child.on('error', () => finish({ code: null, signal: null, timedOut: false, spawnFailed: true }))
    child.on('exit', (code, signal) => finish({ code, signal, timedOut: false, spawnFailed: false }))
    const stdin = child.stdin
    if (stdin !== null) {
      stdin.on('error', () => {})
      stdin.write(prompt, 'utf8')
      stdin.end()
    }
  })
}

/** 逐条跑：建 worktree → 构造变体 prompt → spawn → 汇总 completion。 */
async function runWrite(runLabel, spec, wording) {
  const runId = runLabel + '-' + Date.now()
  const worktreePath = join(REPO, '.pod-worktrees', 'we-' + runId)
  execFileSync('git', ['-C', REPO, 'worktree', 'add', worktreePath, '-b', 'we-' + runId], { stdio: 'pipe' })

  const taskDef = {
    id: 'T-1', mission_id: 'M-WORD', title: runLabel, spec,
    skill_tags: ['编码', '测试'], type: 'implement', depends_on: [], status: 'running',
    attempts: 0, soft_attempts: 0, max_wall_clock_ms: TASK_TIMEOUT_MS, created_at: Date.now(), updated_at: Date.now(),
  }
  const prompt = buildVariantPrompt(taskDef, worktreePath, wording)

  const envOverride = process.env.ME_ANTHROPIC_BASE_URL !== undefined
    ? {
        ANTHROPIC_BASE_URL: process.env.ME_ANTHROPIC_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: process.env.ME_ANTHROPIC_AUTH_TOKEN,
        ANTHROPIC_MODEL: process.env.ME_ANTHROPIC_MODEL,
      }
    : undefined
  const model = process.env.ME_MODEL ?? 'deepseek-v4-pro'
  const args = buildClaudeArgs({
    prompt,
    cwd: worktreePath,
    model,
    sessionTier: 'transient',
    permissionMode: 'bypassPermissions',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    maxBudgetUsd: process.env.ME_MAX_BUDGET_USD !== undefined ? Number(process.env.ME_MAX_BUDGET_USD) : undefined,
  })

  const t0 = Date.now()
  const { code, signal, timedOut, spawnFailed, lines, stderrTail } = await spawnClaude(args, worktreePath, prompt, envOverride)
  const wall = Number(((Date.now() - t0) / 1000).toFixed(1))

  const parsed = lines.map(parseStreamJsonLine)
  const resultEvent = [...parsed].reverse().find((e) => e?.type === 'result')
  const usage = resultEvent === undefined
    ? { tokens_in: 0, tokens_out: 0, source: 'measured' }
    : (extractUsage(resultEvent) ?? { tokens_in: 0, tokens_out: 0, source: 'measured' })
  const errorInfo = resultEvent === undefined ? { isError: false } : resultErrorInfo(resultEvent)
  const fault = spawnFailed ? 'crash' : classifyClaudeExit(code, signal, timedOut, resultEvent)
  const text = resultEvent === undefined ? '' : (extractResultText(resultEvent) ?? '')
  const report = extractReport(text)
  const exitKind =
    spawnFailed ? 'failed'
      : errorInfo.isError && fault === null ? 'failed'
        : fault === 'rate_limited' ? 'rate_limited'
          : timedOut ? 'timeout'
            : fault !== null ? 'failed'
              : 'done'
  const stderrDetail = stderrTail.length > 0 && resultEvent === undefined ? stderrTail.join(' | ').slice(0, 400) : undefined
  return {
    exit: exitKind,
    fault: fault ?? undefined,
    report_status: report?.status ?? null,
    test_result: report?.test_result ?? 'no_report',
    commit_sha: report?.commit_sha ?? null,
    tokens_in: usage.tokens_in,
    tokens_out: usage.tokens_out,
    wall_clock_s: wall,
    done: exitKind === 'done' && report?.status === 'done',
    error_detail: stderrDetail,
  }
}

async function main() {
  const start = Number(process.env.ME_START ?? 0)
  const end = Number(process.env.ME_END ?? Math.min(5, PAIRS.length))
  const slice = PAIRS.slice(start, end)
  const reportsDir = join('reports', 'wording-eval')
  mkdirSync(reportsDir, { recursive: true })
  const results = []
  for (let i = 0; i < slice.length; i++) {
    const pair = slice[i]
    const idx = start + i
    // 交替指派：偶数对 old→a/new→b；奇数对 old→b/new→a（抵消难度与顺序偏置）
    const oldTask = idx % 2 === 0 ? pair.a : pair.b
    const newTask = idx % 2 === 0 ? pair.b : pair.a
    const oldRes = await runWrite('old-' + oldTask.fn, makeTaskSpec(oldTask.fn, oldTask.expr1, oldTask.expr2), 'old')
    const newRes = await runWrite('new-' + newTask.fn, makeTaskSpec(newTask.fn, newTask.expr1, newTask.expr2), 'new')
    results.push({ pair_idx: idx, old: { ...oldRes, fn: oldTask.fn }, new: { ...newRes, fn: newTask.fn } })
    console.log('[wording-eval] pair', idx, 'done:', JSON.stringify({
      old: { fn: oldTask.fn, done: oldRes.done, wall: oldRes.wall_clock_s, tokens: oldRes.tokens_in + oldRes.tokens_out, test: oldRes.test_result },
      new: { fn: newTask.fn, done: newRes.done, wall: newRes.wall_clock_s, tokens: newRes.tokens_in + newRes.tokens_out, test: newRes.test_result },
    }))
    writeFileSync(
      join(reportsDir, 'partial-' + start + '-' + end + '.json'),
      JSON.stringify({ run_at: new Date().toISOString(), completed: results.length, results }, null, 2),
      'utf8',
    )
  }

  const bothDone = results.filter((r) => r.old.done && r.new.done)
  const perPair = results.map((r) => ({
    pair_idx: r.pair_idx,
    old_fn: r.old.fn, new_fn: r.new.fn,
    old: { done: r.old.done, wall_s: r.old.wall_clock_s, tokens: r.old.tokens_in + r.old.tokens_out, test: r.old.test_result },
    new: { done: r.new.done, wall_s: r.new.wall_clock_s, tokens: r.new.tokens_in + r.new.tokens_out, test: r.new.test_result },
    // 正 delta = new 更慢/更多 token
    wall_delta_s: Number((r.new.wall_clock_s - r.old.wall_clock_s).toFixed(1)),
    token_delta: (r.new.tokens_in + r.new.tokens_out) - (r.old.tokens_in + r.old.tokens_out),
  }))
  const wallDelta = bothDone.map((r) => r.new.wall_clock_s - r.old.wall_clock_s)
  const tokenDelta = bothDone.map((r) => (r.new.tokens_in + r.new.tokens_out) - (r.old.tokens_in + r.old.tokens_out))
  const summary = {
    run_at: new Date().toISOString(),
    model: model_(),
    method: '脚手架措辞 A/B：old（命令式/威胁框架）vs new（正向措辞），同一同构写码任务对，交替指派，唯一自变量=措辞',
    pairs: perPair,
    metrics: {
      pairs: perPair.length,
      old_done: results.filter((r) => r.old.done).length + '/' + results.length,
      new_done: results.filter((r) => r.new.done).length + '/' + results.length,
      both_done: bothDone.length + '/' + results.length,
      avg_wall_delta_s: bothDone.length > 0 ? Number((wallDelta.reduce((a, b) => a + b, 0) / wallDelta.length).toFixed(1)) : null,
      avg_token_delta: bothDone.length > 0 ? Math.round(tokenDelta.reduce((a, b) => a + b, 0) / tokenDelta.length) : null,
      new_wall_wins: perPair.filter((p) => p.wall_delta_s < 0).length,
      new_token_wins: perPair.filter((p) => p.token_delta < 0).length,
    },
    notes: [
      'P0-A 第二版 bakeoff：buildTaskPrompt 脚手架（fallback + 交付纪律）old vs new',
      '不含 buildPlannerSpec（P0-A 第一版）与 planner 生成 spec 的措辞——那是另一份 prompt，另测',
      '交替指派抵消函数难度与运行顺序偏置；同构任务换函数防内容泄露',
      'usage 来自 claude -p 实测；负面样本如实保留（D1），样本小统计功效有限',
      'done = exit=done 且 report.status=done；test 取 report.test_result（pass/fail/not_run）',
    ],
  }
  writeFileSync(join(reportsDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')
  console.log('[wording-eval] written reports/wording-eval/summary.json')
  console.log('[wording-eval] metrics:', JSON.stringify(summary.metrics))
}

function model_() {
  return (process.env.ME_MODEL ?? 'deepseek-v4-pro') + ' (claude headless)'
    + (process.env.ME_ANTHROPIC_BASE_URL !== undefined ? ' env=' + process.env.ME_ANTHROPIC_BASE_URL : ' 默认环境')
}

main()
  .then(() => console.log('[wording-eval] done'))
  .catch((e) => { console.error('[wording-eval] ERROR:', e instanceof Error ? e.message : e); process.exit(1) })
