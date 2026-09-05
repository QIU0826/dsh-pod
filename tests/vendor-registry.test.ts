/**
 * 开放式厂商注册表（2026-09-06 harness 可扩展切片）回归测试：
 *   - 内置五家常驻、校验、展示名
 *   - registerVendor：外部平台注册 → isKnownVendor/listVendors/label/tier
 *   - 安全：内置不可覆盖、非法 id 拒绝
 *   - 注销与重置
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  isKnownVendor,
  listVendors,
  registerVendor,
  resetVendorRegistry,
  unregisterVendor,
  vendorLabel,
  vendorSessionTier,
} from '../src/core/vendor-registry.js'

beforeEach(() => {
  resetVendorRegistry()
})

describe('内置厂商', () => {
  it('五家常驻且校验为真', () => {
    for (const v of ['claude', 'codex', 'dsh', 'ark', 'opencode']) {
      expect(isKnownVendor(v)).toBe(true)
    }
    expect(isKnownVendor('workbuddy')).toBe(false)
  })
  it('展示名：claude → Claude；未知回原始 id', () => {
    expect(vendorLabel('claude')).toBe('Claude')
    expect(vendorLabel('nope')).toBe('nope')
  })
  it('内置厂商档位：claude per-mission，其余 transient', () => {
    expect(vendorSessionTier('claude')).toBe('per-mission')
    expect(vendorSessionTier('codex')).toBe('transient')
  })
})

describe('registerVendor（接入 workbuddy/zcode 等外部 harness 平台）', () => {
  it('注册后即可参与 launch 校验、label 与档位生效', () => {
    registerVendor({ id: 'workbuddy', label: 'WorkBuddy', backend: 'headless-cli', sessionTier: 'per-mission', petCharacter: 'workbuddy-girl' })
    expect(isKnownVendor('workbuddy')).toBe(true)
    expect(vendorLabel('workbuddy')).toBe('WorkBuddy')
    expect(vendorSessionTier('workbuddy')).toBe('per-mission')
    const ids = listVendors().map((d) => d.id)
    expect(ids).toContain('workbuddy')
    expect(ids).toContain('claude') // 内置仍在
  })
  it('内置厂商不可覆盖（防劫持内置语义）', () => {
    expect(() => registerVendor({ id: 'claude', label: 'Fake', backend: 'custom' })).toThrow(/built-in/)
  })
  it('非法 id 拒绝（防路径/注入面）', () => {
    expect(() => registerVendor({ id: 'Bad_Vendor', label: 'x', backend: 'custom' })).toThrow(/vendor id/)
    expect(() => registerVendor({ id: 'a'.repeat(40), label: 'x', backend: 'custom' })).toThrow(/vendor id/)
  })
  it('重复注册覆盖（重启/HMR 友好）；注销生效', () => {
    registerVendor({ id: 'zcode', label: 'ZCode v1', backend: 'headless-cli' })
    registerVendor({ id: 'zcode', label: 'ZCode v2', backend: 'headless-cli' })
    expect(vendorLabel('zcode')).toBe('ZCode v2')
    unregisterVendor('zcode')
    expect(isKnownVendor('zcode')).toBe(false)
  })
})
