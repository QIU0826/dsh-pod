/**
 * 失败证据指纹（信息增量式止损 early exit，调研 2026-08-29 §1.3 第 4 条）。
 *
 * 现有 watchdog 按**时间**触发（空闲/墙钟），没有「是否还在产生新信息」的维度：
 * 连续 N 轮失败且证据完全相同（同故障 + 同错误签名）时，再重试只是重复付费
 * （byAttempt 实测失败路径是 token 方差大头）→ 应提前止损转人工，而不是烧满
 * attempts=3。
 *
 * 纯函数、无 IO：指纹只由 (fault, message) 决定，供 TaskMachine 在 applyFailure
 * 里做「与上次失败是否同证据」的确定性比较。灰度：experiments 'early-exit' 开关，
 * 默认关（fail-closed）。
 */

import type { FaultKind } from './types.js'

/**
 * 归一化错误信息为稳定签名：
 * - 空白折叠 + 小写（同一根因的格式抖动不改变签名）；
 * - 截断到 400 字符（超长 stderr 尾部取尾段——错误细节通常在尾部）；
 * - **不去除数字**：退出码 / 测试计数 / 行号本身就是证据的一部分（同签名要求
 *   连数字都一致，宁可少触发不可误杀，fail-closed 方向）。
 */
export function normalizeEvidence(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim().toLowerCase()
  return collapsed.length <= 400 ? collapsed : collapsed.slice(-400)
}

/** 失败证据签名 = 故障类别 + 归一化消息。两次完全同因的失败签名相等。 */
export function failureSignature(fault: FaultKind, message: string): string {
  return fault + '::' + normalizeEvidence(message)
}

/** 默认止损阈值：连续 2 轮「完全同证据」的失败（第 2 次与第 1 次同签名）即止损，省下第 3 轮全价重试。 */
export const EARLY_EXIT_DEFAULT_THRESHOLD = 2
