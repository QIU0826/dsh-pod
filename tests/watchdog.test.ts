import { describe, expect, it } from 'vitest'
import { Watchdog } from '../src/core/watchdog.js'

const T0 = 1_700_000_000_000

describe('Watchdog（3.3 节 commander 健康 + 3.4 节任务空闲/墙钟，纯 tick 驱动）', () => {
  it('arm 后 tick 到达 deadline → 触发并解除', () => {
    const watchdog = new Watchdog({ clock: () => T0 })
    watchdog.arm({ key: 'commander:M-1', kind: 'commander', mission_id: 'M-1', deadline: T0 + 100 })
    expect(watchdog.tick(T0 + 99)).toEqual([])
    const fired = watchdog.tick(T0 + 100)
    expect(fired).toEqual([{ key: 'commander:M-1', kind: 'commander', mission_id: 'M-1', deadline: T0 + 100 }])
    expect(watchdog.tick(T0 + 200)).toEqual([]) // 已解除，不重复触发
  })

  it('同一 key 重复 arm → 覆盖（活动信号重置倒计时）', () => {
    const watchdog = new Watchdog({ clock: () => T0 })
    watchdog.arm({ key: 'task-idle:T-1', kind: 'task-idle', mission_id: 'M-1', task_id: 'T-1', deadline: T0 + 100 })
    watchdog.arm({ key: 'task-idle:T-1', kind: 'task-idle', mission_id: 'M-1', task_id: 'T-1', deadline: T0 + 500 })
    expect(watchdog.tick(T0 + 200)).toEqual([])
    expect(watchdog.tick(T0 + 500)).toHaveLength(1)
  })

  it('disarm 后不再触发', () => {
    const watchdog = new Watchdog({ clock: () => T0 })
    watchdog.arm({ key: 'task-wall-clock:T-1', kind: 'task-wall-clock', mission_id: 'M-1', task_id: 'T-1', deadline: T0 + 100 })
    watchdog.disarm('task-wall-clock:T-1')
    expect(watchdog.tick(T0 + 999)).toEqual([])
  })

  it('pauseAll 挂起全部计时（CR-01-4：awaiting_approval 期间不误杀）；resumeAll 顺延恢复', () => {
    let current = T0
    const watchdog = new Watchdog({ clock: () => current })
    watchdog.arm({ key: 'commander:M-1', kind: 'commander', mission_id: 'M-1', deadline: T0 + 100 })
    watchdog.arm({ key: 'task-idle:T-1', kind: 'task-idle', mission_id: 'M-1', task_id: 'T-1', deadline: T0 + 100 })
    watchdog.pauseAll()
    current = T0 + 10_000
    expect(watchdog.tick(current)).toEqual([])
    watchdog.resumeAll()
    // 挂起期间的时间不计入：deadline 顺延挂起时长 10_000
    current = T0 + 10_000 + 99
    expect(watchdog.tick(current)).toEqual([])
    current = T0 + 10_000 + 100
    expect(watchdog.tick(current)).toHaveLength(2)
  })

  it('任务空闲 watchdog：任何 stream 事件 = 重新 arm（统一由调用方重置）', () => {
    const watchdog = new Watchdog({ clock: () => T0 })
    watchdog.arm({ key: 'task-idle:T-1', kind: 'task-idle', mission_id: 'M-1', task_id: 'T-1', deadline: T0 + 15 * 60_000 })
    expect(watchdog.tick(T0 + 16 * 60_000)).toHaveLength(1)
  })

  it('默认阈值常量与方案书一致（commander 5min / 任务空闲 15min）', () => {
    const instance = new Watchdog({ clock: () => T0 })
    expect(instance.thresholdMs('commander')).toBe(5 * 60_000)
    expect(instance.thresholdMs('task-idle')).toBe(15 * 60_000)
  })

  it('pauseAll 幂等；未挂起时 resumeAll 是安全 no-op；tick 按 deadline 排序返回', () => {
    let current = T0
    const watchdog = new Watchdog({ clock: () => current })
    watchdog.pauseAll()
    watchdog.pauseAll() // 幂等：不重复累计挂起时长
    current = T0 + 1000
    watchdog.resumeAll()
    watchdog.resumeAll() // 未挂起时 no-op
    watchdog.arm({ key: 'b', kind: 'task-idle', mission_id: 'M-1', task_id: 'T-b', deadline: T0 + 2000 })
    watchdog.arm({ key: 'a', kind: 'task-wall-clock', mission_id: 'M-1', task_id: 'T-a', deadline: T0 + 1500 })
    const fired = watchdog.tick(T0 + 3000)
    expect(fired.map((f) => f.key)).toEqual(['a', 'b'])
  })

  it('faultFor：空闲 → idle_timeout，墙钟 → wall_clock（3.4 节故障表映射）', () => {
    expect(Watchdog.faultFor('task-idle')).toBe('idle_timeout')
    expect(Watchdog.faultFor('task-wall-clock')).toBe('wall_clock')
  })
})
