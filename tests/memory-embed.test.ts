/**
 * 记忆向量召回（P1-4 深化③）回归测试：
 *   - hashEmbed：确定性、归一化、维度
 *   - cosineSimilarity：基础几何
 *   - HttpEmbedder：请求形态 / index 对齐 / 形状校验 fail-closed / HTTP 失败 throw
 *   - rankMemoriesHybrid：语义无字面重叠的记录越 过 纯 BM25 不可见（核心收益）/
 *     嵌入失败回落纯 BM25（fail-open 到现状）/ 确定性 / 余弦信号门
 *   - makeMemoryEmbedderFromEnv：未配置 undefined / URL → HttpEmbedder / local-hash
 */
import { describe, expect, it, vi } from 'vitest'
import {
  cosineSimilarity,
  hashEmbed,
  HttpEmbedder,
  localHashEmbedder,
  makeMemoryEmbedderFromEnv,
  rankMemoriesHybrid,
} from '../src/core/memory-embed.js'
import { rankMemories, type RankableMemory } from '../src/core/memory-rank.js'

function mem(over: Partial<RankableMemory> = {}): RankableMemory {
  return {
    id: 'MEM-1',
    type: 'fact',
    importance: 3,
    tags: [],
    content_ref: '内容',
    ...over,
  }
}

describe('hashEmbed（本地确定性哈希嵌入）', () => {
  it('确定性：同文本两次嵌入逐位相等', () => {
    expect(hashEmbed('部署脚本需要 node 22')).toEqual(hashEmbed('部署脚本需要 node 22'))
  })
  it('L2 归一化：模长 ≈ 1', () => {
    const v = hashEmbed('worktree 并发写冲突')
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
    expect(norm).toBeCloseTo(1, 5)
  })
  it('近似文本（多一字）相似度显著高于无关文本（字面模糊匹配的承诺边界）', () => {
    const a = hashEmbed('部署脚本需要 node 22')
    const b = hashEmbed('部署脚本需要 node 22 版本')
    const c = hashEmbed('今天天气不错适合散步')
    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c))
  })
})

describe('cosineSimilarity', () => {
  it('同向 1 / 正交 0 / 反向 -1 / 零向量 0 / 维度不等 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
    expect(cosineSimilarity([1], [1, 1])).toBe(0)
  })
})

describe('HttpEmbedder（OpenAI 兼容 /v1/embeddings）', () => {
  const okResponse = {
    data: [
      { index: 1, embedding: [0.1, 0.2] },
      { index: 0, embedding: [0.3, 0.4] },
    ],
  }

  it('请求形态（model/input/鉴权头）+ 按 index 对齐返回', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: { body?: string }) => ({
      ok: true,
      json: async () => okResponse,
      text: async () => '',
    })) as unknown as typeof fetch
    const embedder = new HttpEmbedder({ endpoint: 'http://x/v1/embeddings', model: 'm-1', apiKey: 'k-1', fetchImpl })
    const out = await embedder.embed(['a', 'b'])
    expect(out).toEqual([
      [0.3, 0.4],
      [0.1, 0.2],
    ])
    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(call[0])).toBe('http://x/v1/embeddings')
    const body = JSON.parse((call[1] as { body: string }).body)
    expect(body.model).toBe('m-1')
    expect(body.input).toEqual(['a', 'b'])
    expect((call[1] as { headers: Record<string, string> }).headers.authorization).toBe('Bearer k-1')
  })

  it('响应形状不符 → throw（fail-closed，不静默返回错位向量）', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1] }] }) })) as unknown as typeof fetch
    const embedder = new HttpEmbedder({ endpoint: 'http://x', fetchImpl })
    await expect(embedder.embed(['a', 'b'])).rejects.toThrow(/shape mismatch/)
  })

  it('embedding 含非有限数 → throw', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ embedding: [Number.NaN] }] }) })) as unknown as typeof fetch
    const embedder = new HttpEmbedder({ endpoint: 'http://x', fetchImpl })
    await expect(embedder.embed(['a'])).rejects.toThrow(/finite/)
  })

  it('HTTP 500 → throw（调用方回落 BM25）', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' })) as unknown as typeof fetch
    const embedder = new HttpEmbedder({ endpoint: 'http://x', fetchImpl })
    await expect(embedder.embed(['a'])).rejects.toThrow(/HTTP 500/)
  })
})

describe('rankMemoriesHybrid（BM25 + cosine 混合）', () => {
  const query = { title: '修复发布流程', spec: 'release pipeline 的构建脚本在 CI 上跑不动，需要排查缓存配置', skill_tags: [] }

  it('核心收益：语义相关但零字面重叠的记忆越过纯 BM25 的盲区', async () => {
    // 字面零重叠（BM25 relevance=0、无 tag、importance<4 → 纯 BM25 永不入选）；
    // 假嵌入器按「主题向量」打分：与 query 同主题的记录 cosine 高
    const related = mem({ id: 'MEM-1', type: 'fact', importance: 2, content_ref: '依赖还原没有本地镜像时流水线会卡住', tags: [] })
    const unrelated = mem({ id: 'MEM-2', type: 'fact', importance: 3, content_ref: '数据库连接池默认上限 10 个', tags: ['数据库'] })
    // 纯 BM25 基线：两条都无词元重叠 → 只剩 importance 兜底门（都 <4）→ 全军覆没
    expect(rankMemories([related, unrelated], query, 2)).toEqual([])

    // 假嵌入器：query/related 同主题（cos≈1），unrelated 正交（cos=0）
    const topic = [1, 0]
    const off = [0, 1]
    const fake: { embed(inputs: string[]): Promise<number[][]> } = {
      embed: async (inputs) => inputs.map((t) => (t.includes('依赖还原') ? topic : t.includes('发布流程') || t.includes('pipeline') ? topic : off)),
    }
    const picked = await rankMemoriesHybrid([related, unrelated], query, 2, { embedder: fake, cosineGate: 0.5 })
    expect(picked.map((m) => m.id)).toEqual(['MEM-1'])
  })

  it('嵌入失败 → 回落纯 BM25（结果与 rankMemories 完全一致，派发不被阻断）', async () => {
    const a = mem({ id: 'MEM-1', importance: 3, content_ref: 'release pipeline 缓存配置在 ci.yml', tags: [] })
    const b = mem({ id: 'MEM-2', importance: 3, content_ref: '完全无关的内容', tags: [] })
    const failing: { embed(inputs: string[]): Promise<number[][]> } = {
      embed: async () => {
        throw new Error('embedding service down')
      },
    }
    const picked = await rankMemoriesHybrid([a, b], query, 2, { embedder: failing })
    expect(picked).toEqual(rankMemories([a, b], query, 2))
  })

  it('确定性：同输入两次结果一致（含并列分时 importance/id 决序）', async () => {
    const a = mem({ id: 'MEM-1', importance: 2, content_ref: 'release pipeline 缓存', tags: [] })
    const b = mem({ id: 'MEM-2', importance: 2, content_ref: 'release pipeline 缓存', tags: [] })
    const embedder = localHashEmbedder()
    const r1 = await rankMemoriesHybrid([a, b], query, 2, { embedder })
    const r2 = await rankMemoriesHybrid([a, b], query, 2, { embedder })
    expect(r1.map((m) => m.id)).toEqual(r2.map((m) => m.id))
  })

  it('空候选 / limit≤0 → 空', async () => {
    const embedder = localHashEmbedder()
    expect(await rankMemoriesHybrid([], query, 3, { embedder })).toEqual([])
    expect(await rankMemoriesHybrid([mem()], query, 0, { embedder })).toEqual([])
  })
})

describe('makeMemoryEmbedderFromEnv（灰度装配）', () => {
  it('未配置 → undefined（纯 BM25 现状路径）', () => {
    expect(makeMemoryEmbedderFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined()
  })
  it('POD_MEMORY_EMBEDDING_URL → HttpEmbedder（KEY/MODEL 可选）', () => {
    const e = makeMemoryEmbedderFromEnv({
      POD_MEMORY_EMBEDDING_URL: 'http://x/v1/embeddings',
      POD_MEMORY_EMBEDDING_KEY: 'k',
      POD_MEMORY_EMBEDDING_MODEL: 'm',
    } as NodeJS.ProcessEnv)
    expect(e).toBeInstanceOf(HttpEmbedder)
  })
  it('POD_MEMORY_EMBEDDING=local-hash → 本地确定性嵌入（离线可用）', async () => {
    const e = makeMemoryEmbedderFromEnv({ POD_MEMORY_EMBEDDING: 'local-hash' } as NodeJS.ProcessEnv)
    expect(e).toBeDefined()
    const v = await e!.embed(['测试文本'])
    expect(v).toHaveLength(1)
    expect(v[0]).toHaveLength(256)
  })
})
