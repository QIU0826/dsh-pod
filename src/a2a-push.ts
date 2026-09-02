/**
 * A2A Push Notification 交付层（v1.0 §4.3，P2-3）。
 *
 * 客户端在 sendMessage/sendMessageStream 的 `configuration.pushNotificationConfig`
 * 里给出 webhook URL；任务更新时服务端主动 POST StreamResponse（单键 statusUpdate）。
 * 本模块是「注册 → 轮询事件 → 终态投递」的最小闭环：
 *   - 长任务不必挂 SSE 长连（mission 常跑百秒到千秒）；
 *   - cron 触发的任务完成后回调 IM 是天然场景（channel-im 已在）。
 *
 * 纪律（v1.0 规范 + 本项目 fail-closed）：
 *   - 投递体与流帧同构：`{ statusUpdate: TaskStatusUpdateEvent }`（StreamResponse 单键）；
 *   - 鉴权按 PushNotificationConfig：authentication → Authorization 头；token →
 *     X-A2A-Notification-Token（JS SDK 默认头名）；客户端必须校验（规范客户端职责）；
 *   - at-least-once：最多 2 次尝试（10s 超时 + 3s 重试间隔），全部失败仅 stderr 留痕
 *     ——回调是旁路，绝不影响编排主路径；
 *   - 客户端 2xx = 签收；终态投递完成后注册表自动清理；
 *   - mission 被替换（单 mission 运行时重新 launch）→ 旧 watcher 立即作废。
 */

import { internalEventToA2a, isFinalA2aEvent, buildPushHeaders } from './core/a2a.js'
import type { A2aPushConfig, A2aStreamEvent } from './core/a2a.js'

/** eventsAfter 的投影形状（mission_id 可选：终态归档 mission 的事件不混流，但类型如实）。 */
export interface A2aPushEvent {
  id: string
  ts: number
  kind: string
  mission_id?: string
  task_id?: string
  slot_id?: string
  payload: Record<string, unknown>
}

/** watcher 需要的 PodService 最小面（真实 PodService 满足；测试注入桩）。 */
export interface A2aPushServiceLike {
  /** 单 mission 事件读取（不做活跃过滤：mission 终态翻转与 mission_done 同步块内完成，
   *  按「活跃 mission」过滤的事件流永远读不到终态事件——push 的核心就是投递终态）。 */
  missionEventsAfter(
    missionId: string,
    afterTs: number,
    afterId?: string,
  ): A2aPushEvent[]
  /** mission 是否仍存在（被 deleteMission 级联删除 → watcher 作废）。 */
  missionExists(missionId: string): boolean
}

export interface A2aPushRegistryOptions {
  pollMs?: number
  timeoutMs?: number
  retryDelayMs?: number
  maxAttempts?: number
}

interface Registration {
  missionId: string
  config: A2aPushConfig
  lastId: string
  timer: ReturnType<typeof setInterval>
  done: boolean
  bornAt: number
}

export interface A2aPushRegistry {
  register(service: A2aPushServiceLike, missionId: string, config: A2aPushConfig): void
  stopAll(): void
  activeCount(): number
}

async function deliver(
  config: A2aPushConfig,
  update: A2aStreamEvent,
  timeoutMs: number,
  retryDelayMs: number,
  maxAttempts: number,
): Promise<void> {
  const headers = { 'content-type': 'application/json', ...buildPushHeaders(config) }
  const body = JSON.stringify({ statusUpdate: update })
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(config.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) })
      if (res.status >= 200 && res.status < 300) return
    } catch {
      /* 网络失败 / 超时 / 非 2xx：重试 */
    }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
  }
  // 至少一次投递承诺已尽力：如实留痕，不重试到天荒地老（回调是旁路不是主路径）
  console.error(`[a2a-push] webhook delivery failed after ${maxAttempts} attempts: ${config.url}`)
}

export function createA2aPushRegistry(opts: A2aPushRegistryOptions = {}): A2aPushRegistry {
  const pollMs = opts.pollMs ?? 1_000
  const timeoutMs = opts.timeoutMs ?? 10_000
  const retryDelayMs = opts.retryDelayMs ?? 3_000
  const maxAttempts = opts.maxAttempts ?? 2
  const watchers = new Map<string, Registration>()

  return {
    register(service, missionId, config) {
      // 同 mission 重复注册 → 旧 watcher 作废（客户端重发以最新配置为准）
      const prev = watchers.get(missionId)
      if (prev !== undefined) {
        prev.done = true
        clearInterval(prev.timer)
      }
      const reg: Registration = { missionId, config, lastId: '', timer: undefined as never, done: false, bornAt: Date.now() }
      const tick = async (): Promise<void> => {
        if (reg.done) return
        // mission 被级联删除（deleteMission）→ watcher 作废
        if (!service.missionExists(reg.missionId)) {
          reg.done = true
          clearInterval(reg.timer)
          watchers.delete(reg.missionId)
          return
        }
        try {
          const events = reg.lastId.length > 0 ? service.missionEventsAfter(reg.missionId, 0, reg.lastId) : service.missionEventsAfter(reg.missionId, 0)
          for (const event of events) {
            if (reg.done) return
            // 防御性归属过滤（missionEventsAfter 契约上只回本 mission 事件；异常混入不投递）
            if (event.mission_id !== undefined && event.mission_id !== reg.missionId) {
              reg.lastId = event.id
              continue
            }
            reg.lastId = event.id
            for (const mapped of internalEventToA2a(event as import('./core/types.js').PodEvent)) {
              if (reg.done) return
              if (!isFinalA2aEvent(mapped)) continue
              reg.done = true
              clearInterval(reg.timer)
              watchers.delete(reg.missionId)
              await deliver(reg.config, mapped, timeoutMs, retryDelayMs, maxAttempts)
              return
            }
          }
        } catch {
          /* 读取异常：保持注册，下轮重试 */
        }
        // 生命上限（24h）：mission 长期非终态（如 paused 无人恢复）时 watcher 不得永生
        if (Date.now() - reg.bornAt > 24 * 60 * 60 * 1000) {
          reg.done = true
          clearInterval(reg.timer)
          watchers.delete(reg.missionId)
        }
      }
      reg.timer = setInterval(() => {
        void tick()
      }, pollMs)
      watchers.set(missionId, reg)
    },
    stopAll() {
      for (const reg of watchers.values()) {
        reg.done = true
        clearInterval(reg.timer)
      }
      watchers.clear()
    },
    activeCount: () => watchers.size,
  }
}
