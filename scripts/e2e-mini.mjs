/**
 * 真实 E2E 最小链路（2026-09-01，凭据恢复后）——claude 后端单任务 mission。
 *
 * 目的：凭据恢复后的全链路确认——launch → 协商 → 派发 → 真实 LLM 写码 → verifier
 * 质量门 → 审批卡 → approve 合并 → mission done。此前真实 E2E 一直被凭据阻塞
 * （08-30 记录：引擎/编排/流式链路正确，等有效凭据即可跑通），本脚本是那个收尾。
 *
 * 为什么用 claude 而非 ark：ark 是 agent-plan 端点（对话/规划型），extractReport
 * 提取不到 MISSION_REPORT（实测 mismatch）——只适合文本问答，不适合写码 worker；
 * claude headless（DeepSeek 配置）已被 memory-eval-code 实证可真实写码（8/8 done）。
 *
 * 用法（先 build）：
 *   node scripts/e2e-mini.mjs [--repo <path>]
 * 需要 claude 后端可用（~/.claude/settings.json DeepSeek 配置）；目标仓库必须存在。
 * 幂等：mission id 含时间戳；数据目录用临时目录（不污染 ~/.dsh/pod）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPodRuntime } from '../dist/core/pod-runtime.js'
import { PodService } from '../dist/pod-service.js'
import { ClaudeHeadlessBackend } from '../dist/workers/claude-headless.js'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

async function main() {
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
    backends: {
      claude: new ClaudeHeadlessBackend({ allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'] }),
    },
  })

  const mission = service.launch({
    name: 'e2e-' + Date.now().toString(36),
    goal: '在 src/util.ts 新增并导出函数 isEven(n: number): boolean（纯函数），补对应测试（tests/isEven.test.ts）与 example.md 示例；运行测试并把测试输出保存为 out/task-T-1.testlog，MISSION_REPORT 的 test_evidence 字段必须注明输出路径（如 out/task-T-1.testlog）；测试通过后 git commit（message 含 task-T-1），MISSION_REPORT 的 commit_sha 填真实 commit hash',
    cwd: repo,
    budgetUsd: 0.5,
    approvalMode: 1,
    slots: [
      { id: 'S-1', vendor: 'claude', role: 'implementer', capabilities: ['编码', '测试'], model: 'deepseek-v4-pro' },
      // 默认两步链（CR-06-5：实现 + 独立 review）需要审查者槽位——只配 implementer
      // 时 review 无人可派 → escalated「no routable slot」，mission 停在 running 不 done
      { id: 'S-2', vendor: 'claude', role: 'reviewer', capabilities: ['审查', '编码'], model: 'deepseek-v4-pro' },
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
