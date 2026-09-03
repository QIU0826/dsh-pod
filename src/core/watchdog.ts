/**
 * Watchdog —— 方案书 3.3/3.4 节：
 *   commander 健康（默认 5 分钟无状态推进 → 手动模式）
 *   任务空闲（默认 15 分钟无 stream 事件 → kill + blocked）
 *   任务墙钟（CR-01-6，默认 60 分钟 → kill + blocked）
 *
 * 纯 tick 驱动（确定性、可测）：插件层用真实定时器周期调用 tick(now)。
 * 任何活动信号（stream 事件 / 状态迁移）由调用方重新 arm 同一 key（覆盖式刷新）。
 *
 * CR-01-4：pauseAll 挂起全部计时（awaiting_approval 期间审批可挂起数天，不误杀）；
 * 挂起期间的时间不计入 deadline（顺延）。
 */

import type { FaultKind } from './types.js'
import { COMMANDER_WATCHDOG_MS, DEFAULT_MAX_WALL_CLOCK_MS, TASK_IDLE_WATCHDOG_MS } from './types.js'

export type WatchdogKind = 'commander' | 'task-idle' | 'task-wall-clock'

export interface WatchdogArm {
  key: string
  kind: WatchdogKind
  mission_id: string
  task_id?: string
  /** 绝对触发时刻（epoch ms）。 */
  deadline: number
  /** arm 时刻（epoch ms）：arm() 自动补记；resumeAll 按「pause 前 arm 还是暂停中 arm」
   *  区分顺延量——暂停中 arm 的计时器若顺延整个挂起时长会过度顺延（多给最多整个
   *  挂起期的预算）。 */
  armed_at?: number
}

export interface FiredWatchdog {
  key: string
  kind: WatchdogKind
  mission_id: string
  task_id?: string
  deadline: number
}

export interface WatchdogOptions {
  clock?: () => number
}

const DEFAULT_THRESHOLDS: Record<WatchdogKind, number> = {
  commander: COMMANDER_WATCHDOG_MS,
  'task-idle': TASK_IDLE_WATCHDOG_MS,
  'task-wall-clock': DEFAULT_MAX_WALL_CLOCK_MS,
}

export class Watchdog {
  private readonly arms = new Map<string, WatchdogArm>()
  private readonly clock: () => number
  private readonly overrides = new Map<WatchdogKind, number>()
  private paused = false
  /** 挂起开始时刻：resume 时把所有 deadline 顺延挂起时长。 */
  private pausedAt: number | undefined

  constructor(options: WatchdogOptions = {}) {
    this.clock = options.clock ?? (() => Date.now())
  }

  thresholdMs(kind: WatchdogKind): number {
    return this.overrides.get(kind) ?? DEFAULT_THRESHOLDS[kind]
  }

  /** 覆写某类阈值（测试/配置注入）。 */
  setThreshold(kind: WatchdogKind, ms: number): void {
    if (ms > 0) this.overrides.set(kind, ms)
  }

  /** arm 一个计时器（同 key 覆盖 = 活动信号刷新）。 */
  arm(arm: WatchdogArm): void {
    this.arms.set(arm.key, { ...arm, armed_at: this.clock() })
  }

  disarm(key: string): void {
    this.arms.delete(key)
  }

  /** 任务级故障映射（watchdog → 状态机 fault kind）。 */
  static faultFor(kind: WatchdogKind): FaultKind {
    switch (kind) {
      case 'commander':
        return 'crash' // commander 无推进不映射任务 fault，由插件层处理手动模式
      case 'task-idle':
        return 'idle_timeout'
      case 'task-wall-clock':
        return 'wall_clock'
    }
  }

  /** CR-01-4：挂起全部计时。 */
  pauseAll(): void {
    if (this.paused) return
    this.paused = true
    this.pausedAt = this.clock()
  }

  resumeAll(): void {
    if (!this.paused) return
    const now = this.clock()
    const pauseStartedAt = this.pausedAt ?? now
    const suspension = now - pauseStartedAt
    // 挂起时长顺延（挂起期间不消耗任务时间），按 arm 时刻区分顺延量（2026-09-03）：
    //   - pause 前 arm（armed_at < pause 开始）：整个挂起期间都在挂起 → 顺延 suspension；
    //   - 暂停中 arm（armed_at >= pause 开始）：暂停期间从 arm 到 resume 的时间也不应消耗
    //     预算 → 顺延 (now - armed_at)；顺延后 deadline = resume 时刻 + 完整阈值（重新获得
    //     完整预算）。旧实现统一顺延 suspension，暂停中 arm 被多顺延「arm 距 pause 开始」的
    //     偏移——resume 后卡住的任务晚杀最多整个挂起时长（用户 pause 可数小时，审批挂起可数天）。
    for (const [key, arm] of this.arms) {
      const armedAt = arm.armed_at ?? pauseStartedAt
      const shift = armedAt >= pauseStartedAt ? now - armedAt : suspension
      this.arms.set(key, { ...arm, deadline: arm.deadline + shift })
    }
    this.paused = false
    this.pausedAt = undefined
  }

  /** 到点触发（触发即解除，不重复）。 */
  tick(now: number): FiredWatchdog[] {
    if (this.paused) return []
    const fired: FiredWatchdog[] = []
    for (const [key, arm] of this.arms) {
      if (arm.deadline <= now) {
        fired.push({ key: arm.key, kind: arm.kind, mission_id: arm.mission_id, task_id: arm.task_id, deadline: arm.deadline })
        this.arms.delete(key)
      }
    }
    return fired.sort((a, b) => a.deadline - b.deadline)
  }
}
