import { describe, expect, it, vi } from 'vitest'
import { wrapTool } from '../src/core/middleware.js'

/**
 * AgentScope-E：工具级 onion middleware。
 * wrapTool(tool, hooks) 统一记账/审计/事件，消除调用点重复。
 */

interface TestTool {
  name: string
  execute(args: unknown): Promise<unknown>
}

function makeTool(name = 'pod_status'): TestTool & { calls: number } {
  const tool = {
    name,
    calls: 0,
    async execute(args: unknown): Promise<unknown> {
      tool.calls += 1
      return { ok: true, echo: args }
    },
  }
  return tool
}

describe('wrapTool（工具级 onion middleware，AgentScope-E）', () => {
  it('before/after 钩子包住原工具调用（顺序：before → execute → after）', async () => {
    const order: string[] = []
    const tool = makeTool()
    const wrapped = wrapTool(tool, {
      before: async () => {
        order.push('before')
      },
      after: async (result) => {
        order.push(`after:${String((result as { ok: boolean }).ok)}`)
        return result
      },
    })
    const result = await wrapped.execute({ x: 1 })
    expect(order).toEqual(['before', 'after:true'])
    expect(tool.calls).toBe(1)
    expect((result as { ok: boolean }).ok).toBe(true)
  })

  it('before 抛错 → 原工具不执行（拦截语义）', async () => {
    const tool = makeTool()
    const wrapped = wrapTool(tool, {
      before: async () => {
        throw new Error('blocked by middleware')
      },
    })
    await expect(wrapped.execute({})).rejects.toThrowError(/blocked/)
    expect(tool.calls).toBe(0)
  })

  it('记账钩子：after 可记录 usage 并透传结果', async () => {
    const tool = makeTool()
    const ledger: Array<{ name: string; args: unknown; result: unknown }> = []
    const wrapped = wrapTool(tool, {
      after: async (result, args) => {
        ledger.push({ name: tool.name, args, result })
        return result
      },
    })
    await wrapped.execute({ task_id: 'T-1' })
    expect(ledger).toHaveLength(1)
    expect(ledger[0]!.name).toBe('pod_status')
    expect((ledger[0]!.args as { task_id: string }).task_id).toBe('T-1')
  })

  it('多层 wrap 洋葱：内层 after 先于外层 after（onion 语义）', async () => {
    const order: string[] = []
    const tool = makeTool()
    const inner = wrapTool(tool, { after: async (r) => (order.push('inner'), r) })
    const outer = wrapTool(inner, { after: async (r) => (order.push('outer'), r) })
    await outer.execute({})
    expect(order).toEqual(['inner', 'outer'])
  })

  it('execute 抛错时 after 不吞错（错误透传）', async () => {
    const tool: TestTool = {
      name: 'boom',
      async execute(): Promise<unknown> {
        throw new Error('tool exploded')
      },
    }
    const wrapped = wrapTool(tool, { after: vi.fn(async (r) => r) })
    await expect(wrapped.execute({})).rejects.toThrowError(/exploded/)
  })
})
