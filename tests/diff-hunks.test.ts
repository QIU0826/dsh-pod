import { describe, expect, it } from 'vitest'
import {
  buildChangeMap,
  buildTwoLevelDiff,
  parseDiffHunks,
  renderInjectedHunks,
  scoreHunk,
  selectHunksByBudget,
} from '../src/core/diff-hunks.js'

const SAMPLE_DIFF = [
  'diff --git a/src/middleware/rate-limit.ts b/src/middleware/rate-limit.ts',
  'index 111..222 100644',
  '--- a/src/middleware/rate-limit.ts',
  '+++ b/src/middleware/rate-limit.ts',
  '@@ -1,4 +1,6 @@ export function rateLimit() {',
  '   const bucket = new TokenBucket()',
  '+  bucket.refill()',
  '+  if (bucket.exceeded()) return 429',
  ' }',
  'diff --git a/src/db/pool.ts b/src/db/pool.ts',
  'index 333..444 100644',
  '--- a/src/db/pool.ts',
  '+++ b/src/db/pool.ts',
  '@@ -10,3 +10,5 @@ export function withRetry() {',
  '   for (let i = 0; i < 3; i++) {',
  '+    try { await run() } catch { continue }',
  '+    break',
  '   }',
].join('\n')

describe('parseDiffHunks（unified diff → hunk 数组）', () => {
  it('解析多文件多 hunk，带文件归属与行数统计', () => {
    const hunks = parseDiffHunks(SAMPLE_DIFF)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]!.file).toBe('src/middleware/rate-limit.ts')
    expect(hunks[0]!.addedLines).toBe(2)
    expect(hunks[0]!.removedLines).toBe(0)
    expect(hunks[1]!.file).toBe('src/db/pool.ts')
    expect(hunks[1]!.addedLines).toBe(2)
    expect(hunks[1]!.removedLines).toBe(0)
    expect(hunks[0]!.header).toContain('@@')
    expect(hunks[0]!.title).toContain('rate-limit.ts')
  })

  it('空输入 → []，不抛错', () => {
    expect(parseDiffHunks('')).toEqual([])
    expect(parseDiffHunks('不是 diff 的普通文本\n也没有 @@')).toEqual([])
  })

  it('删除行计入 removedLines（- 开头且非 ---）', () => {
    const d = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,2 @@',
      '-  old line',
      '+  new line',
      '   context',
    ].join('\n')
    const hunks = parseDiffHunks(d)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.addedLines).toBe(1)
    expect(hunks[0]!.removedLines).toBe(1)
  })
})

describe('buildChangeMap（第一级：恒全量变更地图）', () => {
  it('列出文件 + 每 hunk 标题', () => {
    const hunks = parseDiffHunks(SAMPLE_DIFF)
    const map = buildChangeMap(hunks)
    expect(map).toContain('rate-limit.ts')
    expect(map).toContain('db/pool.ts')
    expect(map).toContain('1 hunk）') // 每文件一行计数
    expect(map).toContain('变更地图')
  })

  it('空 hunk 列表 → 无 diff 提示', () => {
    expect(buildChangeMap([])).toContain('无 diff 内容')
  })
})

describe('scoreHunk（确定性相关度：spec 关键词/路径匹配）', () => {
  it('文件路径命中 spec → 高相关', () => {
    const hunks = parseDiffHunks(SAMPLE_DIFF)
    const rate = hunks.find((h) => h.file.includes('rate-limit'))!
    const pool = hunks.find((h) => h.file.includes('pool'))!
    const sRate = scoreHunk(rate, '实现 rate limiter：src/middleware/rate-limit.ts')
    const sPool = scoreHunk(pool, '实现 rate limiter：src/middleware/rate-limit.ts')
    expect(sRate).toBeGreaterThan(sPool)
  })

  it('spec 为空 → 0 分（不偏向任何 hunk）', () => {
    const hunks = parseDiffHunks(SAMPLE_DIFF)
    expect(scoreHunk(hunks[0]!, '')).toBe(0)
  })
})

describe('selectHunksByBudget + buildTwoLevelDiff（第二级：相关 hunk 装入预算）', () => {
  it('预算充足 → 全部 hunk 注入，无保留', () => {
    const hunks = parseDiffHunks(SAMPLE_DIFF)
    const { injected, retained } = selectHunksByBudget(hunks, 1_000_000, '')
    expect(injected).toHaveLength(2)
    expect(retained).toHaveLength(0)
  })

  it('预算紧张 → 相关 hunk 优先装入，无关 hunk 保留地图', () => {
    const hunks = parseDiffHunks(SAMPLE_DIFF)
    // 预算只够 1 个 hunk
    const single = hunks[0]!.body.length + 5
    const spec = 'rate limiter：src/middleware/rate-limit.ts'
    const { injected, retained } = selectHunksByBudget(hunks, single, spec)
    expect(injected.length).toBe(1)
    expect(injected[0]!.file).toBe('src/middleware/rate-limit.ts') // 相关文件优先
    expect(retained.length).toBe(1)
    expect(retained[0]!.file).toBe('src/db/pool.ts')
  })

  it('buildTwoLevelDiff 端到端：地图全量 + 注入相关 + 截断元数据', () => {
    const spec = 'rate limiter：src/middleware/rate-limit.ts'
    // 预算 = 第一个 hunk 正文 + 一点余量 → 只装得下 rate-limit，pool 保留
    const single = hunksBodyChars(SAMPLE_DIFF, 0) + 5
    const out = buildTwoLevelDiff(SAMPLE_DIFF, single, spec)
    expect(out.map).toContain('rate-limit.ts')
    expect(out.map).toContain('db/pool.ts') // 地图全量，无文件丢失
    expect(out.injectedText).toContain('rateLimit')
    expect(out.injectedText).not.toContain('withRetry')
    expect(out.retainedCount).toBe(1)
    expect(out.truncatedHunks.length).toBe(1)
    expect(out.truncatedHunks[0]!).toContain('db/pool.ts') // 被切掉的 hunk 有元数据
  })

  it('超预算的单 hunk 整个保留（不拦腰切）', () => {
    const big = [
      'diff --git a/big.ts b/big.ts',
      '--- a/big.ts',
      '+++ b/big.ts',
      '@@ -1,1 +1,1 @@',
      '+  '.repeat(2000),
    ].join('\n')
    const out = buildTwoLevelDiff(big, 100, '')
    expect(out.injectedText).toBe('')
    expect(out.retainedCount).toBe(1)
  })

  it('renderInjectedHunks：空注入 → 空串', () => {
    expect(renderInjectedHunks([])).toBe('')
  })
})

// 取第 idx 个 hunk 的 body 长度（复用 parseDiffHunks 保证与实现一致）
function hunksBodyChars(diff: string, idx: number): number {
  const hunks = parseDiffHunks(diff)
  return hunks[idx]!.body.length
}
