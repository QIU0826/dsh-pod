/**
 * A/B：单 harness vs dsh-pod —— 同一个任务、同一份起点，量三件事。
 *
 *   臂 A（单 harness）：一个 claude -p 直接做完整任务（含自查）。
 *   臂 B（pod）：claude 实现 → **opencode（GLM，另一家模型）独立审查** → 质检门 → 人工审批合并。
 *
 * 尺子 = **留出测试（held-out）**：任务书里只写常规要求，留出测试专打容易漏的边界
 * （空字段 / 字面双引号 / 引号包空串 / 尾随逗号…）。两臂跑完后**同一套留出测试**分别打分——
 * 这是「独立验证是否真的多抓到缺陷」的客观依据，不是自我声称。
 *
 * 用法（先 npm run build）：node scripts/ab-single-vs-pod.mjs [--keep]
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPodRuntime } from '../dist/core/pod-runtime.js'
import { PodService } from '../dist/pod-service.js'
import { ClaudeHeadlessBackend } from '../dist/workers/claude-headless.js'
import { OpenCodeHeadlessBackend, opencodeBinaryCandidates } from '../dist/workers/opencode-headless.js'
import { repairPath } from '../dist/workers/preflight.js'

const KEEP = process.argv.includes('--keep')
const ROOT = mkdtempSync(join(tmpdir(), 'pod-ab-'))

// ── 任务（两臂完全一致） ─────────────────────────────────────────────────────
const GOAL =
  '在 src/csv.ts 实现并导出 parseCsvLine(line: string): string[]：解析一行 CSV，字段以逗号分隔；' +
  '字段可以被双引号包裹，包裹时字段内可含逗号，且用两个连续双引号 "" 表示一个字面双引号。' +
  '补 tests/csv.test.ts 测试并运行；完成后 git commit（message 含 task-T-1）。'

// ── 留出测试（任务书没写、但正确实现必须过） ─────────────────────────────────
const HELDOUT = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsvLine } from '../src/csv.ts'

test('quoted field containing comma', () => { assert.deepEqual(parseCsvLine('a,"b,c",d'), ['a','b,c','d']) })
test('escaped quote inside quoted field', () => { assert.deepEqual(parseCsvLine('"a""b"'), ['a"b']) })
test('empty middle field', () => { assert.deepEqual(parseCsvLine('a,,b'), ['a','','b']) })
test('quoted empty string', () => { assert.deepEqual(parseCsvLine('a,"",b'), ['a','','b']) })
test('only a comma → two empty fields', () => { assert.deepEqual(parseCsvLine(','), ['','']) })
test('single quoted field', () => { assert.deepEqual(parseCsvLine('"a"'), ['a']) })
test('quote kept literally when not wrapping', () => { assert.deepEqual(parseCsvLine('a,b"c'), ['a','b"c']) })
test('trailing comma → trailing empty field', () => { assert.deepEqual(parseCsvLine('a,b,'), ['a','b','']) })
`

function seedRepo(dir) {
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'tests'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ab-scratch', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n')
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const VERSION = "0.0.0"\n')
  spawnSync('git', ['init', '-q'], { cwd: dir })
  spawnSync('git', ['add', '-A'], { cwd: dir })
  spawnSync('git', ['-c', 'user.email=ab@local', '-c', 'user.name=ab', 'commit', '-qm', 'seed'], { cwd: dir })
}

/** 跑留出测试，返回 {pass, fail}。 */
function runHeldout(dir) {
  const dest = join(dir, 'tests', 'heldout.test.ts')
  writeFileSync(dest, HELDOUT)
  const csvExists = existsSync(join(dir, 'src', 'csv.ts'))
  if (!csvExists) return { pass: 0, fail: 8, note: 'src/csv.ts 不存在' }
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--test', 'tests/heldout.test.ts'], { cwd: dir, encoding: 'utf8', timeout: 60_000 })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const pass = Number((/^# pass (\d+)/m.exec(out) ?? [])[1] ?? 0)
  const fail = Number((/^# fail (\d+)/m.exec(out) ?? [])[1] ?? 8)
  return { pass, fail, note: r.status === 0 ? 'ok' : 'some failed' }
}

const fmt = (n) => '$' + n.toFixed(4)
const secs = (ms) => (ms / 1000).toFixed(0) + 's'

// ── 臂 A：单 harness ────────────────────────────────────────────────────────
async function armSingle(repo) {
  const t0 = Date.now()
  const env = { ...process.env }
  const extra = repairPath('win32')
  if (extra.length > 0) env.PATH = [...extra, env.PATH ?? ''].join(';')
  if (env.CLAUDE_CODE_GIT_BASH_PATH === undefined) env.CLAUDE_CODE_GIT_BASH_PATH = 'D:\\STUDYSOFT\\Git\\bin\\bash.exe'

  const p = spawn('claude', ['-p', GOAL, '--output-format', 'json', '--permission-mode', 'bypassPermissions'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (b) => { out += String(b) })
  p.stderr.on('data', (b) => { out += String(b) })
  await new Promise((res) => { p.on('close', res); setTimeout(() => p.kill(), 20 * 60_000) })
  const cost = Number((/"total_cost_usd":([\d.]+)/.exec(out) ?? [])[1] ?? 0)
  return { ms: Date.now() - t0, cost, raw: out.slice(-600) }
}

// ── 臂 B：pod ──────────────────────────────────────────────────────────────
async function armPod(repo) {
  const t0 = Date.now()
  const dataDir = mkdtempSync(join(tmpdir(), 'pod-ab-data-'))
  const runtime = createPodRuntime(dataDir)
  const ocBin = opencodeBinaryCandidates(process.platform).find((c) => existsSync(c)) ?? 'opencode'
  const service = new PodService({
    store: runtime.store, memory: runtime.memory, approvals: runtime.approvals, ledger: runtime.ledger, dataDir,
    backends: {
      claude: new ClaudeHeadlessBackend({ allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'] }),
      opencode: new OpenCodeHeadlessBackend({ binary: ocBin }),
    },
  })
  const mission = service.launch({
    name: 'ab-pod-' + Date.now().toString(36), goal: GOAL, cwd: repo, budgetUsd: 1.5, approvalMode: 1,
    slots: [
      { id: 'S-1', vendor: 'claude', role: 'implementer', capabilities: ['编码', '测试'] },
      { id: 'S-2', vendor: 'opencode', role: 'reviewer', capabilities: ['审查'] },
    ],
  })
  console.log('[AB] pod mission:', mission.id)
  const deadline = Date.now() + 25 * 60_000
  let approved = false
  let last = ''
  while (Date.now() < deadline) {
    const st = service.status()
    last = String(st.mission?.status)
    if (st.pendingApprovals.length > 0 && !approved) {
      approved = true
      try { service.approve(st.pendingApprovals[0].id) } catch (e) { console.error('[AB] approve failed', e.message) }
    }
    if (last === 'done' || last === 'aborted' || last === 'needs_human') break
    await new Promise((r) => setTimeout(r, 3000))
  }
  let cost = 0
  try { cost = service.status().ledger?.total_equiv_usd ?? 0 } catch { /* ignore */ }
  return { ms: Date.now() - t0, cost, status: last }
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
const repoA = join(ROOT, 'arm-single')
const repoB = join(ROOT, 'arm-pod')
seedRepo(repoA)
seedRepo(repoB)
console.log(`[AB] 任务相同 · 起点相同 · 仓库 ${ROOT}`)

let a; let b
try {
  console.log('[AB] 臂 A（单 harness）开跑…')
  a = await armSingle(repoA)
  console.log(`[AB] 臂 A 完成 ${secs(a.ms)} ${fmt(a.cost)}`)
} catch (e) { a = { ms: 0, cost: 0, err: String(e) }; console.error('[AB] 臂 A 失败', e) }

try {
  console.log('[AB] 臂 B（pod：claude 实现 + GLM 审查）开跑…')
  b = await armPod(repoB)
  console.log(`[AB] 臂 B 完成 ${secs(b.ms)} ${fmt(b.cost)} status=${b.status}`)
} catch (e) { b = { ms: 0, cost: 0, err: String(e) }; console.error('[AB] 臂 B 失败', e) }

const ra = runHeldout(repoA)
const rb = runHeldout(repoB)

console.log('\n================ A/B 结果（留出测试为准） ================')
console.log('指标             | 单 harness        | dsh-pod')
console.log('-----------------|-------------------|------------------')
console.log(`漏检缺陷（留出差）| ${ra.fail} 个            | ${rb.fail} 个`)
console.log(`留出通过          | ${ra.pass}/8            | ${rb.pass}/8`)
console.log(`墙钟              | ${secs(a.ms)}              | ${secs(b.ms)}`)
console.log(`成本(equiv)       | ${fmt(a.cost)}          | ${fmt(b.cost)}`)
console.log(`是否产出代码      | ${existsSync(join(repoA, 'src', 'csv.ts')) ? '是' : '否'}                | ${existsSync(join(repoB, 'src', 'csv.ts')) ? '是' : '否'}`)
console.log('=========================================================\n')

if (!KEEP) rmSync(ROOT, { recursive: true, force: true })
else console.log('[AB] --keep：仓库保留在', ROOT)
