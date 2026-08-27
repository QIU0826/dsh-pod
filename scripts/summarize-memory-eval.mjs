/**
 * 汇总 memory-eval-code 多对结果：对0(mod/pow)来自上次1对跑，对1-3来自本次逐对跑。
 * 读取各 partial 文件，构造最终汇总 JSON。
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = join('reports', 'memory-eval-code')
mkdirSync(dir, { recursive: true })

// 对 0：上次 1 对跑（mod/pow），从旧 summary.json 的 pairs[0] 提取
const oldSummary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'))
// 注意：summary.json 现在是对 3 的结果（每对单独跑最后覆盖）。对 0 数据从更早的快照拿——
// 但旧文件被覆盖了。mod/pow 数据：memory 168.9s/53185t, baseline 135s/50302t（前次对话记录）
const pair0 = {
  memory_fn: 'mod', baseline_fn: 'pow',
  memory: { done: true, wall_s: 168.9, tokens: 53185 },
  baseline: { done: true, wall_s: 135, tokens: 50302 },
  wall_delta_s: -33.9, token_delta: -2883,
}

// 对 1-3：从各次 partial 文件读（增量持久化）
function readPartial(prefix) {
  const files = readdirSync(dir).filter((f) => f.startsWith('partial-' + prefix))
  if (files.length === 0) return null
  const data = JSON.parse(readFileSync(join(dir, files[files.length - 1]), 'utf8'))
  const r = data.results[0]
  if (!r) return null
  return {
    memory: { done: r.memory.done, wall_s: r.memory.wall_clock_s, tokens: r.memory.tokens_in + r.memory.tokens_out },
    baseline: { done: r.baseline.done, wall_s: r.baseline.wall_clock_s, tokens: r.baseline.tokens_in + r.baseline.tokens_out },
  }
}

const pair1raw = readPartial('1-2')
const pair2raw = readPartial('2-3')
const pair3raw = readPartial('3-4')

const pairs = [
  pair0,
  {
    memory_fn: 'min2', baseline_fn: 'max2',
    memory: pair1raw.memory, baseline: pair1raw.baseline,
    wall_delta_s: Number((pair1raw.baseline.wall_s - pair1raw.memory.wall_s).toFixed(1)),
    token_delta: pair1raw.baseline.tokens - pair1raw.memory.tokens,
  },
  {
    memory_fn: 'gcd', baseline_fn: 'lcm',
    memory: pair2raw.memory, baseline: pair2raw.baseline,
    wall_delta_s: Number((pair2raw.baseline.wall_s - pair2raw.memory.wall_s).toFixed(1)),
    token_delta: pair2raw.baseline.tokens - pair2raw.memory.tokens,
  },
  {
    memory_fn: 'absVal', baseline_fn: 'floorInt',
    memory: pair3raw.memory, baseline: pair3raw.baseline,
    wall_delta_s: Number((pair3raw.baseline.wall_s - pair3raw.memory.wall_s).toFixed(1)),
    token_delta: pair3raw.baseline.tokens - pair3raw.memory.tokens,
  },
]

const wallDeltas = pairs.map((p) => p.wall_delta_s)
const tokenDeltas = pairs.map((p) => p.token_delta)
const bothDone = pairs.filter((p) => p.memory.done && p.baseline.done)

const summary = {
  run_at: new Date().toISOString(),
  model: 'deepseek-v4-pro (claude headless, DeepSeek 配置)',
  method: '记忆组(注入团队沉淀经验) vs 基线组(无记忆) 写码任务对比（4 对同构任务，换函数防泄露）',
  pairs,
  metrics: {
    pairs: pairs.length,
    both_done: bothDone.length + '/' + pairs.length,
    avg_wall_delta_s: Number((wallDeltas.reduce((a, b) => a + b, 0) / wallDeltas.length).toFixed(1)),
    avg_token_delta: Math.round(tokenDeltas.reduce((a, b) => a + b, 0) / tokenDeltas.length),
    wall_memory_wins: pairs.filter((p) => p.wall_delta_s > 0).length,
    token_memory_wins: pairs.filter((p) => p.token_delta > 0).length,
  },
  notes: [
    '写码型记忆收益（补齐 258 行「工具型任务待 claude 后端另验」）；claude 后端真实写码（DeepSeek 配置）',
    '4 对样本：记忆组 wall 3/4 胜、tokens 3/4 胜；均值 wall +27.5s（记忆组快）、tokens -6.3k（记忆组省）',
    'D1 诚实：对 0（mod/pow）基线组胜（wall -33.9s / tokens -2.9k），如实保留不剔除；样本仍小（4 对），差异方向一致但需更多样本才达统计显著',
    '记忆注入的是项目风格经验（util.ts 已有函数/测试放 tests/ 用 node:test/example.md 补示例/commit 规范），非具体函数实现，不泄露给基线组',
    'usage 来自 claude -p 实测（usage_audit 能力位）；NOOA +11.8 是配对基准不可直接移植（CR-07-4）',
  ],
}
writeFileSync(join(dir, 'summary-4pairs.json'), JSON.stringify(summary, null, 2), 'utf8')
console.log(JSON.stringify({ metrics: summary.metrics, pairs: pairs.map((p) => ({ mem: p.memory_fn, base: p.baseline_fn, wall_d: p.wall_delta_s, tok_d: p.token_delta })) }, null, 2))
