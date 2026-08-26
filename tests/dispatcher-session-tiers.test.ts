import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore } from '../src/core/store.js'
import { routeTask } from '../src/core/dispatcher.js'
import { buildResetSummary, estimateCtxUsage, needsAutoReset, tierDefaults } from '../src/core/session-tiers.js'
import type { AgentSlot, Task } from '../src/core/types.js'
import { CTX_RESET_THRESHOLD_PCT } from '../src/core/types.js'

const now = 1_700_000_000_000

function makeSlot(id: string, over: Partial<AgentSlot> = {}): AgentSlot {
  return {
    id,
    mission_id: 'M-1',
    vendor: 'claude',
    role: 'implementer',
    capabilities: ['编码'],
    model: 'claude-sonnet',
    effort: 'medium',
    session_tier: 'per-mission',
    status: 'idle',
    tokens_in: 0,
    tokens_out: 0,
    ctx_usage_pct: 0,
    window_tokens: 200_000,
    ...over,
  }
}

function makeTask(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    mission_id: 'M-1',
    title: id,
    spec: 's',
    skill_tags: [],
    type: 'implement',
    depends_on: [],
    status: 'ready',
    attempts: 0,
    soft_attempts: 0,
    max_wall_clock_ms: 3600_000,
    created_at: now,
    updated_at: now,
    ...over,
  }
}

describe('Dispatcher 路由（能力 > 负载 > 单任务成本）', () => {
  const slots = [
    makeSlot('S-a', { capabilities: ['编码', '测试'], model: 'cheap-model' }),
    makeSlot('S-b', { capabilities: ['编码'], model: 'expensive-model' }),
  ]
  const tasks = [makeTask('T-1', { owner_slot_id: 'S-a', status: 'running' })]

  it('能力硬条件：无匹配能力 → 不路由', () => {
    const result = routeTask(makeTask('T-x', { skill_tags: ['翻译'] }), { slots, tasks })
    expect(result.slotId).toBeNull()
  })

  it('能力匹配 → 优先负载低者（S-a 忙、S-b 闲 → S-b）', () => {
    const result = routeTask(makeTask('T-x', { skill_tags: ['编码'] }), { slots, tasks })
    expect(result.slotId).toBe('S-b')
  })

  it('负载相同 → 优先成本低者', () => {
    const cheap = makeSlot('S-cheap', { capabilities: ['编码'], model: 'cheap-model' })
    const expensive = makeSlot('S-expensive', { capabilities: ['编码'], model: 'expensive-model' })
    const result = routeTask(makeTask('T-x', { skill_tags: ['编码'] }), { slots: [expensive, cheap], tasks: [] })
    expect(result.slotId).toBe('S-cheap')
  })

  it('error/stopped/rate_limited 槽位不可路由（3.4 节故障态）', () => {
    const broken = makeSlot('S-broken', { capabilities: ['编码'], status: 'error' })
    const result = routeTask(makeTask('T-x', { skill_tags: ['编码'] }), { slots: [broken], tasks: [] })
    expect(result.slotId).toBeNull()
    expect(result.reason).toMatch(/unavailable/i)
  })

  it('历史成功率（Ledger→路由权重，v0.2）：同负载同成本 → 高成功率槽位优先', () => {
    const a = makeSlot('S-a', { capabilities: ['编码'], model: 'same-model' })
    const b = makeSlot('S-b', { capabilities: ['编码'], model: 'same-model' })
    const result = routeTask(makeTask('T-x', { skill_tags: ['编码'] }), {
      slots: [a, b],
      tasks: [],
      slotSuccess: { 'S-a': 0.2, 'S-b': 0.9 }, // 同负载同模型 → 成功率 0.9 优先
    })
    expect(result.slotId).toBe('S-b')
  })

  it('历史成功率：无数据视为中性 0.5，不劣化原路由（缺省时按稳定序）', () => {
    const a = makeSlot('S-a', { capabilities: ['编码'], model: 'same-model' })
    const b = makeSlot('S-b', { capabilities: ['编码'], model: 'same-model' })
    // 缺省 slotSuccess：成功率同（0.5）→ 回落稳定序（S-a 在前）
    const r1 = routeTask(makeTask('T-x', { skill_tags: ['编码'] }), { slots: [a, b], tasks: [] })
    expect(r1.slotId).toBe('S-a')
    // 显式 0.5 = 0.5：同值 → 稳定序
    const r2 = routeTask(makeTask('T-x', { skill_tags: ['编码'] }), {
      slots: [a, b],
      tasks: [],
      slotSuccess: { 'S-a': 0.5, 'S-b': 0.5 },
    })
    expect(r2.slotId).toBe('S-a')
  })

  it('成功率收敛到 [0,1]：越界值被 clamp（不参与排序越界）', () => {
    const a = makeSlot('S-a', { capabilities: ['编码'], model: 'm' })
    const b = makeSlot('S-b', { capabilities: ['编码'], model: 'm' })
    // -0.5 → 0，1.5 → 1：正常槽位仍优先
    const result = routeTask(makeTask('T-x', { skill_tags: ['编码'] }), {
      slots: [a, b],
      tasks: [],
      slotSuccess: { 'S-a': -0.5, 'S-b': 1.5 },
    })
    expect(result.slotId).toBe('S-b')
  })
})

describe('会话档位（3.2 节三档制 / O7）', () => {
  it('默认档：claude=per-mission，codex/dsh=transient', () => {
    expect(tierDefaults('claude')).toBe('per-mission')
    expect(tierDefaults('codex')).toBe('transient')
    expect(tierDefaults('dsh')).toBe('transient')
  })

  it('上下文占用估算：tokens/窗口，封顶 100%', () => {
    expect(estimateCtxUsage(100_000, 40_000, 200_000)).toBe(70)
    expect(estimateCtxUsage(300_000, 0, 200_000)).toBe(100)
    expect(estimateCtxUsage(0, 0, 200_000)).toBe(0)
  })

  it('auto-reset 档 + 70% 阈值 → 需要重置（档位 C）', () => {
    expect(needsAutoReset(makeSlot('S-1', { session_tier: 'auto-reset', ctx_usage_pct: 70 }))).toBe(true)
    expect(needsAutoReset(makeSlot('S-1', { session_tier: 'auto-reset', ctx_usage_pct: 69.9 }))).toBe(false)
    expect(needsAutoReset(makeSlot('S-1', { session_tier: 'per-mission', ctx_usage_pct: 95 }))).toBe(false)
  })

  it('阈值常量即方案书数值', () => {
    expect(CTX_RESET_THRESHOLD_PCT).toBe(70)
  })
})

describe('buildResetSummary（档位 C 重置后的磁盘摘要注入）', () => {
  let root: string
  let store: JsonStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-tier-'))
    store = new JsonStore({ rootDir: root })
    store.open()
    store.createMission({
      id: 'M-1', name: 'm', goal: 'g', status: 'running', budget_usd: 2,
      spent_tokens: 0, spent_equiv_usd: 0, approval_mode: 1, cwd: 'C:\\repo',
      worktree_policy: 'per-slot', orchestration_mode: 'commander',
      commander_healthy: true, created_at: now, updated_at: now,
    })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('汇总该员工已完成任务 + commit + 测试结果（结构化摘要，不含原始对话）', () => {
    store.createTask(makeTask('T-1', { owner_slot_id: 'S-1', status: 'done', commit_sha: 'abc', title: '做限流器' }))
    store.createTask(makeTask('T-2', { owner_slot_id: 'S-1', status: 'running', title: '做缓存' }))
    store.createTask(makeTask('T-3', { owner_slot_id: 'S-2', status: 'done', commit_sha: 'def', title: '别人的活' }))
    const summary = buildResetSummary(store, 'M-1', 'S-1')
    expect(summary).toContain('做限流器')
    expect(summary).toContain('abc')
    expect(summary).toContain('做缓存') // 进行中任务提示「进行中」，不含任务执行细节
    expect(summary).not.toContain('别人的活')
  })
})
