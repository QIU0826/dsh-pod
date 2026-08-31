import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JsonStore } from '../dist/core/store.js'
import { buildResetSummary } from '../dist/core/session-tiers.js'

// P1-1 量化：档位 C 重置摘要「整份重写」成本与信息丢失（brevity bias / context collapse），
// 对比 ACE 式增量 delta 账本（任务完成时入账一次，重置时只渲染 active 条目）。

const now = 1_700_000_000_000
const root = mkdtempSync(join(tmpdir(), 'pod-measure-reset-'))
const store = new JsonStore({ rootDir: root, clock: () => now })
store.open()

const missionId = 'M-1'
const slotId = 'S-1'
store.createMission({ id: missionId, name: 'm', goal: 'g', budget_usd: 100, budget_tokens: 1e9, cwd: root })
store.createSlot({ id: slotId, mission_id: missionId, vendor: 'claude', role: 'implementer', capabilities: ['编码'], model: 'deepseek-v4-pro', session_tier: 'per-mission', effort: 'medium' })

function addTask(id, title, commit, testResult, evidence, decisions) {
  store.createTask({
    id, mission_id: missionId, title, spec: 'spec-' + id, skill_tags: [], type: 'implement',
    depends_on: [], status: 'done', attempts: 1, soft_attempts: 0, max_wall_clock_ms: 3600_000,
    created_at: now, updated_at: now, owner_slot_id: slotId,
    commit_sha: commit, result_summary: 'summary-' + id,
    test_result: testResult, test_evidence: evidence, decisions,
  })
}

const tasks = [
  ['T-1', '实现 rate limiter', 'a1b2c3', 'pass', '12/12 ✓', ['token bucket']],
  ['T-2', 'JWT 校验中间件', 'd4e5f6', 'pass', '8/8 ✓', ['黑名单前置']],
  ['T-3', 'db 连接池重试', 'g7h8i9', 'fail', '5/9 ✗', ['熔断阈值 0.5']],
  ['T-4', '缓存层', 'j0k1l2', 'pass', '15/15 ✓', ['LRU 1024']],
  ['T-5', '日志脱敏', 'm3n4o5', 'pass', '6/6 ✓', ['只落 hash']],
];
for (const t of tasks) addTask(t[0], t[1], t[2], t[3], t[4], t[5])

const tokens = (chars) => Math.round(chars / 3.5)

// 旧路径：每次重置整份重写（重扫所有 done 任务）
const R = 5;
let oldTotalChars = 0;
const oldPerReset = [];
for (let i = 0; i < R; i++) {
  const s = buildResetSummary(store, missionId, slotId);
  oldTotalChars += s.length;
  oldPerReset.push(s.length);
}

const oldSummary = buildResetSummary(store, missionId, slotId);
const hasTest = oldSummary.includes('12/12') || oldSummary.includes('5/9');
const hasDecision = oldSummary.includes('token bucket');

// 新路径：任务完成时入账一次（fact 含测试结果与决策），重置只渲染 active
const factOf = (t) => 'T:' + t[0] + ' ' + t[1] + ': commit ' + t[2] + ', 测试 ' + t[3] + ' ' + t[4] + ', 决策 [' + t[5].join('; ') + ']';
const ledgerChars = tasks.map(factOf).join('\n').length;
const renderChars = tasks.map(factOf).join('\n').length;
const newTotalChars = ledgerChars + R * renderChars; // 入账一次 + R 次渲染

console.log('=== P1-1 重置摘要 delta 账本 量化 ===')
console.log('任务数 ' + tasks.length + '，模拟重置次数 R=' + R)
console.log('')
console.log('[成本] 旧路径（每次重置整份重写）:')
console.log('  每次重置 ' + oldPerReset.map((c) => tokens(c)).join(' / ') + ' tok，R 次累计 ≈ ' + tokens(oldTotalChars) + ' tok')
console.log('[成本] 新路径（ACE 增量账本）:')
console.log('  入账一次 ' + tokens(ledgerChars) + ' tok + 渲染 ' + R + ' 次 × ' + tokens(renderChars) + ' tok ≈ ' + tokens(newTotalChars) + ' tok')
console.log('  成本比：新/旧 ≈ ' + (newTotalChars / oldTotalChars).toFixed(2) + '（<1 即增量优于整写；重置越频差距越大）')
console.log('')
console.log('[信息保留] 旧摘要丢细节（brevity bias 实证面）:')
console.log('  测试证据入摘要: ' + (hasTest ? '是' : '否（丢失）') + '；决策入摘要: ' + (hasDecision ? '是' : '否（丢失）'))
console.log('')
console.log('结论判据:')
console.log('- 若 delta 成本 < 整写成本 且 信息保留更高 → 值得实现（ACE 主张）')
console.log('- 若项目重置频率低（R≈1）→ 成本收益小，但信息保留仍是独立收益（防断片）')

rmSync(root, { recursive: true, force: true })