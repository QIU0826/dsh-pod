/**
 * RemoteBackend —— 多机 satellite（方案书 594 行 + docs/satellite.md，v0.3 实现切片）。
 *
 * 不是新编排抽象：实现 WorkerBackend，把 start/kill/detect 经「卫星线协议」代理到一台
 * satellite worker（可能跑在别的机器）。本机 Pod 编排不变，只把某个 vendor 指向远程。
 *
 * 架构不变量保持：
 *   - satellite 收到的是任务执行请求（下拉 charter+task+worktree），而非状态迁移；
 *   - 本机状态机/审批/合并入口仍是唯一裁决者（satellite 不回传状态变更，只回传完成信号）；
 *   - 账本 usage 来自 satellite 回传（usage_audit 能力位诚实化 D7）。
 *
 * 线协议（JSON over HTTP，Bearer 共享密钥双向认证）：
 *   GET  /detect            -> { installed, authed, models, version, session_tiers }
 *   POST /start {slot,task,worktree} -> { session_ref, backend_vendor }
 *   GET  /events?session_ref=<id>     -> { events: WorkerProgressEvent[], completion: WorkerCompletion|null }
 *   POST /kill {session_ref}          -> { killed: true }
 *   POST /completion {session_ref}    -> { completion: WorkerCompletion }  (可选一次性拉取)
 */

import type {
  AgentSlot, Task, Vendor, WorkerBackend, WorkerCompletion, WorkerHandle, WorkerProgressEvent,
} from '../core/types.js'

/** 卫星线协议传输抽象（可注入测试 fake）；真实实现走 fetch（HttpSatelliteTransport）。 */
export interface SatelliteTransport {
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown>
}

/** fetch 实现（真实网络）。base 必带 scheme（http:// 或 https://）。 */
export class HttpSatelliteTransport implements SatelliteTransport {
  private readonly base: string
  private readonly token: string
  constructor(base: string, token = '') {
    this.base = base.replace(/\/$/, '')
    this.token = token
  }
  async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.token.length > 0) headers.authorization = 'Bearer ' + this.token
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error('satellite ' + path + ' -> HTTP ' + res.status + (text.length ? ': ' + text.slice(0, 200) : ''))
    }
    const text = await res.text()
    return text.length === 0 ? undefined : JSON.parse(text)
  }
}

export interface RemoteBackendOptions {
  /** 卫星基址（http://host:port）。 */
  url: string
  /** 代理的底层 vendor（卫星那侧跑的 worker 的 vendor）。 */
  vendor: Vendor
  /** 共享密钥（本机<->卫星双向认证；走 Authorization: Bearer）。 */
  token?: string
  /** 传输抽象（测试可注入 fake）。 */
  transport?: SatelliteTransport
  /** 进度轮询间隔（默认 500ms）。 */
  pollMs?: number
}

interface RemoteEventBatch {
  events?: WorkerProgressEvent[]
  completion: WorkerCompletion | null
}

/** 卫星事件轮询连续失败上限：超过即合成 failed completion 收口（防任务槽永久挂死）。 */
const REMOTE_POLL_MAX_FAILURES = 60

/** 卫星事件轮询结果：会话是否已完成。 */
interface PollResult {
  events: WorkerProgressEvent[]
  completion: WorkerCompletion | null
}

export class RemoteBackend implements WorkerBackend {
  readonly vendor: Vendor
  readonly protocol = {
    family: 'remote' as const,
    version: 'dsh-pod satellite wire v1',
    capabilities: { kill: true, session_persist: false, structured_output: true, usage_audit: true },
  }
  private readonly transport: SatelliteTransport
  private readonly pollMs: number
  /** 本地已 kill 的 session（kill 请求失败时轮询循环的退出依据）。 */
  private readonly killedSessions = new Set<string>()

  constructor(options: RemoteBackendOptions) {
    this.vendor = options.vendor
    this.transport = options.transport ?? new HttpSatelliteTransport(options.url, options.token)
    this.pollMs = options.pollMs ?? 500
  }

  async detect(): Promise<Awaited<ReturnType<WorkerBackend['detect']>>> {
    // 探测失败（网络/密钥）如实返回未安装，不 throw（上层据此灰掉名册，诚实化）。
    try {
      const raw = (await this.transport.request('GET', '/detect')) as Record<string, unknown>
      return {
        installed: raw.installed === true,
        authed: raw.authed === true,
        models: Array.isArray(raw.models) ? (raw.models as string[]) : [],
        ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
        session_tiers: (raw.session_tiers as 'transient'[]) ?? ['transient'],
        ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
      }
    } catch (error) {
      return {
        installed: false,
        authed: false,
        models: [],
        session_tiers: ['transient'],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async start(
    slot: AgentSlot,
    task: Task,
    worktree: string,
    callbacks: {
      onProgress?(event: WorkerProgressEvent): void
      onExit?(completion: WorkerCompletion): void
    } = {},
  ): Promise<WorkerHandle> {
    const raw = (await this.transport.request('POST', '/start', { slot, task, worktree })) as {
      session_ref?: string
      backend_vendor?: string
    }
    const sessionRef = raw.session_ref ?? 'remote-' + task.id
    const handle: WorkerHandle = { session_ref: sessionRef }

    // 异步轮询：卫星回传 progress 事件与最终 completion（进程语义等价，不阻塞 start 返回）。
    void this.pollUntilDone(handle, callbacks)

    return handle
  }

  private async pollUntilDone(
    handle: WorkerHandle,
    callbacks: { onProgress?(event: WorkerProgressEvent): void; onExit?(completion: WorkerCompletion): void },
  ): Promise<void> {
    let completion: WorkerCompletion | null = null
    // 游标增量（审计修复 #15）：不带 after 的全量轮询会把同一批进度事件每 pollMs
    // 重放一次（10min 任务 ≈ 每条事件重复投递上千次），本地事件洪峰挤出审计窗口
    let cursor = -1
    // 连续失败上限（2026-09-05）：卫星消失（重启清 session map / 下线）时 /events 恒 404，
    // 旧实现无限重试且 onExit 永不触发——编排器任务槽永久挂死，每次丢失任务泄漏一个
    // 不死的轮询循环。连续 REMOTE_POLL_MAX_FAILURES 次失败 → 合成 failed completion 收口。
    let consecutiveFailures = 0
    while (completion === null) {
      if (this.killedSessions.has(handle.session_ref ?? '')) {
        completion = {
          exit: 'failed',
          fault: 'crash',
          error_detail: 'remote task killed locally',
          usage: { tokens_in: 0, tokens_out: 0, source: 'measured' },
          artifacts: [],
        }
        break
      }
      let batch: PollResult
      try {
        const q = '/events?session_ref=' + encodeURIComponent(handle.session_ref ?? '') + (cursor >= 0 ? '&after=' + cursor : '')
        const raw = (await this.transport.request('GET', q)) as RemoteEventBatch & { next?: number }
        batch = { events: raw.events ?? [], completion: raw.completion ?? null }
        if (typeof raw.next === 'number') cursor = raw.next
        consecutiveFailures = 0
      } catch (error) {
        consecutiveFailures += 1
        if (consecutiveFailures >= REMOTE_POLL_MAX_FAILURES) {
          completion = {
            exit: 'failed',
            fault: 'crash',
            error_detail: `satellite unreachable after ${consecutiveFailures} consecutive polls: ${error instanceof Error ? error.message : String(error)}`,
            usage: { tokens_in: 0, tokens_out: 0, source: 'measured' },
            artifacts: [],
          }
          break
        }
        // 网络抖动：sleep 后重试，不误报完成
        await sleep(this.pollMs)
        continue
      }
      for (const event of batch.events) callbacks.onProgress?.(event)
      completion = batch.completion
      if (completion === null) await sleep(this.pollMs)
    }
    callbacks.onExit?.(completion)
  }

  async kill(handle: WorkerHandle): Promise<void> {
    // 本地标记先落（2026-09-05）：卫星不可达时 kill 请求本身会 reject，但轮询循环
    // 必须能自行退出，不得依赖卫星回执。
    this.killedSessions.add(handle.session_ref ?? '')
    await this.transport.request('POST', '/kill', { session_ref: handle.session_ref })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 便捷装配：从环境变量读取单台 satellite 配置（POD_SATELLITE_URL / POD_SATELLITE_VENDOR / POD_SATELLITE_TOKEN）。 */
export function remoteBackendsFromEnv(): Partial<Record<Vendor, WorkerBackend>> {
  const url = (process.env.POD_SATELLITE_URL ?? '').trim()
  if (url.length === 0) return {}
  const vendor = ((process.env.POD_SATELLITE_VENDOR ?? 'claude').trim()) as Vendor
  const token = (process.env.POD_SATELLITE_TOKEN ?? '').trim()
  return { [vendor]: new RemoteBackend({ url, vendor, token }) }
}
