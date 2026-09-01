/**
 * memory-rank（P1-4 深化①）：记忆检索从「importance+标签」升级 BM25 关键词相关性。
 *
 * 锁定：
 *   - 分词：ASCII 词小写化；CJK 相邻双字 bigram；混排/标点边界；
 *   - 相关性主导：与任务文本关键词重叠的记忆压过高重要度但无关的记忆；
 *   - 召回保底：无任何关键词重叠时高重要度仍可入选（importance 加权不归零）；
 *   - tag 精确命中加成；limit 截断；同分确定性（importance 降序 → id 升序）。
 */
import { describe, expect, it } from 'vitest'
import { rankMemories, tokenize, TAG_HIT_BONUS, IMPORTANCE_WEIGHT } from '../src/core/memory-rank.js'
import type { RankableMemory } from '../src/core/memory-rank.js'

function mem(over: Partial<RankableMemory> & { id: string }): RankableMemory {
  return { type: 'fact', importance: 3, tags: [], content_ref: '', ...over }
}

describe('tokenize（中英混排分词）', () => {
  it('ASCII 连续字母数字为一词并小写化；CJK 成 bigram', () => {
    expect(tokenize('RateLimit-429')).toEqual(['ratelimit', '429'])
    expect(tokenize('测试用例')).toEqual(['测试', '试用', '用例'])
  })

  it('中英混排与标点均为边界', () => {
    const tokens = tokenize('实现 rate limiter，防止 429')
    expect(tokens).toContain('实现')
    expect(tokens).toContain('rate')
    expect(tokens).toContain('limiter')
    expect(tokens).toContain('429')
    expect(tokens).not.toContain('，')
  })
})

describe('rankMemories（BM25 top-k）', () => {
  const query = { title: '实现 rate limiter 中间件', spec: '用 token bucket 算法防止 429 限流', skill_tags: ['编码'] }

  it('相关性主导：相关记忆压过高重要度但无关的记忆（旧启发式会选后者）', () => {
    const relevant = mem({ id: 'm-rel', importance: 2, tags: ['限流'], content_ref: '上次用 token bucket 防 429 成功' })
    const irrelevant = mem({ id: 'm-irr', importance: 5, tags: ['文档'], content_ref: '项目周报模板与配色偏好' })
    const ranked = rankMemories([irrelevant, relevant], query, 2)
    expect(ranked[0]!.id).toBe('m-rel')
  })

  it('召回保底：无关键词重叠时仅高重要度（importance≥4）入选；低重要度无信号被过滤', () => {
    const low = mem({ id: 'm-low', importance: 2, content_ref: '无关内容甲' })
    const high = mem({ id: 'm-high', importance: 4, content_ref: '无关内容乙' })
    const ranked = rankMemories([low, high], query, 2)
    expect(ranked.map((r) => r.id)).toEqual(['m-high'])
  })

  it('tag 精确命中有加成（skill_tags 命中 tags）；无信号的无关记忆不入选', () => {
    const tagged = mem({ id: 'm-tag', importance: 1, tags: ['编码'], content_ref: '完全无关正文' })
    const plain = mem({ id: 'm-plain', importance: 1, tags: [], content_ref: '完全无关正文' })
    // plain 无重叠无 tag 无高重要度 → 被门槛过滤；tagged 靠 tag 命中入选
    const ranked = rankMemories([plain, tagged], query, 2)
    expect(ranked.map((r) => r.id)).toEqual(['m-tag'])
  })

  it('limit 截断 + 同分确定性（importance 降序、id 升序）', () => {
    const pool = [
      mem({ id: 'a', importance: 3, content_ref: 'x' }),
      mem({ id: 'b', importance: 5, content_ref: 'x' }),
      mem({ id: 'c', importance: 5, content_ref: 'x' }),
    ]
    const ranked = rankMemories(pool, { title: '无关任务', spec: 'zzz' }, 2)
    expect(ranked.map((r) => r.id)).toEqual(['b', 'c'])
  })

  it('空查询（无有效词）退化为 importance 排序；空候选返回空', () => {
    const pool = [mem({ id: 'a', importance: 1 }), mem({ id: 'b', importance: 4 })]
    expect(rankMemories(pool, { title: '', spec: '' }, 2).map((r) => r.id)).toEqual(['b', 'a'])
    expect(rankMemories([], query, 3)).toEqual([])
    expect(rankMemories(pool, query, 0)).toEqual([])
  })

  it('tags 字段参与相关性且被放大（tags 命中查询词 > 正文弱命中）', () => {
    const tagHit = mem({ id: 'm-tagkw', tags: ['限流', '429'], content_ref: '无关正文' })
    const bodyHit = mem({ id: 'm-bodykw', tags: [], content_ref: '提了一句 429' })
    const ranked = rankMemories([bodyHit, tagHit], query, 2)
    expect(ranked[0]!.id).toBe('m-tagkw')
  })

  it('权重导出值稳定（TAG_HIT_BONUS / IMPORTANCE_WEIGHT 量级约定不被无声改动）', () => {
    expect(TAG_HIT_BONUS).toBeGreaterThan(0)
    // importance 全档（1→5）加权 1.5 < tag 命中 2.0：tag 语义命中优先于纯重要度
    expect(IMPORTANCE_WEIGHT * 5).toBeLessThan(TAG_HIT_BONUS + IMPORTANCE_WEIGHT * 1)
  })
})
