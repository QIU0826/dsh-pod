/**
 * 审批 → 合并回主树验证（架构不变量 3 唯一入口 ApplyPatch）。
 *
 * 用法：
 *   node scripts/approve-merge-verify.mjs [storeDir] [approvalId] [missionId] [note]
 * 缺省（无参数）= CR-32 的 divide 卡（reports/bakeoff-claude/store-claude-1787817576942）。
 * 步骤：ApprovalEngine.decide(approved) -> ApplyPatch.apply() 合并回主树。
 */

import { join } from 'node:path'
import { resolve } from 'node:path'
import { JsonStore } from '../dist/core/store.js'
import { ApprovalEngine } from '../dist/core/approvals.js'
import { ApplyPatch, execGitRunner } from '../dist/core/apply-patch.js'

const DEFAULT_STORE = join('reports', 'bakeoff-claude', 'store-claude-1787817576942')
const DEFAULT_APPROVAL = 'A-1787817943053-253739'
const DEFAULT_MISSION = 'M-BAKE-CLAUDE'

async function main() {
  const storeDir = process.argv[2] ?? DEFAULT_STORE
  const approvalId = process.argv[3] ?? DEFAULT_APPROVAL
  const missionId = process.argv[4] ?? DEFAULT_MISSION
  const note = process.argv[5] ?? 'approve-merge-verify'

  const store = new JsonStore({ rootDir: resolve(storeDir) })
  store.open()

  const before = store.getApproval(approvalId)
  console.log('[approve-merge] store=' + storeDir + ' approval=' + approvalId + ' before:', before ? before.status : 'MISSING')

  const engine = new ApprovalEngine(store)
  const decided = engine.decide(approvalId, 'approved', 'dsh-verifier', undefined, { merge_note: note })
  console.log('[approve-merge] decided:', decided.status, 'by', decided.decided_by)

  const applier = new ApplyPatch({ store, git: execGitRunner() })
  const result = await applier.apply(missionId, decided)
  console.log('[approve-merge] apply:', result.ok ? 'MERGE_OK ' + result.mergeCommit : 'FAIL conflict=' + result.conflict + ' ' + result.message)

  store.close()
  return result
}

main()
  .then((r) => {
    console.log('[approve-merge] RESULT', r.ok ? 'ok' : 'failed')
    if (!r.ok) process.exit(1)
  })
  .catch((e) => {
    console.error('[approve-merge] ERROR:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
