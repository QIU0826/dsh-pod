import { describe, expect, it } from 'vitest'
import { DshSubagentBackend, type DshAgentFactory } from '../src/workers/dsh-subagent.js'
import type { AgentSlot, Task, WorkerCompletion } from '../src/core/types.js'

/**
 * W2 三 worker 后端之一：dsh-subagent。
 * 宿主 DSH agent 会话承载任务；agentFactory 可选注入（宿主无工厂时 detect 如实报告）。
 */

const now = 1_700_000_000_000

function makeSlot(over: Partial<AgentSlot> = {}): AgentSlot {
  return {
    id: 'S-1',
    mission_id: 'M-1',
    vendor: 'dsh',
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
    ...over,
  }
}

function makeTask(id = 'T-1'): Task {
  return {
    id,
    mission_id: 'M-1',
    title: '实现 X',
    spec: '在 src/x.ts 实现 f()',
    skill_tags: ['编码'],
    type: 'implement',
    depends_on: [],
    status: 'running',
    attempts: 0,
    soft_attempts: 0,
    max_wall_clock_ms: 3600_000,
    created_at: now,
    updated_at: now,
  }
}

/** fake agent factory：记录 start/goal，按脚本产出消息与结束。 */
function makeFactory(script: { messages?: string[] }) {
  const started: Array<{ sessionId: string; cwd: string }> = []
  const factory: DshAgentFactory = {
    async createSession() {
      return { sessionId: `dsh-sess-${started.length + 1}` }
    },
    async sendGoal(sessionId, goal) {
      started.push({ sessionId, cwd: '' })
      void goal
      return
    },
    async collectMessages(sessionId) {
      void sessionId
      return (script.messages ?? []).map((text, i) => ({
        id: `m-${i}`,
        role: 'assistant',
        content: text,
      }))
    },
    async disposeSession() {},
  }
  return { factory, started }
}

describe('DshSubagentBackend（W2 三后端之一）', () => {
  it('detect：有 agentFactory → 已就绪；无 → 如实报告未安装（不假装可用）', async () => {
    const withFactory = new DshSubagentBackend({ agentFactory: makeFactory({}).factory })
    const ready = await withFactory.detect()
    expect(ready.installed).toBe(true)
    expect(ready.session_tiers).toContain('transient')

    const without = new DshSubagentBackend({})
    const missing = await without.detect()
    expect(missing.installed).toBe(false)
    expect(missing.error).toMatch(/factory/i)
  })

  it('start：创建会话 + 发送 goal（spec）+ 收集消息 → 完成信号', async () => {
    const report = '{"task_id":"T-1","task_type":"implement","status":"done","summary":"ok","files_changed":["src/x.ts"],"test_result":"not_run","decisions":[],"blockers":[],"questions":[]}'
    const { factory, started } = makeFactory({
      messages: ['第一步', '第二步', `最终报告：\n${report}`],
    })
    const backend = new DshSubagentBackend({ agentFactory: factory })
    const progress: string[] = []
    let completion: WorkerCompletion | undefined
    const handle = await backend.start(makeSlot(), makeTask(), 'C:\\repo\\.wt\\S-1', {
      onProgress: (e) => {
        if (e.kind === 'text' && e.text) progress.push(e.text)
      },
      onExit: (c) => {
        completion = c
      },
    })
    expect(started).toHaveLength(1)
    expect(handle.session_ref).toContain('dsh-sess')
    // 异步消息链：等待完成信号（fake factory 立即兑现，一个宏任务足够）
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(progress).toContain('第一步')
    expect(completion).toBeDefined()
    expect(completion!.exit).toBe('done')
    expect(completion!.report?.task_id).toBe('T-1')
  })

  it('kill：dispose 会话（幂等，无进程可杀）', async () => {
    const { factory } = makeFactory({})
    const backend = new DshSubagentBackend({ agentFactory: factory })
    const handle = await backend.start(makeSlot(), makeTask(), 'C:\\repo\\.wt\\S-1', {})
    await expect(backend.kill(handle)).resolves.toBeUndefined()
  })

  it('无 agentFactory 时 start 拒绝（明确失败而非静默）', async () => {
    const backend = new DshSubagentBackend({})
    await expect(backend.start(makeSlot(), makeTask(), 'C:\\repo\\.wt\\S-1', {})).rejects.toThrowError(/factory/i)
  })
})
