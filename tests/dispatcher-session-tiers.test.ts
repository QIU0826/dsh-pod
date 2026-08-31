import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore } from '../src/core/store.js'
import { routeTask } from '../src/core/dispatcher.js'
import { buildRecentWindow, buildResetSummary, estimateCtxUsage, needsAutoReset, resetThresholdFor, sessionCtxUsage, tierDefaults } from '../src/core/session-tiers.js'
import type { AgentSlot, Task } from '../src/core/types.js'
import { CONTENT_DENSITY_REVIEW, CTX_RESET_REVIEW_THRESHOLD_PCT, CTX_RESET_THRESHOLD_PCT } from '../src/core/types.js'

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

  it('当前会话占用按基线做差（重置后归零，不再反弹回高位）', () => {
    // 累计 160K token / 窗口 200K → 累计占比 80%
    expect(sessionCtxUsage(makeSlot('S-1', { tokens_in: 100_000, tokens_out: 60_000, window_tokens: 200_000 }))).toBe(80)
    // 在累计 150K 处重置过会话 → 当前会话只消耗 10K → 5%。
    // 少了这个基线，重置后占用率会立刻弹回 80%，变成每次派发都触发重置。
    expect(
      sessionCtxUsage(
        makeSlot('S-1', { tokens_in: 100_000, tokens_out: 60_000, window_tokens: 200_000, session_base_tokens: 150_000 }),
      ),
    ).toBe(5)
  })

  it('复用会话的槽位达阈值即需重置（不依赖用户设置 auto-reset 档）', () => {
    // 原实现要求 session_tier === 'auto-reset'，但该档位在前端 / routes / pod-tools
    // 都没有设置入口 → 判定恒为假，刹车从未真正装过。改为凡复用会话即生效。
    expect(needsAutoReset(makeSlot('S-1', { session_tier: 'per-mission', ctx_usage_pct: 70 }))).toBe(true)
    expect(needsAutoReset(makeSlot('S-1', { session_tier: 'per-mission', ctx_usage_pct: 69.9 }))).toBe(false)
    expect(needsAutoReset(makeSlot('S-1', { session_tier: 'auto-reset', ctx_usage_pct: 70 }))).toBe(true)
    // transient 每次都是新进程，无累积可言，永不触发
    expect(needsAutoReset(makeSlot('S-1', { session_tier: 'transient', ctx_usage_pct: 95 }))).toBe(false)
  })

  it('阈值常量即方案书数值', () => {
    expect(CTX_RESET_THRESHOLD_PCT).toBe(70)
  })
})

describe('P1-2 第二维：内容相似密度降阈值（review diff 密集提前重置）', () => {
  it('resetThresholdFor：低密度 → 常规 70%；高密度（≥60）→ review 低阈值 50%', () => {
    expect(resetThresholdFor({ content_density_pct: 0 })).toBe(70)
    expect(resetThresholdFor({ content_density_pct: 40 })).toBe(70)
    expect(resetThresholdFor({ content_density_pct: 60 })).toBe(50)
    expect(resetThresholdFor({ content_density_pct: 90 })).toBe(50)
    expect(resetThresholdFor({})).toBe(70) // 无密度记录 → 常规
  })

  it('needsAutoReset：density 高时 50% 即触发，70% 常规场景不误触', () => {
    // review diff 密集：占用 55%（<70 但 ≥50）→ 触发低阈值重置
    expect(needsAutoReset(makeSlot('S-1', { session_tier: 'per-mission', ctx_usage_pct: 55, content_density_pct: 85 }))).toBe(true)
    // 同为 55% 但密度低（implement）→ 不触发（维持会话复用收益）
    expect(needsAutoReset(makeSlot('S-1', { session_tier: 'per-mission', ctx_usage_pct: 55, content_density_pct: 10 }))).toBe(false)
    // transient 永不触发（即使密度高）
    expect(needsAutoReset(makeSlot('S-1', { session_tier: 'transient', ctx_usage_pct: 55, content_density_pct: 85 }))).toBe(false)
  })

  it('常量：review 阈值 50、密度门限 60', () => {
    expect(CTX_RESET_REVIEW_THRESHOLD_PCT).toBe(50)
    expect(CONTENT_DENSITY_REVIEW).toBe(60)
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

describe('buildRecentWindow（P1-3 重置后 verbatim 近期窗口）', () => {
  let root: string
  let store: JsonStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-recent-'))
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

  it('取在途任务最近 N=3 条原始事件逐字（steer/工具结果/问答）', () => {
    store.appendEvent('M-1', { id: 'e1', mission_id: 'M-1', ts: now, kind: 'worker_progress', slot_id: 'S-1', task_id: 'T-9', payload: { kind: 'text', text: '我先看代码' } })
    store.appendEvent('M-1', { id: 'e2', mission_id: 'M-1', ts: now + 1, kind: 'steer_queued', slot_id: 'S-1', task_id: 'T-9', payload: { instruction: '加一层缓存' } })
    store.appendEvent('M-1', { id: 'e3', mission_id: 'M-1', ts: now + 2, kind: 'worker_progress', slot_id: 'S-1', task_id: 'T-9', payload: { kind: 'test_output', text: '3 failed: rate' } })
    store.appendEvent('M-1', { id: 'e4', mission_id: 'M-1', ts: now + 3, kind: 'worker_progress', slot_id: 'S-1', task_id: 'T-9', payload: { kind: 'text', text: '改阈值' } })
    const win = buildRecentWindow(store, 'M-1', 'S-1', 'T-9')
    expect(win).toContain('近期窗口')
    expect(win).toContain('加一层缓存')
    expect(win).toContain('3 failed')
    expect(win).toContain('改阈值')
    expect(win).not.toContain('我先看代码') // 只留最近 3 条
  })

  it('只含该任务该槽位事件（不跨任务）；他任务/他槽位不混入', () => {
    store.appendEvent('M-1', { id: 'e1', mission_id: 'M-1', ts: now, kind: 'worker_progress', slot_id: 'S-1', task_id: 'T-9', payload: { kind: 'text', text: '本任务' } })
    store.appendEvent('M-1', { id: 'e2', mission_id: 'M-1', ts: now + 1, kind: 'worker_progress', slot_id: 'S-1', task_id: 'T-10', payload: { kind: 'text', text: '他任务' } })
    store.appendEvent('M-1', { id: 'e3', mission_id: 'M-1', ts: now + 2, kind: 'worker_progress', slot_id: 'S-2', task_id: 'T-9', payload: { kind: 'text', text: '他槽位' } })
    const win = buildRecentWindow(store, 'M-1', 'S-1', 'T-9')
    expect(win).toContain('本任务')
    expect(win).not.toContain('他任务')
    expect(win).not.toContain('他槽位')
  })

  it('无相关事件 → 空串（任务结束即清空，不注入空窗口）', () => {
    store.appendEvent('M-1', { id: 'e1', mission_id: 'M-1', ts: now, kind: 'worker_progress', slot_id: 'S-1', task_id: 'T-9', payload: { kind: 'text', text: 'x' } })
    expect(buildRecentWindow(store, 'M-1', 'S-1', 'T-done')).toBe('')
    expect(buildRecentWindow(store, 'M-1', 'S-2', 'T-9')).toBe('') // 槽位不匹配
  })
})
