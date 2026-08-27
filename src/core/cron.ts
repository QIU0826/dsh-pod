/**
 * Cron 定时触发（AgentScope-J）—— docs/external-channels.md §2.2，v0.3 实现切片。
 *
 * 定时触发 mission / 巡检：把到期 job 的动作映射到 ChannelCommand（复用 external-channels
 * 工具面，即 pod_* 工具面的同一套），经 handleChannelCommand 执行。
 *
 * 纪律（对齐 docs/external-channels.md）：
 *   - 外部入口默认关闭（enabled=false），显式启用才开放（Berd-H）；
 *   - 与 Watchdog/maintenanceTick 共用节流纪律：同一 job 在 interval 内不重复触发（防抖），
 *     避免调度与 watchdog 双重触发；
 *   - 触发走同一审批门（approve/deny 类动作仍只经 pod_approve，不绕过状态机）。
 */

import type { ChannelCommand, ChannelTarget } from './channel.js'
import { handleChannelCommand } from './channel.js'

/** 一条定时任务：到期把 command 经 target 执行（命令即 ChannelCommand）。 */
export interface CronJob {
  id: string
  /** 触发周期（ms）。 */
  intervalMs: number
  /** 触发执行的命令（复用 channel 工具面）。 */
  command: ChannelCommand
  /** 默认关（Berd-H：外部入口显式启用才开放）。 */
  enabled: boolean
  /** 上次触发时刻（epoch ms）；节流判定基准。 */
  lastFiredAt?: number
  /** 可选标签（审计/展示）。 */
  label?: string
}

export interface CronSchedulerOptions {
  /** 假时钟注入（测试）。 */
  clock?: () => number
  /** 触发前的守卫：返回 false 则本次跳过（如 mission 正在跑不重复巡检）。 */
  gate?: (job: CronJob, now: number) => boolean
}

export interface CronFireResult {
  job_id: string
  fired: boolean
  reason: string
  reply_text?: string
  reply_ok?: boolean
  ts: number
}

/**
 * 简单 Cron 调度器：tick(now) 扫描到期 job 并触发。
 * 纯 tick 驱动（与 watchdog 同风格），不持有定时器；宿主周期调用（maintenanceTick 同源）。
 */
export class CronScheduler {
  private readonly jobs = new Map<string, CronJob>()
  private readonly clock: () => number
  private readonly gate: ((job: CronJob, now: number) => boolean) | undefined
  private readonly history: CronFireResult[] = []

  constructor(options: CronSchedulerOptions = {}) {
    this.clock = options.clock ?? (() => Date.now())
    this.gate = options.gate
  }

  register(job: CronJob): void {
    this.jobs.set(job.id, job)
  }

  unregister(id: string): void {
    this.jobs.delete(id)
  }

  list(): CronJob[] {
    return [...this.jobs.values()]
  }

  /** 最近触发历史（审计）。 */
  historyTail(limit = 20): CronFireResult[] {
    return this.history.slice(-limit)
  }

  /**
   * 周期巡检：触发所有到期且 enabled 的 job（节流：interval 内不重复）。
   * 返回本次触发结果。默认门：无 gate 时全部放行。
   */
  async tick(now?: number): Promise<CronFireResult[]> {
    const t = now ?? this.clock()
    const fired: CronFireResult[] = []
    for (const job of [...this.jobs.values()]) {
      if (!job.enabled) continue
      const last = job.lastFiredAt ?? 0
      if (t - last < job.intervalMs) continue
      if (this.gate !== undefined && !this.gate(job, t)) {
        this.history.push({ job_id: job.id, fired: false, reason: 'gated', ts: t })
        continue
      }
      // 触发前先更新 lastFiredAt（防重入/超时重跑造成重复触发）
      job.lastFiredAt = t
      try {
        const reply = await handleChannelCommand(this.target, job.command)
        const record: CronFireResult = {
          job_id: job.id, fired: true, reason: 'fired',
          reply_text: reply.text, reply_ok: reply.ok, ts: t,
        }
        this.history.push(record)
        fired.push(record)
      } catch (error) {
        const record: CronFireResult = {
          job_id: job.id, fired: false, reason: 'error: ' + (error instanceof Error ? error.message : String(error)), ts: t,
        }
        this.history.push(record)
        fired.push(record)
      }
    }
    return fired
  }

  /** target 注入（执行面；保持构造后可换，便于测试 fake）。 */
  private target: ChannelTarget = noopTarget

  setTarget(target: ChannelTarget): void {
    this.target = target
  }
}

/** 空 target（未注入时 tick 不执行任何动作，fail-closed）。 */
const noopTarget: ChannelTarget = {
  status: () => ({ mission: null, pendingApprovalIds: [] }),
  launch: () => ({ mission_id: '', status: '' }),
  approve: () => ({ ok: false, message: 'cron target not set' }),
  deny: () => undefined,
  steer: () => undefined,
  pause: () => undefined,
  resume: () => undefined,
  abort: () => undefined,
}
