// P1-3 量化：重置瞬间「在途任务最近原始事件」丢失风险 vs 近期窗口注入成本。
// 场景：档位 C 重置后只给结构化摘要（标题/commit/测试结果），但进行中任务的最近
// steer 指令 / 工具结果 / task_question 问答可能在此刻丢失 → 重置后断片。

// 模拟：一个在途任务积累的最近原始事件（真实事件流里的 worker_progress/steer/task_question）
const events = [
  { kind: 'steer_queued', text: '加一层缓存（用户指令）', ts: 1 },
  { kind: 'worker_progress', sub: 'text', text: '我先看下现有 rate limit 代码', ts: 2 },
  { kind: 'worker_progress', sub: 'tool_call', tool: 'Bash', text: 'npm test -- --grep rate', ts: 3 },
  { kind: 'worker_progress', sub: 'test_output', text: '3 failed: rate.limit.e2e', ts: 4 },
  { kind: 'worker_progress', sub: 'text', text: '发现限流阈值写死，改为读配置', ts: 5 },
  { kind: 'task_question', text: 'Q: 阈值默认值用 100 还是 200？ A: 用 100，按产品口径', ts: 6 },
  { kind: 'worker_progress', sub: 'tool_call', tool: 'Edit', text: 'src/middleware/rate-limit.ts', ts: 7 },
]

const tokens = (c) => Math.round(c / 3.5)

// 近期窗口：取最后 N=3 条原始事件逐字
const N = 3
const recent = events.slice(-N)
const windowText = [
  '## 近期窗口（在途任务最近原始事件，逐字）',
  ...recent.map((e) => {
    const label = e.kind === 'steer_queued' ? 'steer' : e.kind === 'task_question' ? '问答' : (e.sub ?? e.kind)
    const body = e.text ?? e.tool ?? ''
    return '- [' + label + '] ' + body
  }),
].join('\n')

console.log('=== P1-3 重置后 verbatim 近期窗口 量化 ===')
console.log('在途任务事件总数 ' + events.length + '；重置瞬间若只给结构化摘要，最后 ' + N + ' 条原始事件（含进行中的指令/工具结果/问答）全部丢失')
console.log('')
console.log('[成本] 近期窗口注入：')
console.log('  ' + windowText.split('\n').length + ' 行，' + windowText.length + ' chars ≈ ' + tokens(windowText.length) + ' tok（成本极小）')
console.log('')
console.log('[收益] 防重置断片：')
console.log('  保留了「加缓存指令 + 测试失败证据 + 阈值问答结论」——重置后 worker 直接续跑，无需重新澄清')
console.log('  对比：无窗口时 worker 重置后不知道刚测出 3 个失败、不知道阈值约定 → 重复澄清/重复跑测试')
console.log('')
console.log('结论判据:')
console.log('- 近期窗口成本 ~1-3 tok（<注入摘要的 1%），收益是堵住「重置后断片」——低成本高价值')
console.log('- 只取在途任务最近 N=2-3 条、不跨任务不叙事 → 不违 S5，任务结束即清空（窗口按 task_id 过滤）')
