/**
 * 汇总 memory-eval-code 全部批次 → summary-10pairs.json（CR-33 4 对 + CR-37 扩至 10 对）。
 * 数据源：reports/memory-eval-code/partial-<start>-<end>.json（每对完成即写盘，最新批次覆盖旧值）。
 * 分组统计：批 1（对 0-3，deepseek-v4-pro 直连）与批 2+（对 4-9，GLM-5.3-Flash 中转）
 * 端点不同如实分组——配对比较只在同批次内成立（D1 纪律：不混池粉饰）。
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = join('reports', 'memory-eval-code')
mkdirSync(dir, { recursive: true })

const PAIRS = [
  ['mod', 'pow'], ['min2', 'max2'], ['gcd', 'lcm'], ['absVal', 'floorInt'],
  ['roundTo', 'divInt'], ['avg2', 'mul2'], ['dist2', 'maxAbs'], ['hypotInt', 'sqrtDiff'],
  ['xor2', 'or2'], ['wrap', 'shl'],
]
// 批次分组：pairIndex → 批名（模型/端点如实标注）
function groupOf(pairIndex) {
  return pairIndex < 4 ? 'batch1-deepseek' : 'batch2-glm'
}

// 扫全部 partial 文件；同对多批次时取 mtime 最新的文件（最新环境重跑覆盖旧数据）
const files = readdirSync(dir)
  .filter((f) => f.startsWith('partial-') && f.endsWith('.json'))
  .map((f) => ({ f, mtime: readFileSync(join(dir, f)).mtimeMs }))
  .sort((a, b) => a.mtime - b.mtime)

const byPair = new Map()
// 对 0（mod/pow）只在旧 summary-4pairs.json（DeepSeek 批）有明细——预置为底，最新 partial 覆盖
const legacy4 = JSON.parse(readFileSync(join(dir, 'summary-4pairs.json'), 'utf8'))
for (const p of legacy4.pairs) {
  byPair.set(p.pair ?? PAIRS.findIndex((x) => x[0] === p.memory_fn), {
    data: { memory: { done: p.memory.done, wall_clock_s: p.memory.wall_s, tokens_in: p.memory.tokens, tokens_out: 0 }, baseline: { done: p.baseline.done, wall_clock_s: p.baseline.wall_s, tokens_in: p.baseline.tokens, tokens_out: 0 } },
    source: 'summary-4pairs.json',
  })
}
for (const { f } of files) {
  const m = f.match(/^partial-(\d+)-(\d+)\.json$/)
  if (m === null) continue
  const start = Number(m[1])
  const data = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  data.results.forEach((r, i) => {
    const pairIndex = start + i
    if (pairIndex >= PAIRS.length) return
    byPair.set(pairIndex, { data: r, source: f })
  })
}

const pairs = []
for (let i = 0; i < PAIRS.length; i++) {
  const entry = byPair.get(i)
  if (entry === undefined) {
    pairs.push({ pair: i, memory_fn: PAIRS[i][0], baseline_fn: PAIRS[i][1], status: '未跑（批次中断待补）' })
    continue
  }
  const { memory, baseline } = entry.data
  pairs.push({
    pair: i,
    memory_fn: PAIRS[i][0],
    baseline_fn: PAIRS[i][1],
    group: groupOf(i),
    source_partial: entry.source,
    memory: { done: memory.done, wall_s: memory.wall_clock_s, tokens: memory.tokens_in + memory.tokens_out },
    baseline: { done: baseline.done, wall_s: baseline.wall_clock_s, tokens: baseline.tokens_in + baseline.tokens_out },
    wall_delta_s: Number((baseline.wall_clock_s - memory.wall_clock_s).toFixed(1)),
    token_delta: baseline.tokens_in + baseline.tokens_out - (memory.tokens_in + memory.tokens_out),
  })
}

function stats(rows) {
  const both = rows.filter((p) => p.memory?.done && p.baseline?.done)
  const wall = both.map((p) => p.wall_delta_s)
  const tok = both.map((p) => p.token_delta)
  return {
    pairs: rows.length,
    both_done: both.length + '/' + rows.length,
    avg_wall_delta_s: wall.length > 0 ? Number((wall.reduce((a, b) => a + b, 0) / wall.length).toFixed(1)) : null,
    avg_token_delta: tok.length > 0 ? Math.round(tok.reduce((a, b) => a + b, 0) / tok.length) : null,
    wall_memory_wins: wall.filter((d) => d > 0).length,
    token_memory_wins: tok.filter((d) => d > 0).length,
  }
}

const summary = {
  run_at: new Date().toISOString(),
  method: '同构任务对配对比较：记忆组注入项目风格经验 vs 基线组无注入（换函数防泄露）；每对内部同模型同环境',
  model_groups: {
    'batch1-deepseek': 'deepseek-v4-pro（claude headless 直连官方端点）',
    'batch2-glm': 'GLM-5.3-Flash（ccswitch 中转端点；端点兼容性修复后重跑）',
  },
  pairs,
  metrics: {
    overall: stats(pairs.filter((p) => p.memory !== undefined)),
    batch1_deepseek: stats(pairs.filter((p) => p.group === 'batch1-deepseek')),
    batch2_glm: stats(pairs.filter((p) => p.group === 'batch2-glm')),
  },
  notes: [
    '配对设计：统计单位是「对内差值」，跨批模型不同不破坏对内有效性；跨批合并仅作方向性参考',
    '批 1 对 0（mod/pow）负向样本如实保留：平凡任务记忆注入反增上下文负担',
    'CR-37：样本 4→10 对取统计显著性；CR-33 原始 4 对数据存 summary-4pairs.json',
  ],
}

writeFileSync(join(dir, 'summary-10pairs.json'), JSON.stringify(summary, null, 2), 'utf8')
console.log('[summarize] written summary-10pairs.json')
console.log('[summarize] overall:', JSON.stringify(summary.metrics.overall))
console.log('[summarize] glm:', JSON.stringify(summary.metrics.batch2_glm))
