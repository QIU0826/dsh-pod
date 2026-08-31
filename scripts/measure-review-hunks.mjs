// P1-5 量化：review diff「40K 定长截断」vs「hunk 两级加载」的覆盖度与 token 对比。

function synthHunk(file, fn, lines) {
  const h = ['@@ -1,' + lines + ' +1,' + (lines + 3) + ' @@ function ' + fn + '()']
  for (let i = 0; i < lines; i++) {
    h.push(i % 10 === 0 ? ('+    ' + fn + ' 第' + i + '行新增逻辑分支') : ('+    普通代码行 ' + file + ':' + i))
  }
  return h.join('\n')
}

// 造大 diff：8 文件 × 多 hunk × 每 hunk 大行数 → 总量远超 40K 阈值
const files = [
  ['src/middleware/rate-limit.ts', 12, 'rateLimit'],
  ['src/middleware/auth.ts', 10, 'verifyJwt'],
  ['src/db/pool.ts', 14, 'withRetry'],
  ['src/cache/lru.ts', 11, 'lruGet'],
  ['src/log/redact.ts', 9, 'redact'],
  ['src/routes/user.ts', 13, 'userRoutes'],
  ['src/utils/errors.ts', 8, 'wrapError'],
  ['src/config/env.ts', 10, 'loadEnv'],
]
const diffParts = files.map(([file, hunks, fn]) => {
  const body = Array.from({ length: hunks }, (_, hi) => synthHunk(file, fn + '_' + hi, 40)).join('\n\n')
  return 'diff --git a/' + file + ' b/' + file + '\n--- a/' + file + '\n+++ b/' + file + '\n' + body
})
const fullDiff = diffParts.join('\n\n')

function parseHunks(diff) {
  const out = []
  const lines = diff.split('\n')
  let cur = null
  let curFile = '(未知)'
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      curFile = line.replace('diff --git a/', '').replace(' b/', '').trim()
      curFile = curFile.split(' ')[0] ?? curFile
      continue
    }
    if (line.startsWith('@@')) {
      if (cur) out.push(cur)
      cur = { file: curFile, header: line, body: [line], chars: line.length }
      continue
    }
    if (cur) { cur.body.push(line); cur.chars += line.length }
  }
  if (cur) out.push(cur)
  return out
}

const MAX = 40_000
const hunks = parseHunks(fullDiff)
const totalChars = fullDiff.length
const sliced = fullDiff.slice(0, MAX)
const slicedHunks = parseHunks(sliced)
const filesInSliced = new Set(slicedHunks.map((h) => h.file))
const allFiles = new Set(hunks.map((h) => h.file))
const lastSliced = slicedHunks[slicedHunks.length - 1]
const lastSlicedBodyChars = lastSliced ? lastSliced.chars : 0
const lastInFull = lastSliced ? hunks.find((h) => h.header === lastSliced.header) : undefined
const cutMidHunk = lastInFull !== undefined && lastSlicedBodyChars < lastInFull.chars
const tokens = (c) => Math.round(c / 3.5)

console.log('=== P1-5 review diff 两级加载 量化 ===')
console.log('合成 diff：' + allFiles.size + ' 文件 / ' + hunks.length + ' hunk / ' + totalChars + ' chars（' + tokens(totalChars) + ' tok），超过 40K 阈值')
console.log('')
console.log('[现状 40K 定长截断]')
console.log('  可见文件 ' + filesInSliced.size + '/' + allFiles.size + '；可见 hunk ' + slicedHunks.length + '/' + hunks.length)
console.log('  切中 hunk 中间: ' + (cutMidHunk ? '是（该 hunk 被拦腰截断）' : '否'))
console.log('  注入 ' + tokens(sliced.length) + ' tok；被切内容无元数据，审查者不知丢了什么')
console.log('')
console.log('[两级加载：变更地图全量 + 相关 hunk 预算内]')
const mapLines = ['# 变更地图（' + allFiles.size + ' 文件，' + hunks.length + ' hunk）']
for (const f of allFiles) {
  const fh = hunks.filter((h) => h.file === f)
  mapLines.push('- ' + f + '（' + fh.length + ' hunk）：' + fh.map((h) => h.header.slice(4, 40)).join('；'))
}
const mapText = mapLines.join('\n')
console.log('  变更地图：' + tokens(mapText.length) + ' tok（恒全量，文件 0 丢失）')
const relevant = hunks.filter((h) => h.file.includes('rate-limit'))
const relevantChars = relevant.reduce((s, h) => s + h.chars, 0)
console.log('  相关 hunk（rate-limit）' + relevant.length + ' 个（' + tokens(relevantChars) + ' tok）全装入；预算外保留地图、经 fs-browse 按索引拉取')
console.log('  覆盖文件 ' + allFiles.size + '/' + allFiles.size)
console.log('')
console.log('结论判据:')
console.log('- 定长截断：' + (allFiles.size - filesInSliced.size) + ' 个尾部文件整丢、' + (hunks.length - slicedHunks.length) + ' 个 hunk 整丢' + (cutMidHunk ? '、1 个 hunk 被拦腰截断' : ''))
console.log('- 两级加载：地图全量（文件 0 丢失）+ 相关 hunk 优先 → 覆盖更全、可按需补拉')
