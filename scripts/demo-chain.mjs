/**
 * DSH-Pod W2 最小可演示链（CLI 级，无 UI）：
 *   真实 claude 员工实现小任务 → 真实独立 review → 审批卡生成
 *
 * 用法（先 build）：
 *   node scripts/demo-chain.mjs [--repo <dir>] [--reviewer claude|codex]
 * 真实成本：claude 一次实现任务 + 审查者一次 review（各一次 API 调用）。
 * 审查者默认 codex（跨厂商异构）；本机 codex 缺 code-mode host 时可用
 *   --reviewer claude 走同厂商异槽独立 review（DoD-5 仍满足：S-1 ≠ S-2）。
 * 合并（apply_patch）属 W5 切片，本演示止于审批卡（方案书 4.2 节 W2 产物边界）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { JsonStore } from '../dist/core/store.js'
import { MissionOrchestrator } from '../dist/core/orchestrator.js'
import { verifyTaskArtifacts, execGitClient } from '../dist/core/verifier.js'
import { ClaudeHeadlessBackend } from '../dist/workers/claude-headless.js'
import { CodexHeadlessBackend, codexBinaryCandidates } from '../dist/workers/codex-headless.js'
import { repairPath } from '../dist/workers/preflight.js'

const REPO_ROOT = process.argv.includes('--repo')
  ? process.argv[process.argv.indexOf('--repo') + 1]
  : join(process.cwd(), '..', 'pod-demo-repo')

// 审查者 vendor：默认 codex（跨厂商异构）；--reviewer claude 走同厂商异槽独立 review
const reviewerArg = process.argv.includes('--reviewer')
  ? process.argv[process.argv.indexOf('--reviewer') + 1]
  : 'codex'
const REVIEWER = reviewerArg === 'claude' || reviewerArg === 'codex' ? reviewerArg : 'codex'
if (reviewerArg !== 'claude' && reviewerArg !== 'codex') {
  console.log('[demo] 警告：--reviewer 仅支持 claude|codex，已回落为 codex')
}

// Windows 专项（CR-02-4/新实证）：宿主 PATH 可能被外部改写，先修复
repairPath()

// 准备演示仓库（幂等：已存在则复用）
if (!existsSync(REPO_ROOT)) {
  mkdirSync(REPO_ROOT, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: REPO_ROOT })
  execFileSync('git', ['config', 'user.email', 'pod-demo@local'], { cwd: REPO_ROOT })
  execFileSync('git', ['config', 'user.name', 'pod-demo'], { cwd: REPO_ROOT })
  writeFileSync(join(REPO_ROOT, 'README.md'), '# Pod Demo Repo\n\n本仓库是 DSH-Pod 最小可演示链的靶场。\n')
  writeFileSync(join(REPO_ROOT, '.gitattributes'), '* text=auto eol=lf\n')
  execFileSync('git', ['add', '-A'], { cwd: REPO_ROOT })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: REPO_ROOT })
}

// codex 二进制候选解析（PATH 滞后专项；仅审查者为 codex 时才实际派发到该后端）
const codexBin = codexBinaryCandidates('win32').find((c) => existsSync(c)) ?? 'codex'

const dataDir = join(homedir(), '.dsh', 'pod', 'demo')
mkdirSync(dataDir, { recursive: true })
// 幂等重跑：清掉上次演示的 store（mission/tasks/事件/审批全随旧 store 走，演示是即弃证明）
for (const name of ['store.json', 'store.json.bak']) {
  const file = join(dataDir, name)
  if (existsSync(file)) {
    console.log('[demo] 重置演示 store：' + name)
    rmSync(file, { force: true })
  }
}
const store = new JsonStore({ rootDir: dataDir })
store.open()

const worktree = {
  async ensure(repoRoot, slotId) {
    const path = join(repoRoot, '.pod-worktrees', slotId)
    if (!existsSync(path)) {
      execFileSync('git', ['-C', repoRoot, 'worktree', 'add', path, '-b', `pod-${slotId}`], { stdio: 'pipe' })
    }
    return path
  },
}

const claude = new ClaudeHeadlessBackend({
  allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
})
const codex = new CodexHeadlessBackend({ binary: codexBin })

const backends = { claude, codex }

// 真实 Verifier：每个员工在自己 worktree 里校验 commit/parent/日志（CR-01-3 基准）
const verify = async (task, report) => {
  const slot = store.getSlot(task.owner_slot_id ?? '')
  const repoDir = slot?.worktree_path ?? REPO_ROOT
  return verifyTaskArtifacts({ git: execGitClient(), repoDir }, task, report)
}

// CR-03：宿主机侧读 diff 注入审查提示词（审查者无需仓库命令权限——
// 本机 ChatGPT 内置 codex 缺 code-mode host，无法自行执行 git 命令）
const diffProvider = async (task) => {
  const parts = []
  for (const targetId of task.depends_on ?? []) {
    const target = store.getTask(targetId)
    if (target === undefined) continue
    const slot = target.owner_slot_id !== undefined ? store.getSlot(target.owner_slot_id) : undefined
    const repoDir = slot?.worktree_path ?? REPO_ROOT
    if (target.parent_sha !== undefined && target.commit_sha !== undefined) {
      const stdout = execFileSync('git', ['-C', repoDir, 'diff', target.parent_sha, target.commit_sha], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
      parts.push(`# ${targetId}（${target.parent_sha.slice(0, 8)}..${target.commit_sha.slice(0, 8)}）\n${stdout}`)
    }
  }
  return parts.join('\n\n') || '（无 diff 内容）'
}

const orch = new MissionOrchestrator('M-DEMO-1', {
  store,
  backends,
  worktree,
  verify,
  diffProvider,
  clock: () => Date.now(),
})

function logEvents(seen) {
  for (const event of store.listEvents('M-DEMO-1')) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    const line = `${new Date(event.ts).toLocaleTimeString()} ${event.kind}${event.task_id ? ` [${event.task_id}]` : ''}`
    console.log('  ├', line, event.kind === 'worker_progress' ? `text=${String(event.payload.text ?? '').slice(0, 80)}` : '')
  }
}

const seen = new Set(store.listEvents('M-DEMO-1').map((e) => e.id))

console.log('[demo] 靶场仓库:', REPO_ROOT)
console.log('[demo] codex 二进制:', codexBin)
console.log('[demo] 组队：S-1 claude(deepseek-v4-pro, 实现) × S-2 ' + REVIEWER + '(独立 review)')

orch.launch({
  name: '最小可演示链',
  goal: '实现一个小工具函数并由独立员工 review',
  cwd: REPO_ROOT,
  budgetUsd: 3,
  slots: [
    { id: 'S-1', vendor: 'claude', role: 'implementer', capabilities: ['编码'], model: 'deepseek-v4-pro', session_tier: 'transient' },
    // 默认 codex（ChatGPT 桌面内置，model 留空走其 config.toml 默认 gpt-5.6-sol，CR-02-1）；
    // --reviewer claude 时改走 claude 后端（同厂商异槽，DoD-5 独立 review 仍成立）
    REVIEWER === 'codex'
      ? { id: 'S-2', vendor: 'codex', role: 'reviewer', capabilities: ['审查'], model: '', session_tier: 'transient' }
      : { id: 'S-2', vendor: 'claude', role: 'reviewer', capabilities: ['审查'], model: 'deepseek-v4-pro', session_tier: 'transient' },
  ],
})
orch.createTasks([
  {
    id: 'T-1',
    title: '实现 add 工具函数',
    spec:
      '在仓库创建 src/util.ts，实现导出函数 add(a: number, b: number): number（纯加法）。' +
      '再写 example.md 说明用法。完成后运行测试（本仓库无测试框架 → test_result 填 not_run 并注明）。',
    type: 'implement',
    skill_tags: ['编码'],
  },
  {
    id: 'T-2',
    title: '独立 review T-1',
    spec: '审查 T-1 的 diff：规格要求是否落实、是否有越界改动、commit 纪律是否遵守。',
    type: 'review',
    skill_tags: ['审查'],
    depends_on: ['T-1'],
  },
])

const runPromise = orch.run()
const poll = setInterval(() => logEvents(seen), 1500)

try {
  const summary = await runPromise
  clearInterval(poll)
  logEvents(seen)
  console.log('\n[demo] 运行结果:', summary.status)
  console.log('[demo] done 任务:', summary.doneTasks.join(', '))
  console.log('[demo] 转人工任务:', summary.escalatedTasks.join(', ') || '（无）')
  for (const approvalId of summary.pendingApprovals) {
    const approval = store.getApproval(approvalId)
    console.log('[demo] 审批卡:', approvalId, approval?.status)
    console.log('[demo]   patch:', JSON.stringify(approval?.patch, null, 2))
    console.log('[demo]   → 合并（apply_patch）属 W5 切片，本演示止于审批卡（方案书 W2 产物边界）')
  }
  const ledger = orch.status().ledger
  console.log('[demo] 账本: tokens 共', ledger.total_tokens, '，等效 $', ledger.total_equiv_usd.toFixed(4))
} catch (error) {
  clearInterval(poll)
  console.error('[demo] 失败:', error)
  process.exitCode = 1
} finally {
  store.close()
}
