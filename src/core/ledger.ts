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
    /** prompt cache 命中读 token（P0-2，claude result.usage.cache_read_input_tokens）。 */
    cacheReadTokens?: number,
    /** prompt cache 写入 token（P0-2，claude result.usage.cache_creation_input_tokens）。 */
    cacheCreationTokens?: number,
    /** 本次 usage 属于第几次被派发（0=首派，≥1=重派）。调用方传 task.soft_attempts（任务
     *  累计失败总数——每次失败都 +1，恰好 = 本次之前的派发次数，见 2026-09-03 归因修正：
     *  软失败 429/need_clarify 的重派也算重试成本，只传硬失败 attempts 会把它记成首派）。 */
    attempts?: number,
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
      ...(cacheReadTokens !== undefined ? { cache_read_tokens: cacheReadTokens } : {}),
      ...(cacheCreationTokens !== undefined ? { cache_creation_tokens: cacheCreationTokens } : {}),
      ...(attempts !== undefined ? { attempts } : {}),
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

  /**
   * Debrief 数据源：按员工 / 模型 / **阶段**拆解。
   *
   * byStage 的动机（2026-08-29 调研）：多 agent 写码场景里成本高度集中——
   * ChatDev 实测「迭代式代码 review」单项就吃掉 59.4% 的 token，而 agentic coding
   * 的总体消耗可达单轮推理的 1000 倍且**输入主导（>150:1）**。
   * 也就是说：只统计总数和按员工/模型拆分，看不出钱烧在哪个**阶段**。
   * 按任务类型（plan/implement/review/test/doc/research）归因后，
   * 「独立 review 质量门到底多贵」才有数据支撑，而不是靠感觉。
   */
  summary(missionId: string): {
    total_tokens: number
    total_equiv_usd: number
    /** prompt cache 命中读 token 汇总（P0-2）。 */
    total_cache_read_tokens: number
    /** prompt cache 写入 token 汇总（P0-2）。 */
    total_cache_creation_tokens: number
    entries: LedgerEntry[]
    bySlot: Record<string, { tokens: number; equiv_usd: number; entries: number }>
    byModel: Record<string, { tokens: number; equiv_usd: number; entries: number }>
    /** 按任务类型（= 执行阶段）拆解；查不到任务归入 `unknown`，不静默丢账。 */
    byStage: Record<string, { tokens: number; equiv_usd: number; entries: number }>
    /**
     * 按派发次数拆解（失败路径单独计数，与 byStage 正交）：key 为 attempts 数值的字符串
     * （'0'=首派，'1'/'2'=重派）。查不到 attempts 的老条目归入 `unknown`。重试成本
     * = 除 '0' 与 'unknown' 之外所有桶之和，即「失败的派发烧掉的钱」（2026-09-03 起含
     * 软失败重派——429/need_clarify 的重派由 orchestrator 传 task.soft_attempts 归入重试
     * 桶；此前只传硬失败 attempts，软失败重派被记成首派、重试成本低估）。
     */
    byAttempt: Record<string, { tokens: number; equiv_usd: number; entries: number }>
  } {
    const entries = this.store.listLedger(missionId)
    const bySlot: Record<string, { tokens: number; equiv_usd: number; entries: number }> = {}
    const byModel: Record<string, { tokens: number; equiv_usd: number; entries: number }> = {}
    const byStage: Record<string, { tokens: number; equiv_usd: number; entries: number }> = {}
    const byAttempt: Record<string, { tokens: number; equiv_usd: number; entries: number }> = {}
    // 同一任务会被多次采样（流式/重试），缓存避免重复查 store
    const stageOf = new Map<string, string>()
    let totalTokens = 0
    let totalUsd = 0
    let totalCacheRead = 0
    let totalCacheCreation = 0
    for (const entry of entries) {
      const tokens = entry.tokens_in + entry.tokens_out
      totalTokens += tokens
      totalUsd += entry.equiv_usd
      totalCacheRead += entry.cache_read_tokens ?? 0
      totalCacheCreation += entry.cache_creation_tokens ?? 0

      let stage = 'unknown'
      const taskId = entry.task_id
      if (taskId !== null && taskId !== undefined && taskId.length > 0) {
        const cached = stageOf.get(taskId)
        if (cached !== undefined) {
          stage = cached
        } else {
          const task = this.store.getTask(missionId, taskId)
          stage = task?.type ?? 'unknown'
          stageOf.set(taskId, stage)
        }
      }
      const stageBucket = byStage[stage] ?? { tokens: 0, equiv_usd: 0, entries: 0 }
      byStage[stage] = {
        tokens: stageBucket.tokens + tokens,
        equiv_usd: stageBucket.equiv_usd + entry.equiv_usd,
        entries: stageBucket.entries + 1,
      }

      const attemptKey = entry.attempts !== undefined ? String(entry.attempts) : 'unknown'
      const attemptBucket = byAttempt[attemptKey] ?? { tokens: 0, equiv_usd: 0, entries: 0 }
      byAttempt[attemptKey] = {
        tokens: attemptBucket.tokens + tokens,
        equiv_usd: attemptBucket.equiv_usd + entry.equiv_usd,
        entries: attemptBucket.entries + 1,
      }

      for (const [key, bucket] of [[entry.slot_id, bySlot], [entry.model, byModel]] as const) {
        const current = bucket[key] ?? { tokens: 0, equiv_usd: 0, entries: 0 }
        bucket[key] = {
          tokens: current.tokens + tokens,
          equiv_usd: current.equiv_usd + entry.equiv_usd,
          entries: current.entries + 1,
        }
      }
    }
    return {
      total_tokens: totalTokens,
      total_equiv_usd: totalUsd,
      total_cache_read_tokens: totalCacheRead,
      total_cache_creation_tokens: totalCacheCreation,
      entries,
      bySlot,
      byModel,
      byStage,
      byAttempt,
    }
  }
}
