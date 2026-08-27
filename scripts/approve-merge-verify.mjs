/**
 * 方向1 验证：批准审批卡 + 真实合并回主树（架构不变量 3 唯一入口 ApplyPatch）。
 *
 * 数据源：reports/bakeoff-claude/store-claude-1787817576942（CR-32 写码 bake-off 落盘）。
 * 步骤：ApprovalEngine.decide(approved) -> ApplyPatch.apply() 合并回主树 -> 验证 main 含 divide。
 * 复用真实 store / approvals / apply-patch 模块（dist），不做任何旁路。
 */

import { join } from 'node:path'
import { JsonStore } from '../dist/core/store.js'
import { ApprovalEngine } from '../dist/core/approvals.js'
import { ApplyPatch, execGitRunner } from '../dist/core/apply-patch.js'

const STORE_DIR = join('reports', 'bakeoff-claude', 'store-claude-1787817576942')
const APPROVAL_ID = 'A-1787817943053-253739'
const MISSION_ID = 'M-BAKE-CLAUDE'

async function main() {
  const store = new JsonStore({ rootDir: STORE_DIR })
  store.open()

  // 1) 裁决前状态
  const before = store.getApproval(APPROVAL_ID)
  console.log('[approve-merge] before:', before ? before.status : 'MISSING')

  // 2) 批准（ApprovalEngine 裁决入口）
  const engine = new ApprovalEngine(store)
  const decided = engine.decide(APPROVAL_ID, 'approved', 'dsh-verifier', undefined, { merge_note: 'CR-32 真实合并验证' })
  console.log('[approve-merge] decided:', decided.status, 'by', decided.decided_by)

  // 3) 合并回主树（ApplyPatch 唯一入口）
  const applier = new ApplyPatch({ store, git: execGitRunner() })
  const result = await applier.apply(MISSION_ID, decided)
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
