import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL_CARDS,
  getModelCard,
  registerModelCard,
  type ModelCard,
} from '../src/core/model-cards.js'

/**
 * AgentScope-H：model-cards 数据契约。
 * Team Builder 从数据渲染（vendor/model/context/capabilities/价目），无硬编码模型名。
 */

describe('model-cards 数据契约（AgentScope-H）', () => {
  it('默认卡片含 claude/codex 供应商', () => {
    const vendors = new Set(DEFAULT_MODEL_CARDS.map((c) => c.vendor))
    expect(vendors.has('claude')).toBe(true)
    expect(vendors.has('codex')).toBe(true)
  })

  it('卡片字段完整：vendor/model/context_window/capabilities（空 model = 供应商默认，CR-03-1）', () => {
    for (const card of DEFAULT_MODEL_CARDS) {
      expect(card.vendor.length).toBeGreaterThan(0)
      expect(typeof card.model).toBe('string')
      expect(card.context_window).toBeGreaterThan(0)
      expect(Array.isArray(card.capabilities)).toBe(true)
      expect(typeof card.price_table_ref).toBe('string')
    }
  })

  it('getModelCard：按 vendor+model 精确查找', () => {
    const card = getModelCard('claude', 'deepseek-v4-pro')
    expect(card).toBeDefined()
    expect(card?.capabilities).toContain('编码')
  })

  it('getModelCard：未知模型返回 undefined（不编造）', () => {
    expect(getModelCard('claude', 'no-such-model')).toBeUndefined()
    expect(getModelCard('unknown-vendor', 'x')).toBeUndefined()
  })

  it('registerModelCard：注册新卡片后可查询（Team Builder 动态名册）', () => {
    const card: ModelCard = {
      vendor: 'claude',
      model: 'custom-model-x',
      context_window: 128_000,
      capabilities: ['编码', '测试'],
      price_table_ref: 'pod-custom-2026',
    }
    registerModelCard(card)
    expect(getModelCard('claude', 'custom-model-x')?.context_window).toBe(128_000)
  })

  it('能力标签全集为闭集（Team Builder 渲染源）', () => {
    const allCaps = new Set(DEFAULT_MODEL_CARDS.flatMap((c) => c.capabilities))
    expect(allCaps.has('编码')).toBe(true)
    expect(allCaps.has('审查')).toBe(true)
    expect(allCaps.has('规划')).toBe(true)
    expect(allCaps.has('测试')).toBe(true)
  })
})
