/**
 * 协议适配器层（Berd-G）：WorkerProtocol 元数据声明与能力位正确性。
 */
import { describe, expect, it } from 'vitest'
import { ClaudeHeadlessBackend } from '../src/workers/claude-headless.js'
import { CodexHeadlessBackend } from '../src/workers/codex-headless.js'
import { DshSubagentBackend } from '../src/workers/dsh-subagent.js'

describe('WorkerBackend.protocol（Berd-G 协议元数据）', () => {
  it('claude：headless-cli / 会话持久 / 结构化输出 / usage 审计', () => {
    const b = new ClaudeHeadlessBackend({ allowedTools: ['Read'] })
    expect(b.protocol.family).toBe('headless-cli')
    expect(b.protocol.capabilities).toEqual({ kill: true, session_persist: true, structured_output: true, usage_audit: true })
  })

  it('codex：headless-cli / 瞬时档位（session_persist=false）/ usage 不可审计（诚实化 D7）', () => {
    const b = new CodexHeadlessBackend({ binary: 'codex' })
    expect(b.protocol.family).toBe('headless-cli')
    expect(b.protocol.capabilities.session_persist).toBe(false)
    expect(b.protocol.capabilities.usage_audit).toBe(false)
  })

  it('dsh：native / 进程内（kill 由宿主托管）', () => {
    const b = new DshSubagentBackend()
    expect(b.protocol.family).toBe('native')
    expect(b.protocol.capabilities.kill).toBe(false)
    expect(b.protocol.capabilities.session_persist).toBe(true)
  })

  it('三个现网后端声明完整（family/version/capabilities 四能力位齐全）', () => {
    const backends = [
      new ClaudeHeadlessBackend({ allowedTools: [] }),
      new CodexHeadlessBackend({ binary: 'codex' }),
      new DshSubagentBackend(),
    ]
    for (const b of backends) {
      expect(b.protocol.family).toMatch(/headless-cli|acp|native/)
      for (const k of ['kill', 'session_persist', 'structured_output', 'usage_audit'] as const) {
        expect(typeof b.protocol.capabilities[k]).toBe('boolean')
      }
    }
  })
})
