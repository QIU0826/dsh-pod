/**
 * SatelliteServer —— 多机 satellite 的服务端（docs/satellite.md，v0.3 实现切片）。
 *
 * 跑在「卫星机」上的进程内 HTTP 端点：接收本机 RemoteBackend 的任务执行请求，
 * 委托给该机一个真实底层后端（claude/dsh/ark/stub），并把 progress 事件与完成信号
 * 缓冲供本机轮询拉取。本机仍是状态机唯一裁决者——这里不迁状态，只执行任务。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type {
  AgentSlot, Task, Vendor, WorkerBackend, WorkerCompletion, WorkerProgressEvent,
} from '../core/types.js'

export interface SatelliteSessionState {
  session_ref: string
  events: WorkerProgressEvent[]
  completion: WorkerCompletion | null
  killed: boolean
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
    req.on('data', (c: Buffer) => chunks.push(c))
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
    // 双向认证：设了 token 就要求 Bearer 一致
    if (token.length > 0) {
      const auth = (req.headers.authorization ?? '').trim()
      if (auth !== 'Bearer ' + token) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
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
      let body: { slot?: AgentSlot; task?: Task; worktree?: string; session_ref?: string } = {}
      try { body = (await readBody(req)) as typeof body } catch {
        res.writeHead(400); res.end(JSON.stringify({ error: 'invalid json' })); return
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
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ session_ref: sessionRef, backend_vendor: opts.backend.vendor, handle }))
        return
      }
      if (url.pathname === '/kill') {
        const sessionRef = body.session_ref ?? ''
        const state = sessions.get(sessionRef)
        if (state) {
          state.killed = true
          if (state.completion === null) {
            state.completion = { exit: 'killed', usage: { tokens_in: 0, tokens_out: 0, source: 'unavailable' }, artifacts: [] }
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ killed: true }))
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
  const server: Server = createServer((req, res) => void h.handle(req, res))
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
