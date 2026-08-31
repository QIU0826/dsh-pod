import { buildTaskPromptSegments, buildTaskPrompt } from '../dist/workers/claude-headless.js'

// P0-2 静态前缀工程量化：静态脚手架（身份 + 交付纪律 + 报告 schema）在完整 prompt 中的占比。
// 目的：验证「静态前缀连续前置 + byte-稳定」后，同一 mission 内同类型任务的可命中前缀有多大。

const charter = '你是 Implementer。规则：\n1. 只处理分配给你的任务。\n2. 完成后 commit 并输出 MISSION_REPORT。'

function makeTask(id, title, spec, type = 'implement') {
  return {
    id, mission_id: 'M-1', title, spec, skill_tags: [], type,
    depends_on: [], status: 'running', attempts: 0, soft_attempts: 0,
    max_wall_clock_ms: 3600_000, created_at: 0, updated_at: 0,
  }
}

const tokens = (chars) => Math.round(chars / 3.5)

// 同类型任务样本（implement）：spec 各异，模拟真实 mission 的多次派发
const samples = [
  makeTask('T-1', '实现 A', '实现 RFC-12 的 rate limiter 中间件，含单元测试。'),
  makeTask('T-2', '实现 B', '为 auth 模块补 JWT 校验，覆盖过期/签名错误两分支。'),
  makeTask('T-3', '实现 C', '重构 db 连接池，支持重试与熔断。'),
]

const segs = samples.map((t) => buildTaskPromptSegments({ task: t, charterText: charter, worktreePath: 'W' }))
const fulls = samples.map((t) => buildTaskPrompt({ task: t, charterText: charter, worktreePath: 'W' }))

// 静态前缀跨任务一致？
const staticUnique = new Set(segs.map((s) => s.static)).size
console.log(`静态前缀跨 ${samples.length} 个 implement 任务唯一数: ${staticUnique}（1 = 完全 byte-稳定）`)

const staticTok = tokens(segs[0].static.length)
const dynamicAvg = tokens(segs.reduce((sum, s) => sum + s.dynamic.length, 0) / segs.length)
const fullAvg = tokens(fulls.reduce((sum, s) => sum + s.length, 0) / fulls.length)
console.log(`静态前缀: ~${staticTok} tok / 完整 prompt 平均 ~${fullAvg} tok（占 ${Math.round((staticTok / fullAvg) * 100)}%）`)
console.log(`动态段平均: ~${dynamicAvg} tok`)
console.log('---')

// 与拆分前对比：如果静态块曾内联任务 id（旧版），前缀会随任务变化 → cache 不可命中
// 这里只输出当前结构的实测，供 bakeoff 前后的 cache_read/cache_creation 对照。
console.log('P0-2 结论判据（配合 ledger 实测）:')
console.log('- 静态前缀 byte-稳定：同一 mission 同类型任务共享 → prompt cache 可命中前缀')
console.log('- ledger.total_cache_read_tokens 在真实 mission 中应 > 0（resume 会话跨轮前缀命中）')
console.log('- bakeoff 对照：拆分前后 wall/tokens 无显著回归即停（复用 wording-eval 流程）')