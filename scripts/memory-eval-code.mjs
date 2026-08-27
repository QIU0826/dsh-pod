/**
 * 记忆收益写码型验收 —— 方案书 2.8.1 验收条款（258 行）「工具型任务（实现+测试）的记忆收益待 claude 后端另验」补齐。
 *
 * 方法（claude 后端可用后）：
 *   同一写码任务模板跑两组：
 *     - 记忆组：prompt 注入「团队沉淀经验」（repo 风格/测试约定/commit 规范）→ 直接套用，少探索
 *     - 基线组：无记忆，同一任务（换一个等价函数避免记忆泄露）
 *   指标：任务完成（done）/ 测试真实通过 / wall-clock / tokens。
 *
 * 用法（先 build）：node scripts/memory-eval-code.mjs
 * 需要 claude 后端可用（~/.claude/settings.json 的 DeepSeek 配置）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudeHeadlessBackend, buildTaskPrompt } from '../dist/workers/claude-headless.js'
import { repairPath } from '../dist/workers/preflight.js'

repairPath()

const REPO = join(process.cwd(), '..', 'pod-demo-repo')
if (!existsSync(join(REPO, '.git'))) { console.error('not a git repo:', REPO); process.exit(2) }

// 团队沉淀经验（模拟主动策展记忆，内容对模型不可预知 = 只有进过仓库才知道）
const PROJECT_MEMORY = [
  'src/util.ts 已有 multiply/divide/subtract 三个纯函数，全部 export function 风格、无内部依赖、无第三方 import。',
  '测试用 Node 内置 node:test（不需装依赖），测试文件放 tests/ 目录，命名 <fn>.test.ts，import 用 "../src/util.ts"，断言用 node:assert/strict。',
  '每个新函数必须在 example.md 末尾补一段用法示例（含 import 与调用）。',
  'git commit message 必须含 "task-T-1"；测试跑通后才 commit；报告输出 MISSION_REPORT（schema 附录 C）。',
].join('\n')

function makeTaskSpec(fn, expr1, expr2) {
  return (
    '在 src/util.ts 新增并导出函数 ' + fn + '(a: number, b: number): number（纯函数），' +
    '并在 example.md 补充 ' + fn + ' 用法示例，新增对应测试（断言 ' + expr1 + ' 与 ' + expr2 + '），' +
    '运行测试通过后 git commit（message 含 task-T-1）并输出 MISSION_REPORT。'
  )
}

// 多对同构任务：记忆组(fnA) / 基线组(fnB) —— 换函数避免记忆泄露（记忆是项目风格经验，非具体实现）
const PAIRS = [
  { memory: { fn: 'mod', expr1: 'mod(10,3)=1', expr2: 'mod(7,3)=1' }, baseline: { fn: 'pow', expr1: 'pow(2,3)=8', expr2: 'pow(3,2)=9' } },
  { memory: { fn: 'min2', expr1: 'min2(3,5)=3', expr2: 'min2(9,2)=2' }, baseline: { fn: 'max2', expr1: 'max2(3,5)=5', expr2: 'max2(9,2)=9' } },
  { memory: { fn: 'gcd', expr1: 'gcd(12,18)=6', expr2: 'gcd(7,13)=1' }, baseline: { fn: 'lcm', expr1: 'lcm(4,6)=12', expr2: 'lcm(3,5)=15' } },
  { memory: { fn: 'absVal', expr1: 'absVal(-5)=5', expr2: 'absVal(3)=3' }, baseline: { fn: 'floorInt', expr1: 'floorInt(3.7)=3', expr2: 'floorInt(-2.1)=-3' } },
]

const startedAt = Date.now()
const reportsDir = join('reports', 'memory-eval-code')
mkdirSync(reportsDir, { recursive: true })

async function runWrite(taskLabel, spec, injectMemory) {
  const runId = taskLabel + '-' + Date.now()
  const worktreePath = join(REPO, '.pod-worktrees', 'memeval-' + runId)
  execFileSync('git', ['-C', REPO, 'worktree', 'add', worktreePath, '-b', 'memeval-' + runId], { stdio: 'pipe' })

  const backend = new ClaudeHeadlessBackend({
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    taskTimeoutMs: 20 * 60_000,
  })
  const slot = {
    id: 'S-1', mission_id: 'M-MEM', vendor: 'claude', role: 'implementer',
    capabilities: ['编码', '测试'], model: 'deepseek-v4-pro', effort: 'medium',
    session_tier: 'transient', status: 'idle', tokens_in: 0, tokens_out: 0,
    ctx_usage_pct: 0, window_tokens: 200_000,
  }
  const taskDef = {
    id: 'T-1', mission_id: 'M-MEM', title: taskLabel, spec,
    skill_tags: ['编码', '测试'], type: 'implement', depends_on: [], status: 'running',
    attempts: 0, soft_attempts: 0, max_wall_clock_ms: 20 * 60_000, created_at: Date.now(), updated_at: Date.now(),
  }

  // 记忆注入：把团队经验附加进 spec（真实写码时记忆浮入上下文的等价物）
  const effectiveSpec = injectMemory ? spec + '\n\n[团队沉淀的经验（参考，可加速你的实现）]\n' + PROJECT_MEMORY : spec

  const t0 = Date.now()
  const completion = await new Promise((resolve) => {
    buildTaskPrompt({ task: taskDef, worktreePath })
    backend
      .start(slot, { ...taskDef, spec: effectiveSpec }, worktreePath, { onExit: resolve })
      .catch((error) => resolve({ exit: 'failed', fault: 'crash', usage: { tokens_in: 0, tokens_out: 0, source: 'measured' }, artifacts: [], error: String(error) }))
  })
  const wall = Number(((Date.now() - t0) / 1000).toFixed(1))
  return {
    exit: completion.exit,
    test_result: completion.report?.test_result ?? 'no_report',
    commit_sha: completion.report?.commit_sha ?? null,
    tokens_in: completion.usage.tokens_in,
    tokens_out: completion.usage.tokens_out,
    wall_clock_s: wall,
    done: completion.exit === 'done' && completion.report?.status === 'done',
  }
}

async function main() {
  // 分片支持（规避超时）：ME_START/ME_END 按索引跑 PAIRS 子集；缺省全跑
  const start = Number(process.env.ME_START ?? 0)
  const end = Number(process.env.ME_END ?? PAIRS.length)
  const slice = PAIRS.slice(start, end)
  const results = []
  for (const pair of slice) {
    const memSpec = makeTaskSpec(pair.memory.fn, pair.memory.expr1, pair.memory.expr2)
    const memRes = await runWrite('memory-' + pair.memory.fn, memSpec, true)
    const baseSpec = makeTaskSpec(pair.baseline.fn, pair.baseline.expr1, pair.baseline.expr2)
    const baseRes = await runWrite('baseline-' + pair.baseline.fn, baseSpec, false)
    results.push({ memory: memRes, baseline: baseRes })
    console.log('[memory-eval-code] pair done:', JSON.stringify({ memory: { done: memRes.done, wall: memRes.wall_clock_s, tokens: memRes.tokens_in + memRes.tokens_out }, baseline: { done: baseRes.done, wall: baseRes.wall_clock_s, tokens: baseRes.tokens_in + baseRes.tokens_out } }))
    // 增量持久化：每对完成即写盘（超时/中断不丢已完成对）
    writeFileSync(join(reportsDir, 'partial-' + start + '-' + end + '.json'), JSON.stringify({ run_at: new Date().toISOString(), completed: results.length, results }, null, 2), 'utf8')
  }

  // 逐对明细 + 汇总（仅统计都完成的对；正 delta = 基线组更慢 = 记忆组更优）
  const perPair = slice.map((p, i) => ({
    memory_fn: p.memory.fn,
    baseline_fn: p.baseline.fn,
    memory: { done: results[i].memory.done, wall_s: results[i].memory.wall_clock_s, tokens: results[i].memory.tokens_in + results[i].memory.tokens_out },
    baseline: { done: results[i].baseline.done, wall_s: results[i].baseline.wall_clock_s, tokens: results[i].baseline.tokens_in + results[i].baseline.tokens_out },
    wall_delta_s: Number((results[i].baseline.wall_clock_s - results[i].memory.wall_clock_s).toFixed(1)),
    token_delta: (results[i].baseline.tokens_in + results[i].baseline.tokens_out) - (results[i].memory.tokens_in + results[i].memory.tokens_out),
  }))
  const bothDone = results.filter((r) => r.memory.done && r.baseline.done)
  const wallDelta = bothDone.map((r) => r.baseline.wall_clock_s - r.memory.wall_clock_s)
  const tokenDelta = bothDone.map((r) => (r.baseline.tokens_in + r.baseline.tokens_out) - (r.memory.tokens_in + r.memory.tokens_out))
  const wallWins = perPair.filter((p) => p.wall_delta_s > 0).length
  const tokenWins = perPair.filter((p) => p.token_delta > 0).length
  const summary = {
    run_at: new Date().toISOString(),
    model: 'deepseek-v4-pro (claude headless, DeepSeek 配置)',
    method: '记忆组(注入团队沉淀经验) vs 基线组(无记忆) 写码任务对比（同构任务，换函数防泄露）',
    pairs: perPair,
    metrics: {
      pairs: perPair.length,
      memory_done: results.filter((r) => r.memory.done).length + '/' + results.length,
      baseline_done: results.filter((r) => r.baseline.done).length + '/' + results.length,
      both_done: bothDone.length + '/' + results.length,
      avg_wall_delta_s: bothDone.length > 0 ? Number((wallDelta.reduce((a, b) => a + b, 0) / wallDelta.length).toFixed(1)) : null,
      avg_token_delta: bothDone.length > 0 ? Math.round(tokenDelta.reduce((a, b) => a + b, 0) / tokenDelta.length) : null,
      wall_memory_wins: wallWins,
      token_memory_wins: tokenWins,
    },
    notes: [
      '写码型记忆收益验收（补齐 258 行「工具型任务待 claude 后端另验」）；claude 后端真实写码（DeepSeek 配置）',
      '同构任务换函数（mod/pow）防记忆内容直接泄露给基线组；记忆注入的是项目风格经验（测试约定/目录/commit 规范）',
      'usage 来自 claude -p 实测（usage_audit 能力位）；NOOA +11.8 是配对基准不可直接移植（CR-07-4）',
    ],
  }
  writeFileSync(join(reportsDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')
  console.log('[memory-eval-code] written reports/memory-eval-code/summary.json')
  console.log('[memory-eval-code] metrics:', JSON.stringify(summary.metrics))
}

main()
  .then(() => console.log('[memory-eval-code] done'))
  .catch((e) => { console.error('[memory-eval-code] ERROR:', e instanceof Error ? e.message : e); process.exit(1) })
