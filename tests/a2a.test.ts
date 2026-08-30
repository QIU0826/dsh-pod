/**
 * A2A wire 协议映射测试：Agent Card / mission→Task 快照 / 内部事件→流事件 /
 * sendMessage 请求体解析（message.parts[].text + configuration）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildAgentCard,
  internalEventToA2a,
  isFinalA2aEvent,
  missionState,
  missionToA2aTask,
} from '../src/core/a2a.js'
import { parseA2aBody } from '../src/routes.js'
import type { Mission, PodEvent } from '../src/core/types.js'

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'M-1',
    name: 'm',
    goal: '写一个工具函数',
    status: 'running',
    budget_usd: 3,
    spent_tokens: 0,
    spent_equiv_usd: 0,
    approval_mode: 1,
    cwd: 'D:\\repo',
    worktree_policy: 'per-slot',
    orchestration_mode: 'commander',
    commander_healthy: true,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...over,
  }
}

function ev(kind: string, payload: Record<string, unknown>, over: Partial<PodEvent> = {}): PodEvent {
  return {
    id: `ev-${kind}`,
    mission_id: 'M-1',
    ts: 1_700_000_000_000,
    kind,
    payload,
    ...over,
  }
}

describe('Agent Card（发现端点）', () => {
  it('名册 → 技能表；能力位如实（流式真支持，推送未实现）', () => {
    const card = buildAgentCard({
      baseUrl: 'http://127.0.0.1:3930/',
      slots: [
        { id: 'S-1', role: '实现工程师', capabilities: ['实现', '测试'], vendor: 'claude', model: 'deepseek' },
        { id: 'S-2', role: '审查员', capabilities: ['审查'], vendor: 'codex', model: '' },
      ],
    }) as Record<string, unknown> & { capabilities: Record<string, unknown>; skills: Array<Record<string, unknown>> }
    expect(card.url).toBe('http://127.0.0.1:3930/a2a')
    expect(card.capabilities.streaming).toBe(true)
    expect(card.capabilities.pushNotifications).toBe(false)
    expect(card.skills).toHaveLength(2)
    expect(card.skills[0]!.tags).toEqual(['实现', '测试'])
    // 凭据/内部路径不出协议面：NoAuth（loopback-only 部署）
    expect(JSON.stringify(card.security)).toBe('[{"schemes":[]}]')
  })
})

describe('mission → A2A Task 映射', () => {
  it('状态映射：running→working；awaiting_approval/paused→input-required；done→completed；aborted→canceled', () => {
    expect(missionState(mission({ status: 'planning' }))).toBe('working')
    expect(missionState(mission({ status: 'running' }))).toBe('working')
    expect(missionState(mission({ status: 'awaiting_approval' }))).toBe('input-required')
    expect(missionState(mission({ status: 'paused' }))).toBe('input-required')
    expect(missionState(mission({ status: 'done' }))).toBe('completed')
    expect(missionState(mission({ status: 'aborted' }))).toBe('canceled')
  })

  it('missionToA2aTask：任务快照含元数据（cwd/预算），不泄凭据', () => {
    const task = missionToA2aTask(mission(), '写一个工具函数')
    expect(task.id).toBe('M-1')
    expect(task.kind).toBe('task')
    expect(task.status.state).toBe('working')
    expect(task.metadata?.cwd).toBe('D:\\repo')
    expect(JSON.stringify(task)).not.toContain('token')
    expect(JSON.stringify(task)).not.toContain('api_key')
  })
})

describe('内部事件 → A2A 流事件', () => {
  it('mission 终态 → final status-update（completed/rejected/canceled）', () => {
    const done = internalEventToA2a(ev('mission_done', {}))
    expect(done).toHaveLength(1)
    expect(done[0]!.kind).toBe('status-update')
    expect((done[0] as { status: { state: string } }).status.state).toBe('completed')
    expect(isFinalA2aEvent(done[0]!)).toBe(true)

    const denied = internalEventToA2a(ev('mission_denied', { reason: '风格不符' }))
    expect((denied[0] as { status: { state: string } }).status.state).toBe('rejected')
    expect(isFinalA2aEvent(denied[0]!)).toBe(true)

    const aborted = internalEventToA2a(ev('mission_aborted', { reason: 'x' }))
    expect((aborted[0] as { status: { state: string } }).status.state).toBe('canceled')
  })

  it('协商三态 → artifact-update（要约/接受/谢绝换人）', () => {
    const offer = internalEventToA2a(ev('task_negotiation', { phase: 'offer', to_slot: 'S-1' }, { task_id: 'T-1' }))
    expect(offer[0]!.kind).toBe('artifact-update')
    expect((offer[0] as { artifact: { parts: Array<{ text: string }> } }).artifact.parts[0]!.text).toContain('要约 T-1 → S-1')

    const accepted = internalEventToA2a(ev('task_negotiation', { phase: 'accepted', by_slot: 'S-1' }, { task_id: 'T-1' }))
    expect((accepted[0] as { artifact: { parts: Array<{ text: string }> } }).artifact.parts[0]!.text).toContain('接受')

    const rejected = internalEventToA2a(ev('task_negotiation', { phase: 'rejected', by_slot: 'S-1', reason: '凭据失效' }, { task_id: 'T-1' }))
    expect((rejected[0] as { artifact: { parts: Array<{ text: string }> } }).artifact.parts[0]!.text).toContain('谢绝')
    expect((rejected[0] as { artifact: { parts: Array<{ text: string }> } }).artifact.parts[0]!.text).toContain('凭据失效')
  })

  it('worker_progress 文本与工具调用 → 流式 artifact；未知事件不映射', () => {
    const text = internalEventToA2a(ev('worker_progress', { kind: 'text', text: '正在读取文件' }, { slot_id: 'S-1' }))
    expect((text[0] as { artifact: { parts: Array<{ text: string }> } }).artifact.parts[0]!.text).toContain('正在读取文件')

    const tool = internalEventToA2a(ev('worker_progress', { kind: 'tool_call', tool: 'Read' }, { slot_id: 'S-1' }))
    expect((tool[0] as { artifact: { parts: Array<{ text: string }> } }).artifact.parts[0]!.text).toContain('⚒ Read')

    expect(internalEventToA2a(ev('mission_created', {}))).toEqual([])
    expect(internalEventToA2a(ev('totally_unknown', {}))).toEqual([])
  })

  it('input-required：审批等待 / 任务提问（非终态）', () => {
    const wait = internalEventToA2a(ev('mission_awaiting_approval', {}))
    expect((wait[0] as { status: { state: string } }).status.state).toBe('input-required')
    expect(isFinalA2aEvent(wait[0]!)).toBe(false)

    const q = internalEventToA2a(ev('task_question', { text: '用哪个框架？' }, { task_id: 'T-2' }))
    expect((q[0] as { status: { state: string } }).status.state).toBe('input-required')
    expect(isFinalA2aEvent(q[0]!)).toBe(false)
  })
})

describe('parseA2aBody（sendMessage 请求体）', () => {
  it('标准 A2A message.parts[].text 提取 + configuration 透传', () => {
    const parsed = parseA2aBody({
      message: { role: 'user', parts: [{ kind: 'text', text: '修复 CI 红灯' }, { kind: 'text', text: '并补测试' }] },
      configuration: { cwd: 'D:\\repo', parallel: 4, budget_usd: 5 },
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.goal).toBe('修复 CI 红灯\n并补测试')
    expect(parsed.value.launchBody.cwd).toBe('D:\\repo')
    expect(parsed.value.launchBody.parallel).toBe(4)
    expect(parsed.value.launchBody.budget_usd).toBe(5)
    // 未指定名册 → 默认员工面（claude 实现 + 审查）
    expect(parsed.value.launchBody.slots).toHaveLength(2)
  })

  it('空消息 / 缺 parts → -32602 语义错误', () => {
    expect(parseA2aBody({ message: { role: 'user', parts: [] } }).ok).toBe(false)
    expect(parseA2aBody(undefined).ok).toBe(false)
    expect(parseA2aBody({ configuration: {} }).ok).toBe(false)
  })

  it('自定义名册透传（configuration.slots）', () => {
    const parsed = parseA2aBody({
      message: { parts: [{ kind: 'text', text: 'g' }] },
      configuration: {
        cwd: 'D:\\repo',
        slots: [{ id: 'S-9', vendor: 'codex', role: 'dev', capabilities: ['编码'] }],
      },
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const slots = parsed.value.launchBody.slots as Array<{ id: string }>
    expect(slots[0]!.id).toBe('S-9')
  })
})
