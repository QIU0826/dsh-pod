/**
 * 记忆向量召回基建（P1-4 深化③ 方向：BM25 → 混合召回，待办清单 §4 点名的下一步）。
 *
 * BM25 的天花板是**字面重叠**：换一种说法的经验（同义改述/跨语言）与任务文本零词元
 * 重叠时 relevance=0，只能靠 importance 兜底。本模块提供三件事：
 *
 *  1. `EmbeddingFunction` 可插拔嵌入接口——provider 由部署侧配置（OpenAI 兼容
 *     `/v1/embeddings`），不内置任何具体厂商；
 *  2. `hashEmbed` 本地确定性兜底——字符 n-gram 特征散列（无网络、无模型），泛化弱于
 *     真语义模型但可离线测试/离线使用，诚实标注：这是**字面模糊匹配**不是语义；
 *  3. `rankMemoriesHybrid` 混合排序——α·BM25 + (1-α)·cosine，嵌入失败**回落纯 BM25**
 *     （fail-open 到现状：召回增强是增益不是依赖，派发链路绝不被嵌入服务故障阻断）。
 *
 * 灰度纪律：`memoryEmbed` 未注入 = 行为与纯 BM25 **逐字节一致**（orchestrator 走原
 * 同步路径）；注入后才启用混合。bakeoff 先量化（复用 scripts/memory-eval-*.mjs 流程），
 * 无显著收益即按纪律停。
 */

import { docOf, rankMemories, scoreMemories, type MemoryRankQuery, type RankableMemory } from './memory-rank.js'

/** 可插拔嵌入器：批量输入 → 批量向量（顺序一一对应）。失败应 throw（调用方回落）。 */
export interface EmbeddingFunction {
  embed(inputs: string[]): Promise<number[][]>
}

/** 余弦相似度（零向量 → 0）。 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

const HASH_DIM = 256

/**
 * 本地确定性哈希嵌入（字符 3-gram + ASCII 词特征散列，signed hashing，L2 归一化）。
 * 无网络无模型——离线可测试可使用；语义泛化弱于真模型（同义改述抓不住），如实定位为
 * 「字面模糊匹配」：比 BM25 的整词/bigram 粒度更抗变形（错别字/单复数/部分截断），
 * 不承诺语义。
 */
export function hashEmbed(text: string, dim = HASH_DIM): number[] {
  const vec = new Array<number>(dim).fill(0)
  const normalized = text.toLowerCase()
  const features: string[] = []
  // ASCII 词
  for (const m of normalized.matchAll(/[a-z0-9]+/g)) features.push(m[0])
  // 字符 3-gram（跨 CJK/ASCII 统一处理，覆盖面比 bigram 稍宽）
  let i = 0
  for (const ch of normalized) {
    void ch
    const slice = normalized.slice(i, i + 3)
    if (slice.length === 3) features.push(slice)
    i += 1
  }
  for (const f of features) {
    const h = fnv1a(f)
    const bucket = h % dim
    // signed hashing：散列第二 bit 决定正负，减低碰撞偏置
    const sign = (h >>> 31) & 1
    vec[bucket] = (vec[bucket] ?? 0) + (sign === 1 ? -1 : 1)
  }
  let norm = 0
  for (const v of vec) norm += v * v
  norm = Math.sqrt(norm)
  if (norm === 0) return vec
  return vec.map((v) => v / norm)
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** OpenAI 兼容 /v1/embeddings 客户端（真实 provider 接入面；fetch 可注入测试）。 */
export class HttpEmbedder implements EmbeddingFunction {
  private readonly endpoint: string
  private readonly model: string
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: {
    endpoint: string
    model?: string
    apiKey?: string
    fetchImpl?: typeof fetch
    timeoutMs?: number
  }) {
    this.endpoint = options.endpoint.replace(/\/$/, '')
    this.model = options.model ?? 'embedding-3'
    this.apiKey = options.apiKey ?? ''
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 8_000
  }

  async embed(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey.length > 0 ? { authorization: 'Bearer ' + this.apiKey } : {}),
        },
        body: JSON.stringify({ model: this.model, input: inputs }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`embedding endpoint HTTP ${res.status}${text.length > 0 ? ': ' + text.slice(0, 200) : ''}`)
      }
      const parsed = (await res.json()) as { data?: Array<{ index?: number; embedding?: unknown }> }
      const data = parsed.data
      if (!Array.isArray(data) || data.length !== inputs.length) {
        throw new Error('embedding response shape mismatch: data[] length != input length')
      }
      // 按 index 对齐（provider 不保证有序返回）
      const out: number[][] = new Array(inputs.length)
      for (let i = 0; i < data.length; i++) {
        const item = data[i]!
        const vec = item.embedding
        const idx = typeof item.index === 'number' ? item.index : i
        if (!Array.isArray(vec) || vec.length === 0 || !vec.every((v) => typeof v === 'number' && Number.isFinite(v))) {
          throw new Error(`embedding response item ${idx}: embedding[] of finite numbers required`)
        }
        out[idx] = vec
      }
      if (out.some((v) => v === undefined)) throw new Error('embedding response missing index entries')
      return out
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 本地哈希嵌入的 EmbeddingFunction 适配（离线模式：POD_MEMORY_EMBEDDING=local-hash）。 */
export function localHashEmbedder(): EmbeddingFunction {
  return { embed: async (inputs: string[]) => inputs.map((t) => hashEmbed(t)) }
}

/**
 * 环境变量装配（缺省 undefined = 纯 BM25 现状，行为逐字节不变）：
 *   - POD_MEMORY_EMBEDDING_URL=https://.../v1/embeddings  → HttpEmbedder（+ KEY/MODEL 可选）
 *   - POD_MEMORY_EMBEDDING=local-hash                     → 本地确定性哈希嵌入
 */
export function makeMemoryEmbedderFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingFunction | undefined {
  const url = (env.POD_MEMORY_EMBEDDING_URL ?? '').trim()
  if (url.length > 0) {
    return new HttpEmbedder({
      endpoint: url,
      apiKey: (env.POD_MEMORY_EMBEDDING_KEY ?? '').trim(),
      model: (env.POD_MEMORY_EMBEDDING_MODEL ?? '').trim() || undefined,
    })
  }
  // Ollama 一键本地免费嵌入（2026-09-06）：ollama pull nomic-embed-text 后即开即用，
  // OpenAI 兼容 /v1/embeddings（实测 768 维批量）。完全本地零成本，无网络依赖。
  if ((env.POD_MEMORY_EMBEDDING ?? '').trim() === 'ollama') {
    return new HttpEmbedder({
      endpoint: (env.POD_MEMORY_EMBEDDING_OLLAMA_URL ?? 'http://localhost:11434/v1/embeddings').trim(),
      model: (env.POD_MEMORY_EMBEDDING_MODEL ?? 'nomic-embed-text').trim(),
    })
  }
  if ((env.POD_MEMORY_EMBEDDING ?? '').trim() === 'local-hash') return localHashEmbedder()
  return undefined
}

/** 混合排序选项。 */
export interface HybridRankOptions {
  embedder: EmbeddingFunction
  /** BM25 分量权重（0-1，默认 0.5；余弦权重 = 1-alpha）。 */
  alpha?: number
  /** 余弦「信号」门槛（低于此且无 BM25 信号 → 不入选，对应 BM25 的无信号门）。 */
  cosineGate?: number
}

const DEFAULT_ALPHA = 0.5
/** 余弦信号门槛：cosine 池内 min-max 归一后的相对值（0-1），与具体模型解耦。 */
const DEFAULT_COSINE_GATE = 0.5

/**
 * BM25 + cosine 混合排序（异步）：嵌入一次批量调用（[query, ...candidates]，同空间），
 * BM25 分量池内 max 归一、余弦 [-1,1] 平移到 [0,1]，加权合成。
 * 嵌入失败 → **回落纯 BM25**（fail-open 到现状，绝不阻断派发）；
 * 入选门：BM25 信号（词元重叠/tag 命中/importance 兜底）或 cosine ≥ cosineGate。
 * 确定性：score 降序 → importance 降序 → id 升序。
 */
export async function rankMemoriesHybrid<T extends RankableMemory>(
  candidates: readonly T[],
  query: MemoryRankQuery,
  limit: number,
  opts: HybridRankOptions,
): Promise<T[]> {
  if (candidates.length === 0 || limit <= 0) return []
  const alpha = opts.alpha ?? DEFAULT_ALPHA
  const cosineGate = opts.cosineGate ?? DEFAULT_COSINE_GATE
  const queryText = `${query.title} ${query.spec} ${(query.skill_tags ?? []).join(' ')}`

  let vectors: number[][]
  try {
    vectors = await opts.embedder.embed([queryText, ...candidates.map(docOf)])
  } catch {
    // 嵌入服务故障：回落纯 BM25（现状路径），召回增强是增益不是依赖
    return rankMemories(candidates, query, limit)
  }
  const queryVec = vectors[0]!

  const scored = scoreMemories(candidates, query)
  const maxBm25 = scored.reduce((mx, s) => Math.max(mx, s.score), 0)
  // 余弦池内 min-max 归一（2026-09-06，真实模型冒烟实证）：真实 embedding 模型存在
  // 各向异性——同语言无关文本对的 cosine 基线也有 0.5+，绝对门槛（0.35）形同虚设，
  // importance 平局决胜会压过语义序。池内相对化后门槛与模型解耦（nomic-embed-text 实测通过）。
  const cosines = scored.map((_, i) => cosineSimilarity(queryVec, vectors[i + 1]!))
  const minCos = cosines.reduce((mn, c) => Math.min(mn, c), Number.POSITIVE_INFINITY)
  const maxCos = cosines.reduce((mx, c) => Math.max(mx, c), Number.NEGATIVE_INFINITY)
  const cosSpread = maxCos - minCos
  const hybrid = scored.map((s, i) => {
    // BM25 池内 max 归一（全 0 时分量置 0）；余弦池内 min-max 归一（退化池给中性 0.5）
    const bm25Norm = maxBm25 > 0 ? s.score / maxBm25 : 0
    const cosNorm = cosSpread > 1e-9 ? (cosines[i]! - minCos) / cosSpread : 0.5
    const hasSignal = s.hasSignal || cosines[i]! - minCos >= cosineGate * cosSpread || cosSpread <= 1e-9
    return { m: s.m, score: alpha * bm25Norm + (1 - alpha) * cosNorm, hasSignal }
  })

  return hybrid
    .filter((s) => s.hasSignal)
    .sort((a, b) => b.score - a.score || b.m.importance - a.m.importance || (a.m.id < b.m.id ? -1 : 1))
    .slice(0, limit)
    .map((s) => s.m)
}
