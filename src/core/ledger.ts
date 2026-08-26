/**
 * 成本账本 —— 方案书 2.7 节（v2 诚实化）。
 *
 * 双列计费：tokens（实测，权威列）+ equiv_usd（等效估算：价目表版本号 +
 * 公共 API 价 × tokens）。订阅制用户的 $ 不是实际支付，UI 一律标注「等效成本」。
 * 价目表无该模型 → equiv_usd=0 且 price_known=false，禁止编造（CR-01-5 同源）。
 *
 * 预算熔断：token 预算与美元预算双熔断（claude --max-budget-usd 之外的第二道），
 * 超限抛 BudgetExceededError —— 插件层捕获后自动 pause mission + 告警卡。
 * 二次价值：token 异常消耗 = 任务切分不当/agent 打转信号，进 Debrief。
 */

import { BudgetExceededError, NotFoundError, PodError } from './errors.js'
import type { PodStore } from './store.js'
import type { LedgerEntry, Mission, UsageSource } from './types.js'

export interface PriceTable {
  version: string
  /** 每百万 token 美元价（in / out），公共 API 价的显式估算快照。 */
  rates: Record<string, { in: number; out: number }>
}

/** 默认价目表：版本号即快照日期；发布前需按当日公共价刷新。 */
export const DEFAULT_PRICE_TABLE: PriceTable = {
  version: 'pod-default-2026-08-20',
  rates: {
    'claude-sonnet': { in: 3, out: 15 },
    'claude-opus': { in: 15, out: 75 },
    'deepseek-chat': { in: 0.27, out: 1.1 },
    // 估算值（本机实测路由无公开价目，供等效成本展示；发布前需按当日公开价刷新版本号）
    'deepseek-v4-pro': { in: 0.4, out: 1.6 },
    'codex-default': { in: 2.5, out: 10 },
    'unknown': { in: 0, out: 0 },
  },
}

export interface LedgerOptions {
  clock?: () => number
  priceTable?: PriceTable
}

export interface BudgetStatus {
  over: boolean
  tokens: { spent: number; limit?: number }
  usd: { spent: number; limit: number }
}

export class Ledger {
  private readonly store: PodStore
  private readonly clock: () => number
  private readonly priceTable: PriceTable

  constructor(store: PodStore, options: LedgerOptions = {}) {
    this.store = store
    this.clock = options.clock ?? (() => Date.now())
    this.priceTable = options.priceTable ?? DEFAULT_PRICE_TABLE
  }

  private requireMission(missionId: string): Mission {
    const mission = this.store.getMission(missionId)
    if (mission === undefined) throw new NotFoundError('mission', missionId)
    return mission
  }

  /** 记录一笔 usage：tokens 权威列照记；equiv 按价目表估算并标注版本。 */
  recordUsage(
    missionId: string,
    slotId: string,
    taskId: string | undefined,
    model: string,
    tokensIn: number,
    tokensOut: number,
    source: UsageSource,
  ): LedgerEntry {
    if (!Number.isFinite(tokensIn) || !Number.isFinite(tokensOut) || tokensIn < 0 || tokensOut < 0) {
      throw new PodError('token usage must be finite non-negative numbers', 'INVALID_USAGE', { tokensIn, tokensOut })
    }
    const mission = this.requireMission(missionId)
    const rate = this.priceTable.rates[model]
    const priceKnown = rate !== undefined
    const equivUsd = priceKnown ? (tokensIn * rate.in + tokensOut * rate.out) / 1_000_000 : 0

    const entry: LedgerEntry = {
      mission_id: missionId,
      slot_id: slotId,
      task_id: taskId,
      model,
      ts: this.clock(),
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      equiv_usd: equivUsd,
      price_table_version: this.priceTable.version,
      price_known: priceKnown,
      usage_source: source,
    }
    this.store.addLedgerEntry(entry)

    const spentTokens = mission.spent_tokens + tokensIn + tokensOut
    const spentUsd = mission.spent_equiv_usd + equivUsd
    this.store.updateMission(missionId, { spent_tokens: spentTokens, spent_equiv_usd: spentUsd })

    const status = this.budgetStatus(missionId)
    if (status.over) {
      throw new BudgetExceededError(
        missionId,
        status.tokens.spent,
        status.tokens.limit,
        status.usd.spent,
        status.usd.limit,
      )
    }
    return entry
  }

  budgetStatus(missionId: string): BudgetStatus {
    const mission = this.requireMission(missionId)
    const overTokens = mission.budget_tokens !== undefined && mission.spent_tokens > mission.budget_tokens
    const overUsd = mission.spent_equiv_usd > mission.budget_usd
    return {
      over: overTokens || overUsd,
      tokens: { spent: mission.spent_tokens, limit: mission.budget_tokens },
      usd: { spent: mission.spent_equiv_usd, limit: mission.budget_usd },
    }
  }

  /**
   * 派发前预算短路（AgentScope-F / 迁移计划 DC-4）：预估单任务成本（USD）。
   * 估算 = 任务类型预期 token 量 × 模型价目；仅作「剩余预算够不够跑一个任务」的
   * 预防性闸门，不作为计费。未知模型/类型退回保守上限（估算可被高估触发告警，绝不低估）。
   */
  estimateTaskCostUsd(missionId: string, taskType: string, model: string): number {
    this.requireMission(missionId)
    const totalTokensByType: Record<string, number> = {
      implement: 120_000,
      review: 30_000,
      plan: 20_000,
      test: 50_000,
      doc: 25_000,
      research: 40_000,
    }
    const total = totalTokensByType[taskType] ?? 60_000
    const rate = this.priceTable.rates[model] ?? this.priceTable.rates.unknown ?? { in: 0, out: 0 }
    const tokensIn = Math.floor(total * 0.8)
    const tokensOut = total - tokensIn
    const estimate = (tokensIn * rate.in + tokensOut * rate.out) / 1_000_000
    // 未知模型价目（0/0）→ 固定保守下限 $0.05（宁可告警不放行，防预算静默超支）
    if (!Number.isFinite(estimate) || estimate <= 0) return 0.05
    return estimate
  }

  /** Debrief 数据源：按员工/模型拆解。 */
  summary(missionId: string): {
    total_tokens: number
    total_equiv_usd: number
    entries: LedgerEntry[]
    bySlot: Record<string, { tokens: number; equiv_usd: number; entries: number }>
    byModel: Record<string, { tokens: number; equiv_usd: number; entries: number }>
  } {
    const entries = this.store.listLedger(missionId)
    const bySlot: Record<string, { tokens: number; equiv_usd: number; entries: number }> = {}
    const byModel: Record<string, { tokens: number; equiv_usd: number; entries: number }> = {}
    let totalTokens = 0
    let totalUsd = 0
    for (const entry of entries) {
      const tokens = entry.tokens_in + entry.tokens_out
      totalTokens += tokens
      totalUsd += entry.equiv_usd
      for (const [key, bucket] of [[entry.slot_id, bySlot], [entry.model, byModel]] as const) {
        const current = bucket[key] ?? { tokens: 0, equiv_usd: 0, entries: 0 }
        bucket[key] = {
          tokens: current.tokens + tokens,
          equiv_usd: current.equiv_usd + entry.equiv_usd,
          entries: current.entries + 1,
        }
      }
    }
    return { total_tokens: totalTokens, total_equiv_usd: totalUsd, entries, bySlot, byModel }
  }
}
