/**
 * 会话重置摘要的 ACE 化 delta 账本（P1-1，调研 §2.1，arXiv:2510.04618）。
 *
 * 背景：档位 C 重置摘要旧实现每次「整份重写」（重扫全部 done 任务）——文献点名两种失败模式：
 * brevity bias（越压越短、领域细节流失）与 context collapse（迭代改写侵蚀细节）。
 * 实测（scripts/measure-reset-ledger.mjs）：旧摘要每任务只留 2/5 字段（title/commit/status），
 * 测试结果与决策全部丢失。
 *
 * 本模块按 ACE 三角色落地，全部确定性骨架（不依赖 LLM）：
 *   - Generator：任务完成时入账一条 fact 条目（Rich：commit/测试结果/决策），只写一次；
 *   - Curator：被新条目推翻的旧条目标 superseded（保留不删，可审计）；同源去重合并；
 *   - Reflector：重置时只渲染 active 条目（不重扫、不重写），信息随任务完成逐条累积。
 *
 * 与 memory.ts 的 typed relation / reflection 同源哲学（CR-07-4）：
 * 只注入相关条目、条目化存储、合并/剪枝留痕——这里把同一原则用到重置路径。
 */

import type { PodStore } from './store.js'
import type { ResetEntry, Task } from './types.js'

/** Generator：把已完成任务转成一条 fact 条目（Rich 内容，含 commit/测试结果/决策）。 */
export function taskToFactEntry(task: Task, slotId: string, ts: number, idFn?: () => string): ResetEntry {
  const bits: string[] = [`${task.id} ${task.title}`]
  if (task.commit_sha !== undefined && task.commit_sha.length > 0) bits.push(`commit ${task.commit_sha.slice(0, 8)}`)
  if (task.test_result !== undefined) bits.push(`测试 ${task.test_result}${task.test_evidence !== undefined && task.test_evidence.length > 0 ? `（${task.test_evidence.slice(0, 60)}）` : ''}`)
  if (task.decisions !== undefined && task.decisions.length > 0) bits.push(`决策：${task.decisions.slice(0, 3).join('；')}`)
  return {
    id: idFn !== undefined ? idFn() : `RE-${ts}-${Math.floor(Math.random() * 1e6)}`,
    mission_id: task.mission_id,
    slot_id: slotId,
    type: 'fact',
    content: bits.join('，'),
    task_id: task.id,
    commit_sha: task.commit_sha,
    status: 'active',
    ts,
  }
}

/**
 * Curator：入账新条目时对既有条目做确定性的去重 + supersede 操作。
 * 返回应当入账的新条目（调用方 store.addResetEntry）。
 *   - 同 task_id 已有 active 条目（任务被重做/重试成功）→ 旧条目标 superseded，新条目入账；
 *   - 同 task_id 同 commit 已有条目 → 已入账，跳过（幂等，防重复入账）。
 *
 * 幂等判定只认「双方都有 commit_sha 且相等」或「双方无 commit 且 content 全等」（2026-09-03）：
 * 无 commit 任务（review/research/doc，report 无产物）commit_sha 均为 undefined，
 * `undefined === undefined` 恒真会让重跑的新结论被幂等跳过、旧条目永不 superseded——
 * 重置摘要丢失最新结论。无 commit 条目改按 content 全等判幂等（同内容重放跳过，内容变化即 supersede）。
 */
export function curateIncoming(
  existing: ResetEntry[],
  incoming: ResetEntry,
  supersede: (id: string, ts?: number) => void,
  now: number,
): boolean {
  if (incoming.task_id === undefined) return true // 无源任务（如决策/坑）直接入账
  const same = existing.filter((e) => e.task_id === incoming.task_id)
  const activeSame = same.filter((e) => e.status === 'active')
  const identical = activeSame.some(
    (e) =>
      (e.commit_sha !== undefined && incoming.commit_sha !== undefined && e.commit_sha === incoming.commit_sha) ||
      (e.commit_sha === undefined && incoming.commit_sha === undefined && e.content === incoming.content),
  )
  if (identical) return false // 幂等：已入账（同 commit / 同 content 重放）
  for (const e of activeSame) supersede(e.id, now) // 任务被重做：旧条目标 superseded
  return true
}

/**
 * Reflector：从 delta 账本渲染重置摘要（只取 active 条目，不重扫任务、不重写历史）。
 * 内容比旧摘要 Rich：每任务带 commit/测试结果/决策，测试证据与决策不再丢失。
 */
export function renderResetSummaryFromLedger(
  entries: ResetEntry[],
  missionId: string,
  slotId: string,
): string {
  const active = entries.filter((e) => e.status === 'active')
  const lines: string[] = [
    `# 会话重置摘要（slot ${slotId}，mission ${missionId}）`,
    '',
    '> 由 delta 账本生成（任务完成时逐条入账，重置时只渲染 active；原始对话不入新会话）。',
    '',
    '## 已完成任务（fact 账本）',
  ]
  if (active.length === 0) {
    lines.push('（无）')
  } else {
    for (const e of active) lines.push(`- ${e.content}`)
  }
  lines.push('', '## 继续条件', '继续执行进行中任务；新任务以交接消息为准（指针与意图，磁盘传内容）。')
  return lines.join('\n')
}

/**
 * 便捷入口：把已完成任务入账进 delta 账本（Generator + Curator + 落盘一次）。
 * 幂等：同任务同 commit 重复调用不重复入账。
 */
export function appendTaskFact(
  store: PodStore,
  missionId: string,
  slotId: string,
  task: Task,
  ts: number,
): ResetEntry | undefined {
  const existing = store.listResetEntries(missionId, slotId)
  const incoming = taskToFactEntry(task, slotId, ts)
  const shouldAdd = curateIncoming(existing, incoming, (id, t) => store.supersedeResetEntry(missionId, id, t), ts)
  if (!shouldAdd) return undefined
  store.addResetEntry(incoming)
  return incoming
}

/**
 * 便捷入口：从账本渲染重置摘要（Reflector；空账本时回退到空摘要，不重扫）。
 */
export function resetSummaryFromStore(store: PodStore, missionId: string, slotId: string): string {
  const entries = store.listResetEntries(missionId, slotId)
  return renderResetSummaryFromLedger(entries, missionId, slotId)
}