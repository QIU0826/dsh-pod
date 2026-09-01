/**
 * 真实 E2E 最小链路（2026-09-01，凭据恢复后）——ark worker 单任务 mission。
 *
 * 目的：凭据恢复后的全链路确认——launch → 协商 → 派发 → 真实 LLM 写码 → verifier
 * 质量门 → 审批卡 → approve 合并 → mission done。此前真实 E2E 一直被凭据阻塞
 * （08-30 记录：引擎/编排/流式链路正确，等有效凭据即可跑通），本脚本是那个收尾。
 *
 * 用法（先 build）：
 *   node scripts/e2e-ark-mini.mjs [--repo <path>]
 * 需要 ARK_API_KEY（环境变量或 ~/.claude/settings.json）；目标仓库必须存在。
 * 幂等：mission id 含时间戳；数据目录用临时目录（不污染 ~/.dsh/pod）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPodRuntime } from '../dist/core/pod-runtime.js'
import { PodService } from '../dist/pod-service.js'
import { ArkBackend } from '../dist/workers/ark-headless.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

function arkKey() {
  const env = process.env.ARK_API_KEY
  if (env !== undefined && env.length > 0) return env
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'))
    return settings.ARK_API_KEY ?? ''
  } catch { return '' }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

async function main() {
  const key = arkKey()
  if (key.length === 0) { console.error('[e2e] ARK_API_KEY missing'); process.exit(2) }
  const repo = arg('--repo', join(process.cwd(), '..', 'pod-demo-repo'))
  console.log('[e2e] repo:', repo)

  const dataDir = mkdtempSync(join(tmpdir(), 'pod-e2e-'))
  const runtime = createPodRuntime(dataDir)
  const service = new PodService({
    store: runtime.store,
    memory: runtime.memory,
    approvals: runtime.approvals,
    ledger: runtime.ledger,
    dataDir,
    backends: { ark: new ArkBackend({ apiKey: key }) },
  })

  const mission = service.launch({
    name: 'e2e-ark-' + Date.now().toString(36),
    goal: '在 src/util.ts 新增并导出函数 isEven(n: number): boolean（纯函数），补对应测试与 example.md 示例，测试通过后 commit（message 含 task-T-1）并输出 MISSION_REPORT',
    cwd: repo,
    budgetUsd: 0.5,
    approvalMode: 1,
    slots: [
      { id: 'S-1', vendor: 'ark', role: 'implementer', capabilities: ['编码', '测试'], model: 'deepseek-v4-flash' },
    ],
  })
  console.log('[e2e] launched:', mission.id, mission.status)

  // launch 内部已异步启动 orchestrator.run()；此处轮询等待审批卡（approvalMode 1 → 合并门）
  const poll = async (pred, timeoutMs, label) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const st = service.status()
      const v = pred(st)
      if (v) return st
      await new Promise((r) => setTimeout(r, 2_000))
    }
    throw new Error('timeout waiting for ' + label)
  }
  const atApproval = await poll((st) => st.mission?.status === 'awaiting_approval' || st.pendingApprovals.length > 0 || st.mission?.status === 'done' || st.mission?.status === 'aborted', 10 * 60_000, 'approval gate')
  console.log('[e2e] reached:', atApproval.mission?.status, 'pending approvals:', atApproval.pendingApprovals.length)
  if (atApproval.mission?.status === 'done' || atApproval.mission?.status === 'aborted') {
    console.log('[e2e] terminal before approval:', atApproval.mission?.status)
  }
  if (atApproval.pendingApprovals.length > 0) {
    const r = await service.approve(atApproval.pendingApprovals[0].id, 'e2e')
    console.log('[e2e] approve:', JSON.stringify(r))
  }
  const final = await poll((st) => st.mission?.status === 'done' || st.mission?.status === 'aborted', 5 * 60_000, 'mission terminal')
  console.log('[e2e] final mission status:', final.mission?.status)
  const doneTasks = final.tasks.filter((t) => t.status === 'done').length
  const ok = final.mission?.status === 'done' && doneTasks >= 1
  console.log('[e2e] tasks:', JSON.stringify(final.tasks.map((t) => ({ id: t.id, status: t.status, attempts: t.attempts, fault: t.fault ?? null }))))
  console.log('[e2e] VERDICT:', ok ? 'PASS — 真实全链路（协商→派发→写码→质量门→合并→done）闭环' : 'FAIL')

  runtime.close()
  rmSync(dataDir, { recursive: true, force: true })
  process.exit(ok ? 0 : 1)
}

void main().catch((e) => { console.error('[e2e] ERROR:', e instanceof Error ? e.message : e); process.exit(1) })
