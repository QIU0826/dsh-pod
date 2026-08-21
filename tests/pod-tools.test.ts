import { describe, expect, it, vi } from 'vitest'
import { makePodTools } from '../src/pod-tools.js'
import type { PodService } from '../src/pod-service.js'

/** fake PodService：只验证工具薄壳的调用协议，编排逻辑在 orchestrator.test.ts 覆盖。 */
function fakeService() {
  return {
    launch: vi.fn((input) => ({ id: 'M-1', name: input.name, status: 'planning', goal: input.goal })),
    status: vi.fn(() => ({ tasks: [], pendingApprovals: [] })),
    dispatchNext: vi.fn(async () => true),
    steer: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
    abort: vi.fn(),
    waitRun: vi.fn(() => undefined),
  } as unknown as PodService
}

// defineTool 返回 execute: (args, exec) => Promise<unknown>；测试以结构化断言收窄
async function run(
  tool: { execute: (args: never, exec: never) => Promise<unknown> },
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (await tool.execute(args as never, undefined as never)) as Record<string, unknown>
}

describe('pod_* 工具注册面（3.3 节工具作用域清单，七件套）', () => {
  it('七个工具按方案书清单注册', () => {
    const { tools, names } = makePodTools(fakeService())
    expect(names).toEqual([
      'pod_launch',
      'pod_status',
      'pod_dispatch',
      'pod_collect',
      'pod_steer',
      'pod_approve',
      'pod_abort',
    ])
    expect(tools).toHaveLength(7)
  })

  it('每个工具带参数 schema 与输出渲染（契约完整）', () => {
    const { tools } = makePodTools(fakeService())
    for (const tool of tools) {
      expect(tool.name).toMatch(/^pod_/)
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.parameters).toBeDefined()
      expect(tool.output?.render).toBeTypeOf('function')
      expect(typeof tool.execute).toBe('function')
    }
  })
})

describe('工具薄壳行为（副作用全部走 PodService）', () => {
  it('pod_launch 透传组队参数并返回 mission id', async () => {
    const service = fakeService()
    const { tools } = makePodTools(service)
    const launch = tools[0]!
    const result = await run(launch, {
      name: 'demo',
      goal: 'g',
      cwd: 'C:\\repo',
      slots: [{ id: 'S-1', vendor: 'claude', role: 'implementer', capabilities: ['编码'] }],
      plan: [],
    })
    expect(result.mission_id).toBe('M-1')
    const input = (service.launch as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(input.goal).toBe('g')
    expect(input.budgetUsd).toBe(3) // 默认预算
  })

  it('pod_status 无 active mission → 明确提示', async () => {
    const { tools } = makePodTools(fakeService())
    const status = tools[1]!
    const result = await run(status, {})
    expect(result.message).toContain('pod_launch')
  })

  it('pod_approve deny 缺 reason → 拒绝且不调用服务', async () => {
    const service = fakeService()
    const { tools } = makePodTools(service)
    const approve = tools[5]!
    const result = await run(approve, { approval_id: 'A-1', decision: 'deny' })
    expect(result.decided).toBe(false)
    expect(result.message).toContain('reason')
    expect(service.deny).not.toHaveBeenCalled()
  })

  it('pod_approve approve → 调用服务（合并属 W5 的提示如实返回）', async () => {
    const service = fakeService()
    const { tools } = makePodTools(service)
    const approve = tools[5]!
    const result = await run(approve, { approval_id: 'A-1', decision: 'approve' })
    expect(result.decided).toBe(true)
    expect(service.approve).toHaveBeenCalledWith('A-1', 'user')
    expect(result.message).toContain('W5')
  })

  it('pod_steer 排队指令；pod_dispatch 手动派发；pod_abort 透传原因', async () => {
    const service = fakeService()
    const { tools } = makePodTools(service)
    const steer = tools[4]!
    const steerResult = await run(steer, { slot_id: 'S-1', instruction: '加一层缓存' })
    expect(steerResult.queued).toBe(true)
    expect(service.steer).toHaveBeenCalledWith('S-1', '加一层缓存')

    const dispatch = tools[2]!
    const dispatchResult = await run(dispatch, {})
    expect(dispatchResult.dispatched).toBe(true)

    const abort = tools[6]!
    const abortResult = await run(abort, { reason: 'stop' })
    expect(abortResult.aborted).toBe(true)
    expect(service.abort).toHaveBeenCalledWith('stop')
  })

  it('服务抛错 → 工具返回结构化失败而非抛出（错误不越界）', async () => {
    const service = fakeService()
    ;(service.abort as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('INVALID_TRANSITION')
    })
    const { tools } = makePodTools(service)
    const abort = tools[6]!
    const result = await run(abort, {})
    expect(result.aborted).toBe(false)
    expect(result.message).toContain('INVALID_TRANSITION')
  })
})
