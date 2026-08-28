import { describe, expect, it, vi } from 'vitest'
import { makePodTools, makeCommanderStartTool } from '../src/pod-tools.js'
import type { PodService } from '../src/pod-service.js'

/** fake PodService：只验证工具薄壳的调用协议，编排逻辑在 orchestrator.test.ts 覆盖。 */
function fakeService() {
  return {
    launch: vi.fn((input) => ({ id: 'M-1', name: input.name, status: 'planning', goal: input.goal })),
    status: vi.fn(() => ({ tasks: [], pendingApprovals: [] })),
    dispatchNext: vi.fn(async () => true),
    steer: vi.fn(),
    approve: vi.fn(async () => ({ ok: true, mergeCommit: 'abc123456789' })),
    deny: vi.fn(),
    abort: vi.fn(),
    waitRun: vi.fn(() => undefined),
    getApproval: vi.fn(() => undefined),
    approveDispatchGate: vi.fn(),
    denyDispatchGate: vi.fn(),
    pauseMission: vi.fn(),
    resumeMission: vi.fn(),
    recordToolAudit: vi.fn(),
    memoryWrite: vi.fn((input) => ({ id: 'MEM-1', owner_slot_id: input.owner_slot_id, type: input.type ?? 'fact', importance: input.importance ?? 3, tags: input.tags ?? [], content_ref: input.content_ref ?? '', live_ref: input.live_ref })),
    memoryQuery: vi.fn(() => []),
    memoryCorrect: vi.fn((id) => ({ id })),
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
  it('十四个 pod_* 工具按方案书清单注册（含 v0.2 记忆三件套 + v0.3 cron 只读面）', () => {
    const { tools, names } = makePodTools(fakeService())
    expect(names).toEqual([
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
    ])
    expect(tools).toHaveLength(14)
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

  it('pod_approve approve → 调用服务并回报合并结果（W5 合并已接入）', async () => {
    const service = fakeService()
    const { tools } = makePodTools(service)
    const approve = tools[5]!
    const result = await run(approve, { approval_id: 'A-1', decision: 'approve' })
    expect(result.decided).toBe(true)
    // AS-3：approve 携带第三个参数 edited（缺省 undefined，审计留痕）
    expect(service.approve).toHaveBeenCalledWith('A-1', 'user', undefined, true)
    expect(result.message).toContain('合并回主树')
    expect(result.message).toContain('abc12345')
  })

  it('pod_approve 合并冲突 → decided=false 且主树未动提示', async () => {
    const service = fakeService()
    ;(service.approve as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      conflict: true,
      message: 'CONFLICT (content): Merge conflict in a.txt',
    })
    const { tools } = makePodTools(service)
    const approve = tools[5]!
    const result = await run(approve, { approval_id: 'A-1', decision: 'approve' })
    expect(result.decided).toBe(false)
    expect(result.message).toContain('主树未动')
    expect(result.message).toContain('a.txt')
  })

  it('pod_approve 派发确认卡（模式 2）→ 走 approveDispatchGate 而非合并', async () => {
    const service = fakeService()
    ;(service.getApproval as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'A-2',
      kind: 'dispatch',
      patch: { slot_id: 'M-1-S-1', worktree_path: '', summary: '放行派发' },
    })
    const { tools } = makePodTools(service)
    const approve = tools[5]!
    const result = await run(approve, { approval_id: 'A-2', decision: 'approve' })
    expect(result.decided).toBe(true)
    expect(service.approveDispatchGate).toHaveBeenCalledWith('A-2', 'user')
    expect(service.approve).not.toHaveBeenCalled()
    expect(result.message).toContain('已放行')
  })

  it('pod_approve 派发确认卡驳回 → 走 denyDispatchGate 且 reject 转人工', async () => {
    const service = fakeService()
    ;(service.getApproval as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'A-3',
      kind: 'dispatch',
      task_id: 'T-1',
      patch: { slot_id: 'M-1-S-1', worktree_path: '', summary: '放行派发' },
    })
    const { tools } = makePodTools(service)
    const approve = tools[5]!
    const result = await run(approve, { approval_id: 'A-3', decision: 'deny', reason: '不该派' })
    expect(result.decided).toBe(true)
    expect(service.denyDispatchGate).toHaveBeenCalledWith('A-3', 'user', '不该派')
    expect(result.message).toContain('转人工')
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

    const abort = tools[10]!
    const abortResult = await run(abort, { reason: 'stop' })
    expect(abortResult.aborted).toBe(true)
    expect(service.abort).toHaveBeenCalledWith('stop')
  })

  it('pod_pause / pod_resume 透传 service（W4 暂停/恢复）', async () => {
    const service = fakeService()
    const { tools } = makePodTools(service)
    const pause = tools[11]!
    const pauseResult = await run(pause, {})
    expect(pauseResult.paused).toBe(true)
    expect(service.pauseMission).toHaveBeenCalledTimes(1)
    const resume = tools[12]!
    const resumeResult = await run(resume, {})
    expect(resumeResult.resumed).toBe(true)
    expect(service.resumeMission).toHaveBeenCalledTimes(1)
  })

  it('pod_mem_write 调用 service.memoryWrite 并返回记录 id（v0.2 记忆三件套）', async () => {
    const service = fakeService()
    const { tools } = makePodTools(service)
    const w = tools[6]!
    const result = await run(w, { owner_slot_id: 'S-1', tags: ['x'], content_ref: '经验', importance: 5 })
    expect(result.id).toBe('MEM-1')
    expect(service.memoryWrite).toHaveBeenCalledTimes(1)
  })

  it('pod_mem_query 调用 service.memoryQuery 返回记录数组', async () => {
    const service = fakeService()
    const { tools } = makePodTools(service)
    const q = tools[7]!
    const result = await run(q, { type: 'lesson', importance_min: 3 })
    expect(Array.isArray(result.records)).toBe(true)
    expect(service.memoryQuery).toHaveBeenCalledTimes(1)
  })

  it('pod_mem_correct 调用 service.memoryCorrect（默认 by=user，审计留痕）', async () => {
    const service = fakeService()
    const { tools } = makePodTools(service)
    const c = tools[8]!
    const result = await run(c, { id: 'MEM-1', content_ref: '新', importance: 4 })
    expect(result.corrected).toBe(true)
    expect(service.memoryCorrect).toHaveBeenCalledWith('MEM-1', expect.objectContaining({ content_ref: '新', importance: 4 }), 'user')
    expect(service.memoryCorrect).toHaveBeenCalledTimes(1)
  })

  it('服务抛错 → 工具返回结构化失败而非抛出（错误不越界）', async () => {
    const service = fakeService()
    ;(service.abort as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('INVALID_TRANSITION')
    })
    const { tools } = makePodTools(service)
    const abort = tools[10]!
    const result = await run(abort, {})
    expect(result.aborted).toBe(false)
    expect(result.message).toContain('INVALID_TRANSITION')
  })
})

describe('pod_commander_start（真实宿主的 commander 会话验证入口）', () => {
  it('透传 goal/cwd/preset 给启动函数并返回 session id', async () => {
    const launch = vi.fn(async (_goal: string, _cwd: string, _agentPreset?: string) => ({
      sessionId: `pod-mission-1`,
      message: 'created',
    }))
    const tool = makeCommanderStartTool(launch)
    const result = await run(tool, { goal: '实现 X', cwd: 'C:\\repo', agent_preset: 'pod-commander' })
    expect(result.session_id).toBe('pod-mission-1')
    expect(launch).toHaveBeenCalledWith('实现 X', 'C:\\repo', 'pod-commander')
  })

  it('启动抛错 → 结构化失败不越界', async () => {
    const tool = makeCommanderStartTool(async () => {
      throw new Error('AGENT_FACTORY_UNAVAILABLE')
    })
    const result = await run(tool, { goal: 'g', cwd: 'C:\\repo' })
    expect(result.session_id).toBe('')
    expect(result.message).toContain('AGENT_FACTORY_UNAVAILABLE')
  })
})

  it('AgentScope-E：每个工具调用触发 recordToolAudit（记账/审计钩子落地）', async () => {
    const service = fakeService()
    const { tools } = makePodTools(service)
    await run(tools[0]!, { name: 'm', goal: 'g', cwd: 'D:/x', budget_usd: 1, slots: [{ id: 'S-1', vendor: 'claude', role: 'implementer', capabilities: ['编码'] }] })
    expect(service.recordToolAudit).toHaveBeenCalled()
    const call = (service.recordToolAudit as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(call.tool).toBe('pod_launch')
    expect(call.ok).toBe(true)
    expect(typeof call.ms).toBe('number')
  })

