/**
 * 记忆冲突消解（P1-4 深化②，借 Mem0 方法论）。
 *
 * 背景：记忆图谱的 `contradicts` 关系此前只可手动 addEdge，reflection 从不自动创建——
 * 同一话题的多个版本会长期并存分裂知识。Mem0 的做法是：新事实入库时若与旧记忆冲突，
 * 旧记忆标记为 conflicted（保留历史、退出活跃检索），而非两个版本并存。
 *
 * 本模块把该方法论落成**确定性、无 LLM** 的 reflection pass：
 *   - 触发面：同 owner + **同 type**（互补事实跨 type——如 decision+fact——是 supports
 *     的职责，判冲突会误伤）+ 共享标签 ≥2 + 内容词法相似度落 [SIM_MIN, 1)——
 *     过低=不同话题（不动），过高=重复（由合并 pass 处理完全相同的 content_ref）。
 *   - 收口：较旧记录 importance 降为 1（退出活跃注入位，但保留记录、边与历史），
 *     建 `contradicts` 边（旧 → 新）；新者胜出。
 *   - 保守：已有 contradicts/supports 边的记录对视为已裁决，跳过；
 *     无 embedding，词法近似是代理信号——阈值宁紧勿松，绝不删除数据。
 *   - 顺序约束：本 pass 必须**先于** supports pass 运行——否则同话题对先被 supports
 *     边标记为「已裁决」，冲突收口永不触发。
 */

import { tokenize } from './memory-rank.js'

/** 内容相似度（Dice 系数：2×交集 / 长度和，基于 CJK bigram + ASCII 词）。 */
export function bigramDice(a: string, b: string): number {
  const ta = tokenize(a)
  const tb = tokenize(b)
  if (ta.length === 0 || tb.length === 0) return 0
  const setB = new Set(tb)
  let overlap = 0
  for (const t of ta) if (setB.has(t)) overlap++
  return (2 * overlap) / (ta.length + tb.length)
}

/** 冲突判定下界：低于此视为不同话题（与 supports pass 的共享标签一起收紧）。 */
export const CONFLICT_SIM_MIN = 0.4
/** 共享标签下界（与 runReflection 的 autoLinkMinSharedTags 默认一致）。 */
export const CONFLICT_MIN_SHARED_TAGS = 2
/** 冲突收口后旧记录的降级目标（退出活跃注入位；importance=1 时不再降）。 */
export const CONFLICT_DEMOTE_TO = 1 as const

export interface ConflictCandidate {
  oldId: string
  newId: string
  oldImportance: number
  similarity: number
}

export interface ConflictRecordLike {
  id: string
  owner_slot_id: string
  type: string
  importance: number
  tags: string[]
  content_ref: string
  updated_ts: number
}

export interface ConflictEdgeLike {
  from_record: string
  to_record: string
  relation: string
}

/**
 * 冲突候选对（纯函数，只读）：同 owner + 同 type + 共享标签 ≥minShared + 相似度 ∈
 * [SIM_MIN, 1) 且双方 id 不同。方向 = 旧 → 新（updated_ts 小者为 old）。
 * 保守：任一方向已存在 contradicts/supports 边 → 已裁决，排除。
 */
export function conflictCandidates(
  records: readonly ConflictRecordLike[],
  edges: readonly ConflictEdgeLike[],
  opts: { minSharedTags?: number; simMin?: number } = {},
): ConflictCandidate[] {
  const minShared = opts.minSharedTags ?? CONFLICT_MIN_SHARED_TAGS
  const simMin = opts.simMin ?? CONFLICT_SIM_MIN
  const edgeKey = new Set<string>()
  for (const e of edges) {
    if (e.relation === 'contradicts' || e.relation === 'supports') {
      edgeKey.add(`${e.from_record}|${e.to_record}`)
      edgeKey.add(`${e.to_record}|${e.from_record}`)
    }
  }
  const out: ConflictCandidate[] = []
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i]!
      const b = records[j]!
      if (a.id === b.id || a.owner_slot_id !== b.owner_slot_id) continue
      if (a.type !== b.type) continue // 跨 type = 互补事实（supports 的职责），非冲突
      const shared = a.tags.filter((t) => b.tags.includes(t)).length
      if (shared < minShared) continue
      const sim = bigramDice(a.content_ref, b.content_ref)
      if (sim < simMin || sim >= 1) continue // 1 是完全相同文本，归合并 pass
      const [old, newer] = a.updated_ts <= b.updated_ts ? [a, b] : [b, a]
      const key = `${old.id}|${newer.id}`
      if (edgeKey.has(key)) continue
      out.push({ oldId: old.id, newId: newer.id, oldImportance: old.importance, similarity: sim })
    }
  }
  return out
}

/**
 * 冲突收口（纯函数）：对每条候选建 contradicts 边（旧→新），较旧记录 importance 降到
 * CONFLICT_DEMOTE_TO（importance=1 记录不降）。返回待落地的边与新旧记录 importance patch。
 */
export function resolveConflicts(
  records: readonly ConflictRecordLike[],
  edges: readonly ConflictEdgeLike[],
  opts: { minSharedTags?: number; simMin?: number } = {},
): {
  candidates: ConflictCandidate[]
  edgesToAdd: Array<{ from_record: string; to_record: string; relation: 'contradicts' }>
  demotions: Array<{ id: string; importance: 1 }>
} {
  const candidates = conflictCandidates(records, edges, opts)
  const edgesToAdd = candidates.map((c) => ({ from_record: c.oldId, to_record: c.newId, relation: 'contradicts' as const }))
  const demotions = candidates
    .filter((c) => c.oldImportance > CONFLICT_DEMOTE_TO)
    .map((c) => ({ id: c.oldId, importance: CONFLICT_DEMOTE_TO }))
  return { candidates, edgesToAdd, demotions }
}
