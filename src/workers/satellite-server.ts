/**
 * SatelliteServer —— 多机 satellite 的服务端（docs/satellite.md，v0.3 实现切片）。
 *
 * 跑在「卫星机」上的进程内 HTTP 端点：接收本机 RemoteBackend 的任务执行请求，
 * 委托给该机一个真实底层后端（claude/dsh/ark/stub），并把 progress 事件与完成信号
 * 缓冲供本机轮询拉取。本机仍是状态机唯一裁决者——这里不迁状态，只执行任务。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { allowsJsonBody, bearerTokenEquals, hasAllowedLoopbackOrigin, isLocalHostHeader, isLoopbackBindHost } from '../core/http-guard.js'
import type {
  AgentSlot, Task, Vendor, WorkerBackend, WorkerCompletion, WorkerHandle, WorkerProgressEvent,
} from '../core/types.js'

const MAX_SATELLITE_BODY_BYTES = 1024 * 1024

class BodyTooLargeError extends Error {}

export interface SatelliteSessionState {
  session_ref: string
  events: WorkerProgressEvent[]
  completion: WorkerCompletion | null
  killed: boolean
  /** /start 返回的底层句柄：/kill 必须经它真正终止远程 worker 进程（P0 审计修复）。 */
  handle?: WorkerHandle
}

export interface SatelliteServerOptions {
  backend: WorkerBackend
  /** 共享密钥（Bearer 双向认证）。 */
  token?: string
  clock?: () => number
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > MAX_SATELLITE_BODY_BYTES) {
        // 立即拒绝但不 destroy 连接：后续 data 继续被本监听器消费（丢弃），
        // 既不缓冲（内存安全）也不回压死客户端（destroy 会让 fetch 直接断连拿不到 413）
        chunks.length = 0
        reject(new BodyTooLargeError('body exceeds 1MB limit'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw.length === 0 ? undefined : JSON.parse(raw))
      } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

export function createSatelliteHandler(opts: SatelliteServerOptions): {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  sessions: Map<string, SatelliteSessionState>
} {
  const token = (opts.token ?? '').trim()
  const sessions = new Map<string, SatelliteSessionState>()

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, satellite: 'dsh-pod' }))
      return
    }
    // 双向认证：设了 token 就要求 Bearer 一致（恒时比较）
    if (token.length > 0) {
      if (!bearerTokenEquals(token, req)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
    } else if (req.method === 'POST' && (!isLocalHostHeader(req) || !hasAllowedLoopbackOrigin(req))) {
      // P1：无 token（loopback 信任模式）的 POST 叠加浏览器侧防线（Host/Origin），
      // 堵 DNS rebinding 与跨站写；机器对机器的 RemoteBackend 本就直连本机名。
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'forbidden: non-local Host header or cross-origin request' }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/detect') {
      const d = await opts.backend.detect()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(d))
      return
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      const sessionRef = url.searchParams.get('session_ref') ?? ''
      const state = sessions.get(sessionRef)
      if (!state) { res.writeHead(404); res.end(JSON.stringify({ error: 'session not found' })); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ events: state.events, completion: state.completion }))
      return
    }
    if (req.method === 'POST') {
      // P1：带体 POST 强制 application/json（RemoteBackend 客户端已带；堵 text/plain 跨站面）
      if (!allowsJsonBody(req)) {
        res.writeHead(415, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'content-type must be application/json' }))
        return
      }
      let body: { slot?: AgentSlot; task?: Task; worktree?: string; session_ref?: string } = {}
      try {
        body = (await readBody(req)) as typeof body
      } catch (error) {
        const tooLarge = error instanceof BodyTooLargeError
        res.writeHead(tooLarge ? 413 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: tooLarge ? 'body too large (1MB limit)' : 'invalid json' }))
        return
      }
      if (url.pathname === '/start') {
        const slot = body.slot as AgentSlot
        const task = body.task as Task
        if (!slot || !task) { res.writeHead(400); res.end(JSON.stringify({ error: 'slot/task required' })); return }
        const sessionRef = 'sat-' + Date.now() + '-' + Math.floor(Math.random() * 1e6)
        const state: SatelliteSessionState = { session_ref: sessionRef, events: [], completion: null, killed: false }
        sessions.set(sessionRef, state)
        const handle = await opts.backend.start(slot, task, body.worktree ?? '', {
          onProgress: (ev) => {
            if (!state.killed) state.events.push(ev)
          },
          onExit: (completion) => {
            state.completion = completion
          },
        })
        state.handle = handle
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ session_ref: sessionRef, backend_vendor: opts.backend.vendor, handle }))
        return
      }
      if (url.pathname === '/kill') {
        const sessionRef = body.session_ref ?? ''
        const state = sessions.get(sessionRef)
        if (state) {
          state.killed = true
          // 真正终止远程 worker 进程：只置标记不杀进程会让任务继续烧 token（P0 审计修复）。
          // kill 失败不阻断响应（尽力而为清理），完成信号仍由 killed 标记兜底。
          if (state.handle !== undefined) {
            try {
              await opts.backend.kill(state.handle)
            } catch {
              // 底层 kill 抛错：保留 killed 状态，客户端以 200 + completion 为准
            }
          }
          if (state.completion === null) {
            state.completion = { exit: 'killed', usage: { tokens_in: 0, tokens_out: 0, source: 'unavailable' }, artifacts: [] }
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ killed: true, session_found: state !== undefined }))
        return
      }
    }
    res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }))
  }

  return { handle, sessions }
}

export interface StartedSatellite {
  url: string
  port: number
  close(): Promise<void>
  sessions: Map<string, SatelliteSessionState>
}

export async function listenSatellite(
  opts: SatelliteServerOptions & { host?: string; port?: number },
): Promise<StartedSatellite> {
  const h = createSatelliteHandler(opts)
  const host = opts.host ?? '127.0.0.1'
  // 库层 fail-closed（P1，与 MCP/Channel 同款纪律）：非 loopback 必须配 token——
  // /start 的 task spec 完全客户端可控，零鉴权暴露 = 卫星机任意指令执行面
  if (!isLoopbackBindHost(host) && (opts.token ?? '').trim().length === 0) {
    throw new Error('refusing to bind satellite on non-loopback host without token (set POD_SATELLITE_TOKEN)')
  }
  // async handler 的 rejection 若无人接 = unhandledRejection 炸掉整个卫星进程：
  // 统一兜底 500（headers 未发出时），失败细节不再带崩进程
  const server: Server = createServer((req, res) => {
    void h.handle(req, res).catch(() => {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'internal error' }))
        } else {
          res.end()
        }
      } catch {
        // 响应已不可写：放弃该连接
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : (opts.port ?? 0)
  return {
    url: 'http://' + host + ':' + port,
    port,
    sessions: h.sessions,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** 确定性桩后端：用于无真实 LLM 时验证 satellite 线协议（不发网络/不调模型）。 */
export class StubBackend implements WorkerBackend {
  readonly vendor: Vendor
  readonly protocol = {
    family: 'native' as const,
    version: 'stub',
    capabilities: { kill: true, session_persist: false, structured_output: true, usage_audit: true },
  }
  constructor(vendor: Vendor = 'dsh', private readonly delayMs = 20) { this.vendor = vendor }
  async detect() {
    return { installed: true, authed: true, models: ['stub-model'], session_tiers: ['transient' as const], version: 'stub' }
  }
  async start(
    slot: AgentSlot,
    task: Task,
    _worktree: string,
    callbacks: { onProgress?(event: WorkerProgressEvent): void; onExit?(completion: WorkerCompletion): void } = {},
  ): Promise<{ session_ref: string }> {
    const sessionRef = 'stub-' + task.id
    void (async () => {
      callbacks.onProgress?.({ slot_id: slot.id, task_id: task.id, ts: Date.now(), kind: 'text', text: 'stub running ' + task.id })
      await sleep(this.delayMs)
      callbacks.onProgress?.({ slot_id: slot.id, task_id: task.id, ts: Date.now(), kind: 'system', text: 'stub done' })
      callbacks.onExit?.({
        exit: 'done',
        usage: { tokens_in: 0, tokens_out: 0, source: 'unavailable' },
        artifacts: [],
        report: {
          task_id: task.id,
          task_type: task.type,
          status: 'done',
          summary: 'stub result for ' + task.id,
          files_changed: [],
          test_result: 'not_run',
          decisions: [],
          blockers: [],
          questions: [],
        },
      })
    })()
    return { session_ref: sessionRef }
  }
  async kill(): Promise<void> { /* 桩：无进程 */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
