/**
 * 开放式厂商注册表（2026-09-06 harness 可扩展切片）。
 *
 * 此前 Vendor 是闭合联合（claude/codex/dsh/ark/opencode 五处硬编码校验）——接入
 * workbuddy / zcode / 任何新 harness 平台都要改核心。本模块把「谁是合法厂商」从
 * 类型收窄改为**运行时注册**：内置五家常驻，外部平台调用 registerVendor 后即可
 * 参与校验（validateLaunch / pod_launch schema / IM 面），编排/存储/事件面零改动
 * （Vendor 类型已开放为 BuiltInVendor | string）。
 *
 * 接入一个新 harness 的完整路径见 docs/harness-接入指南.md：
 *   1. 实现 WorkerBackend（headless-cli / remote / native 任一形态）
 *   2. registerVendor({ id, label, ... })
 *   3. backends 记录注入该 vendor 的后端实例
 *   4. （可选）pet-characters 换装 / model-cards 计价
 */

import { BUILT_IN_VENDORS, type SessionTier } from './types.js'

/** 厂商描述符：注册一个外部 harness 平台所需的最小元数据。 */
export interface VendorDescriptor {
  /** 厂商 id（launch 槽位的 vendor 字段值；小写字母数字与连字符）。 */
  id: string
  /** 展示名（UI 名牌 / IM 回复）。 */
  label: string
  /** 后端形态（文档与 pet 呈现用；真正的执行行为由 WorkerBackend 实现决定）。 */
  backend: 'headless-cli' | 'remote' | 'native' | 'custom'
  /** 缺省会话档位（未指定时的回退；缺省 transient）。 */
  sessionTier?: SessionTier
  /** 桌宠角色 id（pet-characters 外部资产；缺省内置鲸鱼娘）。 */
  petCharacter?: string
}

const customVendors = new Map<string, VendorDescriptor>()

const BUILT_IN_DESCRIPTORS: VendorDescriptor[] = [
  { id: 'claude', label: 'Claude', backend: 'headless-cli', sessionTier: 'per-mission' },
  { id: 'codex', label: 'Codex', backend: 'headless-cli', sessionTier: 'transient' },
  { id: 'dsh', label: 'DSH', backend: 'native', sessionTier: 'transient' },
  { id: 'ark', label: 'Ark', backend: 'headless-cli', sessionTier: 'transient' },
  { id: 'opencode', label: 'OpenCode', backend: 'headless-cli', sessionTier: 'transient' },
]

export function isSafeVendorId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(id)
}

/**
 * 注册外部 harness 厂商。重复注册覆盖（同 id 重启/HMR 友好）；
 * 内置五家不可覆盖（防钓鱼厂商劫持内置语义）。
 */
export function registerVendor(descriptor: VendorDescriptor): void {
  if (!isSafeVendorId(descriptor.id)) {
    throw new Error(`vendor id must match [a-z0-9][a-z0-9-]{0,31}: ${descriptor.id}`)
  }
  if ((BUILT_IN_VENDORS as readonly string[]).includes(descriptor.id)) {
    throw new Error(`vendor ${descriptor.id} is built-in and cannot be overridden`)
  }
  customVendors.set(descriptor.id, { ...descriptor })
}

/** 注销外部厂商（已存在的槽位/任务不受影响——历史数据以字符串留存）。 */
export function unregisterVendor(id: string): void {
  customVendors.delete(id)
}

/** 全部已知厂商（内置 + 已注册外部）。 */
export function listVendors(): VendorDescriptor[] {
  return [...BUILT_IN_DESCRIPTORS, ...customVendors.values()]
}

/** 校验：launch 槽位 vendor 合法性（内置常真 + 已注册外部）。 */
export function isKnownVendor(vendor: string): boolean {
  return (BUILT_IN_VENDORS as readonly string[]).includes(vendor) || customVendors.has(vendor)
}

/** 展示名（UI 名牌 / IM）：未知厂商回原始 id。 */
export function vendorLabel(vendor: string): string {
  return customVendors.get(vendor)?.label ?? BUILT_IN_DESCRIPTORS.find((d) => d.id === vendor)?.label ?? vendor
}

/** 厂商缺省会话档位（orchestrator 槽位创建回退用）。 */
export function vendorSessionTier(vendor: string): SessionTier {
  return customVendors.get(vendor)?.sessionTier
    ?? BUILT_IN_DESCRIPTORS.find((d) => d.id === vendor)?.sessionTier
    ?? 'transient'
}

/** 测试/多实例隔离：清空外部注册（内置不受影响）。 */
export function resetVendorRegistry(): void {
  customVendors.clear()
}
