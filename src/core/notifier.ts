/**
 * Notifier —— 方案书 CR-01-10（v0.2 Should）：离线告警渠道。
 * watchdog 告警/审批卡/转人工/预算告警只进 Canvas 事件流，用户不在浏览器前无感知；
 * 本模块从事件流提取「需人工动作」信号并回调宿主（桌面通知 / 宿主日志）。
 *
 * 注入式副作用（clock + send 回调），纯逻辑可离线单测；按 kind+mission 去重窗口防刷屏。
 */

export type NotifyKind =
  | 'approval_pending'
  | 'task_escalated'
  | 'budget_short_circuit'
  | 'mission_paused'
  | 'stale_approval'

export interface Notification {
  kind: NotifyKind
  mission_id: string
  title: string
  detail: string
  ts: number
}

/** 从事件 kind 提取的告警映射（与 orchestrator 事件源一致）。 */
const EVENT_TO_NOTIFY: Record<string, NotifyKind | undefined> = {
  approval_requested: 'approval_pending',
  dispatch_awaiting_approval: 'approval_pending',
  task_escalated: 'task_escalated',
  budget_short_circuit: 'budget_short_circuit',
  mission_paused_budget: 'mission_paused',
}

export interface NotifierOptions {
  clock?: () => number
  /** 宿主送达回调（桌面通知/日志）。返回是否成功送达。 */
  send?: (n: Notification) => boolean | void
  /** 同 kind+mission 去重窗口（默认 5 分钟，防轮询刷屏）。 */
  dedupeMs?: number
}

export class Notifier {
  private readonly clock: () => number
  private readonly send: (n: Notification) => boolean | void
  private readonly dedupeMs: number
  private lastSent: Array<{ key: string; ts: number }> = []

  constructor(options: NotifierOptions = {}) {
    this.clock = options.clock ?? (() => Date.now())
    this.send = options.send ?? (() => {})
    this.dedupeMs = options.dedupeMs ?? 5 * 60 * 1000
  }

  /** 单条通知（注入回调直接送达）。 */
  emit(kind: NotifyKind, missionId: string, title: string, detail: string): boolean {
    const now = this.clock()
    if (this.isDup(kind, missionId, now)) return false
    this.lastSent.push({ key: kind + ":" + missionId, ts: now })
    const n: Notification = { kind, mission_id: missionId, title, detail, ts: now }
    return this.send(n) !== false
  }

  /**
   * 扫描事件流尾部：提取需人工动作的信号并送达（增量由调用方保证——
   * 只传新增事件；按 kind+mission 去重窗口防轮询刷屏）。返回本批实际送达数。
   */
  scanEvents(events: Array<{ kind: string; mission_id: string; task_id?: string }>): number {
    let delivered = 0
    for (const e of events) {
      const kind = EVENT_TO_NOTIFY[e.kind]
      if (kind === undefined) continue
      const title = NOTIFY_TITLE[kind]
      const detail = buildDetail(e.kind, e.mission_id, e.task_id)
      if (this.emit(kind, e.mission_id, title, detail)) delivered++
    }
    return delivered
  }

  private isDup(kind: NotifyKind, missionId: string, now: number): boolean {
    const key = kind + ":" + missionId
    this.lastSent = this.lastSent.filter((x) => now - x.ts < this.dedupeMs)
    return this.lastSent.some((x) => x.key === key)
  }
}

const NOTIFY_TITLE: Record<NotifyKind, string> = {
  approval_pending: 'Pod：审批卡待裁决',
  task_escalated: 'Pod：任务转人工接管',
  budget_short_circuit: 'Pod：预算熔断（未派发）',
  mission_paused: 'Pod：mission 已暂停（预算）',
  stale_approval: 'Pod：审批卡超期（自动暂停）',
}

function buildDetail(eKind: string, missionId: string, taskId: string | undefined): string {
  const task = taskId !== undefined ? "（任务 " + taskId + "）" : ""
  switch (eKind) {
    case 'approval_requested':
      return "mission " + missionId + " 有合并审批卡待批准/驳回" + task
    case 'dispatch_awaiting_approval':
      return "mission " + missionId + " 的派发确认门待放行" + task
    case 'task_escalated':
      return "mission " + missionId + " 任务 " + (taskId ?? "未知") + " 已转人工，需接管裁决"
    case 'budget_short_circuit':
      return "mission " + missionId + " 预算熔断，任务未派发" + task
    case 'mission_paused_budget':
      return "mission " + missionId + " 已因预算暂停"
    default:
      return "mission " + missionId + task
  }
}
