import { makePodTools } from '../dist/pod-tools.js'

// 工具定义不含 execute（代码），只测会进 LLM 上下文的描述/schema
const bundle = makePodTools({})
let totalChars = 0
const rows = []
for (const t of bundle.tools) {
  const def = { name: t.name, description: t.description, parameters: t.parameters, output: t.output }
  const chars = JSON.stringify(def).length
  totalChars += chars
  rows.push({ name: t.name, chars, est_tokens: Math.round(chars / 3.5) })
}
rows.sort((a, b) => b.chars - a.chars)
for (const r of rows) console.log(`${r.name}: ${r.chars} chars ≈ ${r.est_tokens} tok`)
console.log('---')
console.log(`工具数: ${rows.length}  合计: ${totalChars} chars ≈ ${Math.round(totalChars / 3.5)} tok`)

// P0-1 分层加载量化：CORE + 当前 stage 全量，其余一行索引
import { presentTools, estimatePresentationTokens, POD_CORE_TOOLS } from '../dist/core/tool-stages.js'
const schemaChars = Object.fromEntries(rows.map((r) => [r.name, r.chars]))
const all = Object.keys(schemaChars)
const fullTok = estimatePresentationTokens(all, [], schemaChars, 0)
const staged = presentTools({ activeStage: 'dispatch', all })
const stagedTok = estimatePresentationTokens(staged.full, staged.index, schemaChars)
console.log('--- P0-1 分层（stage=dispatch）---')
console.log(`全量 ${fullTok} tok → 分层 ${stagedTok} tok（−${Math.round((1 - stagedTok / fullTok) * 100)}%）；全量工具 ${staged.full.length}，索引 ${staged.index.length}`)
