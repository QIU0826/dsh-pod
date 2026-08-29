import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BudgetExceededError, PodError } from '../src/core/errors.js'
import { JsonStore } from '../src/core/store.js'
import { DEFAULT_PRICE_TABLE, Ledger } from '../src/core/ledger.js'
import type { PriceTable } from '../src/core/ledger.js'
import type { Mission, Task, TaskType, UsageSource } from '../src/core/types.js'

let root: string
let store: JsonStore
let ledger: Ledger
let now: number

const table: PriceTable = {
  version: 'test-table-1',
  rates: {
    'claude-sonnet': { in: 3, out: 15 },
    'deepseek-chat': { in: 0.27, out: 1.1 },
  },
}

function makeMission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'M-1',
    name: 'm',
    goal: 'g',
    status: 'running',
    budget_usd: 2,
    budget_tokens: 100_000,
    spent_tokens: 0,
    spent_equiv_usd: 0,
    approval_mode: 1,
    cwd: 'C:\\repo',
    worktree_policy: 'per-slot',
    orchestration_mode: 'commander',
    commander_healthy: true,
    created_at: now,
    updated_at: now,
    ...over,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pod-ledger-'))
  now = 1_700_000_000_000
  store = new JsonStore({ rootDir: root, clock: () => now })
  store.open()
  store.createMission(makeMission())
  ledger = new Ledger(store, { clock: () => now, priceTable: table })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('Ledger 双列计费（D7：tokens 实测 + equiv_usd 标注估算）', () => {
  it('recordUsage 累加 mission 花费并持久化', () => {
    const entry = ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 40_000, 10_000, 'measured')
    // equiv_usd = (40000*3 + 10000*15)/1e6 = 0.12 + 0.15 = 0.27
    expect(entry.equiv_usd).toBeCloseTo(0.27, 6)
    expect(entry.price_table_version).toBe('test-table-1')
    expect(entry.price_known).toBe(true)
    const mission = store.getMission('M-1')!
    expect(mission.spent_tokens).toBe(50_000)
    expect(mission.spent_equiv_usd).toBeCloseTo(0.27, 6)
    expect(store.listLedger('M-1')).toHaveLength(1)
  })

  it('usage_source 如实标注（CR-01-5：无数据后端显式 unavailable，禁止编造）', () => {
    ledger.recordUsage('M-1', 'S-1', 'T-1', 'codex-default', 1000, 500, 'unavailable')
    const entry = store.listLedger('M-1')[0]!
    expect(entry.usage_source).toBe('unavailable')
  })

  it('未知模型：tokens 照记（权威列），equiv 记 0 + price_known=false（诚实化）', () => {
    const entry = ledger.recordUsage('M-1', 'S-1', 'T-1', 'future-model', 1000, 500, 'measured')
    expect(entry.equiv_usd).toBe(0)
    expect(entry.price_known).toBe(false)
    expect(store.getMission('M-1')!.spent_tokens).toBe(1500)
  })

  it('负数 token → PodError（INVALID_USAGE）', () => {
    expect(() => ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', -1, 0, 'measured')).toThrowError(PodError)
  })

  it('不存在的 mission → NotFoundError', () => {
    expect(() => ledger.recordUsage('nope', 'S-1', 'T-1', 'claude-sonnet', 1, 1, 'measured')).toThrowError(/not found/i)
  })
})

describe('预算熔断（2.7 节：超预算自动 pause 的信号源）', () => {
  it('token 预算超限 → BudgetExceededError', () => {
    ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 90_000, 0, 'measured')
    expect(() => ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 20_000, 0, 'measured')).toThrowError(BudgetExceededError)
  })

  it('美元预算超限 → BudgetExceededError（关闭 token 预算，纯美元场景）', () => {
    store.updateMission('M-1', { budget_tokens: undefined })
    // 0.27 per call；预算 $2 → 7 次 ok，第 8 次超
    for (let i = 0; i < 7; i++) {
      ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 40_000, 10_000, 'measured')
    }
    expect(() => ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 40_000, 10_000, 'measured')).toThrowError(BudgetExceededError)
  })

  it('budgetStatus 反映实时状态；未设 token 预算时只看美元', () => {
    store.updateMission('M-1', { budget_tokens: undefined })
    ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 40_000, 10_000, 'measured')
    const status = ledger.budgetStatus('M-1')
    expect(status.over).toBe(false)
    expect(status.tokens.limit).toBeUndefined()
  })
})

describe('汇总（Debrief 页数据源）', () => {
  it('summary 按员工/模型拆解', () => {
    ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 1000, 100, 'measured')
    ledger.recordUsage('M-1', 'S-2', 'T-2', 'deepseek-chat', 5000, 500, 'measured')
    const summary = ledger.summary('M-1')
    expect(summary.total_tokens).toBe(6600)
    expect(summary.bySlot['S-1']!.tokens).toBe(1100)
    expect(summary.byModel['deepseek-chat']!.tokens).toBe(5500)
    expect(summary.entries).toHaveLength(2)
  })

  it('默认价目表自带版本号（DoD-7：估算必须标注价目表版本）', () => {
    expect(DEFAULT_PRICE_TABLE.version).toMatch(/pod-default-\d{4}-\d{2}-\d{2}/)
    expect(DEFAULT_PRICE_TABLE.rates['claude-sonnet']).toBeDefined()
  })
})

describe('usage source 类型安全', () => {
  it('accepts only measured | unavailable', () => {
    const good: UsageSource = 'measured'
    expect(good).toBe('measured')
  })
})

describe('estimateTaskCostUsd（AgentScope-F / DC-4：派发前预算短路预估）', () => {
  it('implement 任务按类型 token 量 × 模型价目估算（claude-sonnet）', () => {
    // implement: 120k total（96k in + 24k out）× sonnet(3/15) = (96k*3 + 24k*15)/1e6 = 0.648
    const estimate = ledger.estimateTaskCostUsd('M-1', 'implement', 'claude-sonnet')
    expect(estimate).toBeCloseTo(0.648, 4)
  })

  it('review 任务明显低于 implement（审查只读，token 量小）', () => {
    const implement = ledger.estimateTaskCostUsd('M-1', 'implement', 'claude-sonnet')
    const review = ledger.estimateTaskCostUsd('M-1', 'review', 'claude-sonnet')
    expect(review).toBeLessThan(implement)
  })

  it('未知模型价目 → 固定保守下限 $0.05（宁可告警不放行）', () => {
    const estimate = ledger.estimateTaskCostUsd('M-1', 'implement', 'no-such-model')
    expect(estimate).toBe(0.05)
  })
})

describe('summary.byStage（阶段归因：review 到底烧了多少）', () => {
  function makeTask(id: string, type: TaskType): Task {
    return {
      id,
      mission_id: 'M-1',
      title: id,
      spec: 'spec',
      skill_tags: [],
      type,
      depends_on: [],
      status: 'done',
      attempts: 0,
      soft_attempts: 0,
      max_wall_clock_ms: 60 * 60 * 1000,
      created_at: now,
      updated_at: now,
    }
  }

  it('按任务类型归因：implement / review / plan 分别归桶', () => {
    store.createTask(makeTask('T-1', 'implement'))
    store.createTask(makeTask('T-2', 'review'))
    store.createTask(makeTask('T-3', 'plan'))
    ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 30_000, 10_000, 'measured')
    ledger.recordUsage('M-1', 'S-2', 'T-2', 'claude-sonnet', 20_000, 5_000, 'measured')
    ledger.recordUsage('M-1', 'S-1', 'T-3', 'claude-sonnet', 2_000, 1_000, 'measured')

    const s = ledger.summary('M-1')
    expect(s.byStage.implement?.tokens).toBe(40_000)
    expect(s.byStage.review?.tokens).toBe(25_000)
    expect(s.byStage.plan?.tokens).toBe(3_000)
    expect(s.byStage.implement?.entries).toBe(1)
  })

  it('同一任务多次采样累计到同一阶段桶（流式/重试不重复建桶）', () => {
    store.createTask(makeTask('T-1', 'review'))
    ledger.recordUsage('M-1', 'S-2', 'T-1', 'claude-sonnet', 1_000, 500, 'measured')
    ledger.recordUsage('M-1', 'S-2', 'T-1', 'claude-sonnet', 1_000, 500, 'measured')
    const s = ledger.summary('M-1')
    expect(s.byStage.review?.entries).toBe(2)
    expect(s.byStage.review?.tokens).toBe(3_000)
  })

  it('查不到任务 → 归入 unknown，不静默丢账', () => {
    ledger.recordUsage('M-1', 'S-1', 'T-ghost', 'claude-sonnet', 1_000, 500, 'measured')
    const s = ledger.summary('M-1')
    expect(s.byStage.unknown?.tokens).toBe(1_500)
  })

  it('总额守恒：各阶段桶之和 = total_tokens（归因不漏账）', () => {
    store.createTask(makeTask('T-1', 'implement'))
    store.createTask(makeTask('T-2', 'review'))
    ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 30_000, 10_000, 'measured')
    ledger.recordUsage('M-1', 'S-2', 'T-2', 'claude-sonnet', 20_000, 5_000, 'measured')
    ledger.recordUsage('M-1', 'S-1', 'T-ghost', 'claude-sonnet', 1_000, 500, 'measured')

    const s = ledger.summary('M-1')
    const summed = Object.values(s.byStage).reduce((acc, b) => acc + b.tokens, 0)
    expect(summed).toBe(s.total_tokens)
  })
})
