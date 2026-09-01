/**
 * 记忆检索 top-k 排序（P1-4 深化①，调研 2026-08-31 §0 第 5 项 / §1.1）。
 *
 * 此前派发注入的记忆是「importance≥3 硬门 + tag 命中 + importance」三层启发式，
 * 与任务内容无关——重要但不相关的记录会把真正相关的挤出 ≤6 的注入位。
 * 本模块把检索升级为 **BM25 关键词相关性**（与 §1.1 记忆检索同一基建思路）：
 *   - 分词：ASCII 词 + **CJK bigram**（中英混排 content_ref 的务实解，无需词典）；
 *   - 打分：任务文本（标题 + spec + 技能标签）对每条候选（tags + content_ref + type）做
 *     BM25，IDF 在候选池内计算；tag 精确命中与 importance 作**加权项**而非硬门
 *     （无任何关键词重叠时高重要度记忆仍可入选，保住旧召回；有重叠时相关性主导）。
 *
 * 纯函数、无 IO、确定性（同分按 importance 降序再按 id 升序，输出稳定可测）。
 */

/** 分词：ASCII 连续字母数字为一词；CJK 相邻两字成 bigram；其余（空白/标点）为边界。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  let ascii = ''
  const flush = () => {
    if (ascii.length > 0) {
      tokens.push(ascii)
      ascii = ''
    }
  }
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      ascii += ch.toLowerCase()
    } else {
      flush()
    }
  }
  flush()
  // CJK bigram：滑窗取相邻两个汉字（无词典的中文务实解）
  for (let i = 0; i + 1 < text.length; ) {
    const a = text.codePointAt(i)!
    const aLen = a > 0xffff ? 2 : 1
    const b = text.codePointAt(i + aLen)
    if (b === undefined) break
    if (isCjk(a) && isCjk(b)) {
      tokens.push(text.slice(i, i + aLen) + String.fromCodePoint(b))
    }
    i += aLen
  }
  return tokens
}

function isCjk(code: number): boolean {
  return code >= 0x4e00 && code <= 0x9fff
}

/** 可排序记忆最小结构（与 orchestrator 的 MemoryRecordLike 同形，避免硬依赖）。 */
export interface RankableMemory {
  id: string
  type: string
  importance: number
  tags: string[]
  content_ref: string
}

/** 检索查询：任务侧文本（title + spec + 技能标签）。 */
export interface MemoryRankQuery {
  title: string
  spec: string
  skill_tags?: string[]
}

const BM25_K1 = 1.2
const BM25_B = 0.75
/** tag 精确命中加成（BM25 分数量级 ~1-5，tag 命中给固定 2.0）。 */
export const TAG_HIT_BONUS = 2.0
/** importance 权重（1-5 的量级压到 ~0.3/档，相关性主导但不归零）。 */
export const IMPORTANCE_WEIGHT = 0.3
/** 无任何关键词重叠时的保底门槛：importance≥4 的记忆仍入选（召回兜底，防池空）。 */
export const MIN_IMPORTANCE_FLOOR = 4

function docOf(m: RankableMemory): string {
  // tags 权重放大：重复 3 次（词法层面的字段 boost，等价于字段加权）
  const tags = m.tags.join(' ').repeat(3)
  return `${tags} ${m.type} ${m.content_ref}`
}

/**
 * BM25 + tag 命中 + importance 的综合排序，返回前 limit 条。
 * 门槛：至少满足其一（查询词重叠 / tag 精确命中 / importance≥MIN_IMPORTANCE_FLOOR）
 * ——无信号的低重要度记忆不入选（旧「importance≥3 硬门」的对应物，池放大后门槛略升）。
 * 确定性：score 降序 → importance 降序 → id 升序。
 */
export function rankMemories<T extends RankableMemory>(candidates: readonly T[], query: MemoryRankQuery, limit: number): T[] {
  if (candidates.length === 0 || limit <= 0) return []
  const queryTokens = new Set(tokenize(`${query.title} ${query.spec} ${(query.skill_tags ?? []).join(' ')}`))
  if (queryTokens.size === 0) {
    // 查询无有效词（空任务文本）：退化为 importance 排序，行为可预测
    return [...candidates].sort((a, b) => b.importance - a.importance || (a.id < b.id ? -1 : 1)).slice(0, limit)
  }

  const docs = candidates.map((m) => {
    const tf = new Map<string, number>()
    for (const t of tokenize(docOf(m))) tf.set(t, (tf.get(t) ?? 0) + 1)
    return { tf, len: [...tf.values()].reduce((s, n) => s + n, 0) }
  })
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / docs.length || 1
  const df = new Map<string, number>()
  for (const t of queryTokens) {
    let n = 0
    for (const d of docs) if (d.tf.has(t)) n++
    df.set(t, n)
  }
  const nDocs = docs.length

  const scored: { m: T; score: number }[] = []
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i]!
    const d = docs[i]!
    let relevance = 0
    let overlap = 0
    for (const t of queryTokens) {
      const f = d.tf.get(t) ?? 0
      if (f === 0) continue
      overlap += f
      const idf = Math.log(1 + (nDocs - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))
      relevance += (idf * (f * (BM25_K1 + 1))) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * d.len) / avgLen))
    }
    const tagHit = m.tags.some((tag) => queryTokens.has(tag.toLowerCase())) ? TAG_HIT_BONUS : 0
    if (overlap === 0 && tagHit === 0 && m.importance < MIN_IMPORTANCE_FLOOR) continue // 无信号不入选
    scored.push({ m, score: relevance + tagHit + m.importance * IMPORTANCE_WEIGHT })
  }

  scored.sort((a, b) => b.score - a.score || b.m.importance - a.m.importance || (a.m.id < b.m.id ? -1 : 1))
  return scored.slice(0, limit).map((s) => s.m)
}
