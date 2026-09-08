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

describe('厂商缺省计价回落（T5：空 model 槽位不再 equiv_usd 恒 0）', () => {
  function makeSlot(id: string, vendor: string): void {
    store.createSlot({
      id,
      mission_id: 'M-1',
      vendor,
      role: 'implementer',
      capabilities: ['编码'],
      model: '',
      effort: 'medium',
      session_tier: 'transient',
      status: 'idle',
      tokens_in: 0,
      tokens_out: 0,
      ctx_usage_pct: 0,
      window_tokens: 200_000,
    })
  }

  it('codex 槽位 model 留空 → 回落 codex-default（1000/500 → 0.0075）', () => {
    const l = new Ledger(store, { clock: () => now, priceTable: DEFAULT_PRICE_TABLE })
    makeSlot('C-1', 'codex')
    const entry = l.recordUsage('M-1', 'C-1', 'T-1', '', 1000, 500, 'measured')
    expect(entry.price_known).toBe(true)
    expect(entry.model).toBe('codex-default')
    // (1000*2.5 + 500*10)/1e6 = 0.0025 + 0.005 = 0.0075
    expect(entry.equiv_usd).toBeCloseTo(0.0075, 6)
  })

  it('claude 槽位 model 留空 → 回落 deepseek-v4-pro', () => {
    const l = new Ledger(store, { clock: () => now, priceTable: DEFAULT_PRICE_TABLE })
    makeSlot('CL-1', 'claude')
    const entry = l.recordUsage('M-1', 'CL-1', 'T-1', '', 1000, 500, 'measured')
    expect(entry.price_known).toBe(true)
    expect(entry.model).toBe('deepseek-v4-pro')
    // (1000*0.4 + 500*1.6)/1e6 = 0.0004 + 0.0008 = 0.0012
    expect(entry.equiv_usd).toBeCloseTo(0.0012, 6)
  })

  it('无 vendorDefaults 的厂商（dsh）model 留空 → 诚实的 unknown（equiv 0 + price_known=false）', () => {
    const l = new Ledger(store, { clock: () => now, priceTable: DEFAULT_PRICE_TABLE })
    makeSlot('D-1', 'dsh')
    const entry = l.recordUsage('M-1', 'D-1', 'T-1', '', 1000, 500, 'measured')
    expect(entry.price_known).toBe(false)
    expect(entry.equiv_usd).toBe(0)
    expect(entry.model).toBe('')
    // tokens 权威列照记，不丢账
    expect(store.getMission('M-1')!.spent_tokens).toBe(1500)
  })

  it('显式命中的已知模型优先于厂商缺省回落（codex 槽位标 claude-sonnet → 按 sonnet 计价）', () => {
    const l = new Ledger(store, { clock: () => now, priceTable: DEFAULT_PRICE_TABLE })
    makeSlot('C-2', 'codex')
    const entry = l.recordUsage('M-1', 'C-2', 'T-1', 'claude-sonnet', 40_000, 10_000, 'measured')
    expect(entry.model).toBe('claude-sonnet')
    expect(entry.equiv_usd).toBeCloseTo(0.27, 6)
    expect(store.getMission('M-1')!.spent_equiv_usd).toBeCloseTo(0.27, 6)
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

  it('recordUsage 记录 prompt cache 命中/写入 token（P0-2）', () => {
    const entry = ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 1000, 100, 'measured', 40_000, 5_000)
    expect(entry.cache_read_tokens).toBe(40_000)
    expect(entry.cache_creation_tokens).toBe(5_000)
    const summary = ledger.summary('M-1')
    expect(summary.total_cache_read_tokens).toBe(40_000)
    expect(summary.total_cache_creation_tokens).toBe(5_000)
    // 无缓存列的历史条目不受影响（undefined 不参与求和）
    ledger.recordUsage('M-1', 'S-1', 'T-2', 'claude-sonnet', 10, 10, 'measured')
    expect(ledger.summary('M-1').total_cache_read_tokens).toBe(40_000)
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

describe('summary.byAttempt（失败路径单独计数：重试到底烧了多少，与 byStage 正交）', () => {
  it('首派与重试分桶：attempts=0 进 0 桶，重试进 1/2 桶', () => {
    ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 10_000, 5_000, 'measured', undefined, undefined, 0)
    ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 10_000, 5_000, 'measured', undefined, undefined, 1)
    ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 10_000, 5_000, 'measured', undefined, undefined, 2)

    const s = ledger.summary('M-1')
    expect(s.byAttempt['0']?.tokens).toBe(15_000)
    expect(s.byAttempt['1']?.tokens).toBe(15_000)
    expect(s.byAttempt['2']?.tokens).toBe(15_000)
    expect(s.byAttempt['0']?.entries).toBe(1)
  })

  it('重试成本 = 除 0 与 unknown 之外所有桶之和', () => {
    ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 10_000, 5_000, 'measured', undefined, undefined, 0)
    ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 10_000, 5_000, 'measured', undefined, undefined, 1)
    ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 10_000, 5_000, 'measured', undefined, undefined, 2)

    const s = ledger.summary('M-1')
    const retryTokens = Object.entries(s.byAttempt)
      .filter(([k]) => k !== '0' && k !== 'unknown')
      .reduce((acc, [, b]) => acc + b.tokens, 0)
    expect(retryTokens).toBe(30_000) // 两次重试各 15K
  })

  it('老条目（无 attempts 字段）→ 归入 unknown，不静默丢账', () => {
    ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 10_000, 5_000, 'measured')

    const s = ledger.summary('M-1')
    expect(s.byAttempt.unknown?.tokens).toBe(15_000)
    expect(s.byAttempt['0']).toBeUndefined()
  })

  it('总额守恒：attempts 各桶之和 = total_tokens', () => {
    ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 10_000, 5_000, 'measured', undefined, undefined, 0)
    ledger.recordUsage('M-1', 'S-1', 'T-1', 'claude-sonnet', 10_000, 5_000, 'measured', undefined, undefined, 1)
    ledger.recordUsage('M-1', 'S-1', 'T-ghost', 'claude-sonnet', 1_000, 500, 'measured')

    const s = ledger.summary('M-1')
    const summed = Object.values(s.byAttempt).reduce((acc, b) => acc + b.tokens, 0)
    expect(summed).toBe(s.total_tokens)
  })
})
