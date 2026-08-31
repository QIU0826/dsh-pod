import { describe, expect, it, vi } from 'vitest'
import { createCommanderSession, makeGoalMessage } from '../src/commander.js'
import type { PodService } from '../src/pod-service.js'

/**
 * 契约测试（fake agents registry）：验证 commander 会话创建的官方 API 使用面——
 * create 参数、setup 内作用域工具注册（7 个 pod_*）、首条 goal 消息驱动、dispose 委托。
 * 真实 AgentRegistry/loop 的联调在插件挂载后验证（CR-05 记录）。
 */

const service = { launch: vi.fn() } as unknown as PodService

interface FakeCreateOptions {
  sessionId: string
  meta?: { cwd?: string; agentPreset?: string }
  setup?: (agentCtx: { tools: { register: (tool: { name?: string }) => () => void } }) => void | (() => void)
}

describe('createCommanderSession（官方 API 使用面契约）', () => {
  it('create 携带 sessionId/meta（cwd + agentPreset）', async () => {
    const create = vi.fn(async (options: FakeCreateOptions) => {
      options.setup?.({ tools: { register: () => () => {} } })
      return { agent: { followup: vi.fn() }, dispose: vi.fn(async () => {}) }
    })
    const session = await createCommanderSession({
      agents: { create } as never,
      service,
      sessionId: 'mission-session-1',
      cwd: 'C:\\repo',
      goal: '实现 RFC-12',
      agentPreset: 'pod-commander',
    })
    const options = create.mock.calls[0]![0]
    expect(options.sessionId).toBe('mission-session-1')
    expect(options.meta?.cwd).toBe('C:\\repo')
    expect(options.meta?.agentPreset).toBe('pod-commander')
    expect(session.sessionId).toBe('mission-session-1')
  })

  it('setup 经 agentCtx.tools.register 注册全部 pod_* 工具（含 P0-1 pod_expand_tool；作用域注册，非全局）', async () => {
    const toolNames: string[] = []
    const agentCtxRegister = vi.fn((tool: { name?: string }) => {
      if (typeof tool.name === 'string') toolNames.push(tool.name)
      return () => {}
    })
    const create = vi.fn(async (options: FakeCreateOptions) => {
      options.setup?.({ tools: { register: agentCtxRegister } })
      return { agent: { followup: vi.fn() }, dispose: vi.fn(async () => {}) }
    })
    await createCommanderSession({
      agents: { create } as never,
      service,
      sessionId: 's-1',
      cwd: 'C:\\repo',
      goal: 'g',
    })
    expect(toolNames).toEqual([
      'pod_launch',
      'pod_status',
      'pod_dispatch',
      'pod_collect',
      'pod_steer',
      'pod_approve',
      'pod_mem_write',
      'pod_mem_query',
      'pod_mem_correct',
      'pod_reassign',
      'pod_abort',
      'pod_pause',
      'pod_resume',
      'pod_cron_list',
      'pod_plan',
      'pod_expand_tool',
    ])
  })

  it('创建后以 goal 驱动（followup），消息带 plugin 来源', async () => {
    let followupArg: unknown
    const create = vi.fn(async (options: FakeCreateOptions) => {
      options.setup?.({ tools: { register: () => () => {} } })
      return {
        agent: {
          followup: (message: unknown) => {
            followupArg = message
          },
        },
        dispose: vi.fn(async () => {}),
      }
    })
    await createCommanderSession({
      agents: { create } as never,
      service,
      sessionId: 's-1',
      cwd: 'C:\\repo',
      goal: '实现 RFC-12',
    })
    const message = followupArg as { content: Array<{ type: string; text: string }>; source: { kind: string; plugin: string } }
    expect(message.content[0]?.text).toBe('实现 RFC-12')
    expect(message.source.kind).toBe('plugin')
    expect(message.source.plugin).toBe('dsh-pod')
  })

  it('dispose 委托 AgentHandle.dispose', async () => {
    let disposed = false
    const create = vi.fn(async (options: FakeCreateOptions) => {
      options.setup?.({ tools: { register: () => () => {} } })
      return {
        agent: { followup: vi.fn() },
        dispose: async () => {
          disposed = true
        },
      }
    })
    const session = await createCommanderSession({
      agents: { create } as never,
      service,
      sessionId: 's-1',
      cwd: 'C:\\repo',
      goal: 'g',
    })
    await session.dispose()
    expect(disposed).toBe(true)
  })
})

describe('makeGoalMessage', () => {
  it('生成 plugin 来源的用户消息（durable 日志可追溯）', () => {
    const message = makeGoalMessage('目标')
    expect(message.role).toBe('user')
    expect(message.source.kind).toBe('plugin')
    expect(message.content).toEqual([{ type: 'text', text: '目标' }])
  })
})
