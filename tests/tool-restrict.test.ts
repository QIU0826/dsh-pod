/**
 * P0-1 宿主侧接线（tool-restrict）回归测试：
 *   - missionStatusToStage 状态映射
 *   - podDenyForStage：deny 集只含「该阶段必然失败」的工具（fail-safe 方向）
 *   - StageDenyController：差分驱动（掩码不变不重复 apply）/ 变更先 lift 再 apply /
 *     apply 抛错保持全量可见 / dispose 永久解除
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MISSION_SCOPED_TOOLS,
  StageDenyController,
  missionStatusToStage,
  podDenyForStage,
} from '../src/core/tool-restrict.js'

describe('missionStatusToStage', () => {
  it('undefined → none；四态各归其位；未知/终态 → terminal', () => {
    expect(missionStatusToStage(undefined)).toBe('none')
    expect(missionStatusToStage('planning')).toBe('planning')
    expect(missionStatusToStage('running')).toBe('running')
    expect(missionStatusToStage('awaiting_approval')).toBe('awaiting_approval')
    expect(missionStatusToStage('paused')).toBe('paused')
    expect(missionStatusToStage('done')).toBe('terminal')
    expect(missionStatusToStage('aborted')).toBe('terminal')
  })
})

describe('podDenyForStage（deny 只含必然失败的调用）', () => {
  it('none/terminal：mission 域工具全部 deny，launch/plan/status 等保持可见', () => {
    const denied = podDenyForStage('none')
    expect(denied).toEqual(MISSION_SCOPED_TOOLS)
    expect(denied).not.toContain('pod_launch')
    expect(denied).not.toContain('pod_status')
    expect(denied).not.toContain('pod_plan')
    expect(denied).not.toContain('pod_mem_write')
    expect(denied).not.toContain('pod_expand_tool')
  })
  it('planning/running：只 deny pod_launch（单活跃锁必 409）', () => {
    expect(podDenyForStage('planning')).toEqual(['pod_launch'])
    expect(podDenyForStage('running')).toEqual(['pod_launch'])
  })
  it('awaiting_approval/paused：连 pod_dispatch 一起 deny（停摆守卫恒 false）', () => {
    expect(podDenyForStage('awaiting_approval')).toEqual(['pod_launch', 'pod_dispatch'])
    expect(podDenyForStage('paused')).toEqual(['pod_launch', 'pod_dispatch'])
  })
})

describe('StageDenyController（差分驱动）', () => {
  it('掩码不变 → 不重复 apply；变化 → 先 lift 旧再 apply 新', () => {
    const liftOld = vi.fn()
    let next = liftOld
    const applyDeny = vi.fn(() => next)
    const c = new StageDenyController(applyDeny)

    // none → apply none 掩码（mission 域工具隐藏）
    expect(c.sync('none')).toEqual({ changed: true, denied: [...MISSION_SCOPED_TOOLS] })
    expect(applyDeny).toHaveBeenCalledTimes(1)

    // none → running：lift none 掩码，再 apply pod_launch
    expect(c.sync('running')).toEqual({ changed: true, denied: ['pod_launch'] })
    expect(liftOld).toHaveBeenCalledTimes(1)
    expect(applyDeny).toHaveBeenCalledTimes(2)

    // running → running：不变不 apply
    expect(c.sync('running').changed).toBe(false)
    expect(applyDeny).toHaveBeenCalledTimes(2)

    // running → awaiting_approval：lift 旧（pod_launch）再 apply 新掩码
    expect(c.sync('awaiting_approval')).toEqual({ changed: true, denied: ['pod_launch', 'pod_dispatch'] })
    expect(liftOld).toHaveBeenCalledTimes(2)
    expect(applyDeny).toHaveBeenCalledTimes(3)
  })

  it('回 none：lift 旧约束后不 apply（全量可见）', () => {
    const lifts: Array<() => void> = []
    const applyDeny = vi.fn(() => {
      const l = vi.fn()
      lifts.push(l)
      return l
    })
    const c = new StageDenyController(applyDeny)
    c.sync('running')
    // 回 none：lift running 掩码后 apply none 掩码（mission 域工具重新隐藏）
    expect(c.sync('none')).toEqual({ changed: true, denied: [...MISSION_SCOPED_TOOLS] })
    expect(lifts[0]).toHaveBeenCalledTimes(1)
    expect(applyDeny).toHaveBeenCalledTimes(2)
  })

  it('apply 抛错（宿主拒绝未知名）→ 保持全量可见，不炸巡检', () => {
    const applyDeny = vi.fn(() => {
      throw new Error('unknown tool name')
    })
    const c = new StageDenyController(applyDeny)
    expect(c.sync('running')).toEqual({ changed: true, denied: [] })
    // 下一轮重试同掩码（applied 为空 ≠ 目标），仍 fail-safe
    expect(c.sync('running').changed).toBe(true)
  })

  it('dispose 解除在途约束', () => {
    const lift = vi.fn()
    const applyDeny = vi.fn(() => lift)
    const c = new StageDenyController(applyDeny)
    c.sync('running')
    c.dispose()
    expect(lift).toHaveBeenCalledTimes(1)
    // dispose 后再 sync：重新按目标 apply
    expect(c.sync('running').changed).toBe(true)
  })
})
