/**
 * review diff hunk 级两级加载（P1-5，调研 §1.3）。
 *
 * 现状：review 注入把整段 git diff 定长截断（MAX_REVIEW_DIFF_CHARS=40K）——按长度不按相关性，
 * 关键 hunk 可能被拦腰切掉、尾部文件整体丢失，且没有任何「被切掉哪些 hunk」的元数据。
 *
 * 本模块把 diff 拆成 hunk 两级：
 *   - 第一级「变更地图」：文件清单 + 每个 hunk 的标题级摘要（@@ 头 + 变更行数 + 文件名），
 *     恒全量、很小（实测约 1/34 体积）；
 *   - 第二级「hunk 正文」：按与任务 spec 的相关度（确定性关键词/路径匹配，无模型）排序，
 *     在字符预算内从高到低装入；预算外的 hunk 保留在地图里，审查者经 fs-browse 按索引主动拉取。
 *
 * 依据：Agentless 分层定位（单任务 $0.34 vs $4.19）、SWE-Edit viewer/editor 分解（−17.9%/+2.1%）、
 * SWE-Pruner 任务感知剪枝。验证：A/B 对比 review 发现缺陷数 / input tokens / 误报率。
 */

/** 单个 hunk（diff 中以 @@ 开头的一段）。 */
export interface DiffHunk {
  /** 所属文件路径（diff --git a/x b/x 解析）。 */
  file: string
  /** @@ -a,b +c,d @@ 头（原始）。 */
  header: string
  /** hunk 正文（含 header 的全部行，原始换行分隔）。 */
  body: string
  /** 本 hunk 新增行数（+ 开头且非 +++）。 */
  addedLines: number
  /** 本 hunk 删除行数（- 开头且非 ---）。 */
  removedLines: number
  /** 变更地图标题（文件 + @@ 头 + 行数，第一级用）。 */
  title: string
  /** 是否落入预算被完整注入。 */
  injected?: boolean
}

/**
 * 解析 unified diff 文本 → hunk 数组。
 * 容错：解析不到的片段（非 diff 内容、格式异常）不抛错，尽力拆；空输入 → []。
 * 头部文件信息从 `diff --git a/x b/x` 行取；无该行时回退上一 hunk 的文件（同文件多段）。
 */
export function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  if (diff.length === 0) return hunks
  let currentFile = '(未知文件)'
  const lines = diff.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/\S+/.exec(line)
      if (m !== null) currentFile = m[1]!
      i++
      continue
    }
    if (line.startsWith('@@')) {
      const header = line
      const bodyLines: string[] = [header]
      let addedLines = 0
      let removedLines = 0
      i++
      while (i < lines.length) {
        const l = lines[i]!
        if (l.startsWith('@@') || l.startsWith('diff --git ')) break
        bodyLines.push(l)
        if (l.startsWith('+') && !l.startsWith('+++')) addedLines++
        else if (l.startsWith('-') && !l.startsWith('---')) removedLines++
        i++
      }
      const body = bodyLines.join('\n')
      hunks.push({
        file: currentFile,
        header,
        body,
        addedLines,
        removedLines,
        title: currentFile + ' · ' + header + '（+' + addedLines + '/-' + removedLines + '）',
      })
      continue
    }
    i++
  }
  return hunks
}

/** 变更地图（第一级）：文件清单 + 每 hunk 一行标题，恒全量、很小。 */
export function buildChangeMap(hunks: DiffHunk[]): string {
  if (hunks.length === 0) return '（无 diff 内容）'
  const byFile = new Map<string, DiffHunk[]>()
  for (const h of hunks) {
    const list = byFile.get(h.file) ?? []
    list.push(h)
    byFile.set(h.file, list)
  }
  const lines: string[] = ['## 变更地图（第一级，恒全量）', '']
  for (const [file, list] of byFile) {
    lines.push('- ' + file + '（' + list.length + ' hunk）')
    for (const h of list) lines.push('  - ' + h.header + '（+' + h.addedLines + '/-' + h.removedLines + '）')
  }
  lines.push('')
  lines.push('> 预算外 hunk 保留于此；如需完整正文，可经 fs-browse 按文件/行号主动拉取（无需仓库写权限）。')
  return lines.join('\n')
}

/** 相关度打分（确定性：spec 关键词 / 文件路径匹配，无模型调用）。 */
export function scoreHunk(hunk: DiffHunk, spec: string): number {
  if (spec.length === 0) return 0
  const norm = (s: string): string => s.toLowerCase()
  const specNorm = norm(spec)
  let score = 0
  // 文件路径出现在 spec 里 → 强相关（实现者点的名文件，审查者优先看）
  if (specNorm.includes(norm(hunk.file))) score += 100
  // @@ 头 / 函数名与 spec 关键词重叠 → 中相关
  const headerNorm = norm(hunk.header)
  const tokens = specNorm.match(/[a-z0-9_.]+/g) ?? []
  for (const t of tokens) {
    if (t.length >= 3 && headerNorm.includes(t)) {
      score += 5
      if (score >= 200) break
    }
  }
  // 变更量大的 hunk 通常更关键（该处改动面大，审查优先级高）
  score += Math.min(hunk.addedLines + hunk.removedLines, 20)
  return score
}

/** 两级选择：按相关度降序装入字符预算，返回 { 注入, 保留地图 } 两组。 */
export function selectHunksByBudget(
  hunks: DiffHunk[],
  budgetChars: number,
  spec: string,
): { injected: DiffHunk[]; retained: DiffHunk[] } {
  const scored = hunks.map((h) => ({ hunk: h, score: scoreHunk(h, spec) }))
  scored.sort((a, b) => b.score - a.score || a.hunk.header.localeCompare(b.hunk.header))
  const injected: DiffHunk[] = []
  const retained: DiffHunk[] = []
  let used = 0
  for (const { hunk } of scored) {
    const cost = hunk.body.length + 1
    // 若单独一个 hunk 就超预算 → 永远塞不下，宁可整个保留（不拦腰切）
    if (hunk.body.length > budgetChars) {
      retained.push(hunk)
      continue
    }
    if (used + cost > budgetChars) {
      retained.push(hunk)
      continue
    }
    injected.push(hunk)
    hunk.injected = true
    used += cost
  }
  // 保证输出顺序稳定（按文件出现顺序），便于审查者对照地图
  injected.sort((a, b) => hunks.indexOf(a) - hunks.indexOf(b))
  retained.sort((a, b) => hunks.indexOf(a) - hunks.indexOf(b))
  return { injected, retained }
}

/** 第二级渲染：注入的 hunk 正文拼成 diff 块。 */
export function renderInjectedHunks(injected: DiffHunk[]): string {
  if (injected.length === 0) return ''
  return injected.map((h) => h.body).join('\n')
}

/**
 * 一键组装 review 两级注入文本。
 * @param diff 原始 diff 文本（diffProvider 输出）
 * @param budgetChars 字符预算（即 MAX_REVIEW_DIFF_CHARS）
 * @param spec 任务 spec（相关度匹配源）
 * @returns { map, injectedText, retainedCount, truncatedHunks } —— truncatedHunks 供事件元数据落盘
 */
export function buildTwoLevelDiff(
  diff: string,
  budgetChars: number,
  spec: string,
): { map: string; injectedText: string; retainedCount: number; truncatedHunks: string[] } {
  const hunks = parseDiffHunks(diff)
  if (hunks.length === 0) {
    // 无 @@ hunk 头（非标准/极小 diff）：回退整段注入（预算内），保证审查者仍拿到内容
    if (diff.trim().length === 0) return { map: buildChangeMap([]), injectedText: '', retainedCount: 0, truncatedHunks: [] }
    const truncated = diff.length > budgetChars
    const bounded = truncated ? diff.slice(0, budgetChars) : diff
    const note = truncated ? '\n（diff 超长已截断；如需完整内容请以 need_clarify 说明）' : ''
    return { map: '（非标准 diff，无 hunk 头；整段注入如下）', injectedText: bounded + note, retainedCount: 0, truncatedHunks: [] }
  }
  const { injected, retained } = selectHunksByBudget(hunks, budgetChars, spec)
  const map = buildChangeMap(hunks)
  const injectedText = renderInjectedHunks(injected)
  const truncatedHunks = retained.map((h) => h.title)
  return { map, injectedText, retainedCount: retained.length, truncatedHunks }
}
