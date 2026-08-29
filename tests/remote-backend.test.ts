/**
 * remote-backend（多机 satellite）—— v0.3：RemoteBackend 代理到卫星 + 真实 loopback 卫星链。
 */
import { describe, expect, it } from 'vitest'
import {
  RemoteBackend,
  HttpSatelliteTransport,
  remoteBackendsFromEnv,
  type SatelliteTransport,
} from '../src/workers/remote-backend.js'
import { listenSatellite, StubBackend } from '../src/workers/satellite-server.js'
import type { AgentSlot, Task, WorkerBackend, WorkerCompletion, WorkerHandle, WorkerProgressEvent } from '../src/core/types.js'

function slot(): AgentSlot {
  return {
    id: 'S-1', mission_id: 'M-1', vendor: 'dsh', role: 'stub', capabilities: [],
    model: '', effort: 'medium', session_tier: 'transient', status: 'idle',
    tokens_in: 0, tokens_out: 0, ctx_usage_pct: 0, window_tokens: 100000,
  }
}
function task(id = 'T-1'): Task {
  return {
    id, mission_id: 'M-1', title: id, spec: 'spec', skill_tags: [], type: 'research',
    depends_on: [], status: 'ready', attempts: 0, soft_attempts: 0,
    max_wall_clock_ms: 60000, created_at: 0, updated_at: 0,
  }
}

/** 模拟卫星的 fake transport：start 返回 session_ref，随后 /events 先出进度再出完成。 */
class FakeSatelliteTransport implements SatelliteTransport {
  events: unknown[] = []
  completion: unknown | null = null
  calls: string[] = []
  killedSession: string | null = null
  constructor(public vendor = 'dsh') {}
  async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    this.calls.push(method + ' ' + path.split('?')[0])
    if (method === 'GET' && path.includes('/detect')) {
      return { installed: true, authed: true, models: ['m1'], version: 'v1', session_tiers: ['transient'] }
    }
    if (method === 'GET' && path.includes('/events')) {
      return { events: this.events, completion: this.completion }
    }
    if (method === 'POST' && path.includes('/start')) {
      return { session_ref: 'session-abc', backend_vendor: this.vendor }
    }
    if (method === 'POST' && path.includes('/kill')) {
      this.killedSession = (body as { session_ref?: string }).session_ref ?? null
      return { killed: true }
    }
    return {}
  }
}

describe('remote-backend（v0.3 多机 satellite 代理）', () => {
  it('protocol.family=remote，vendor=被代理 vendor，能力位如实', () => {
    const backend = new RemoteBackend({ url: 'http://127.0.0.1:1', vendor: 'claude' })
    expect(backend.vendor).toBe('claude')
    expect(backend.protocol.family).toBe('remote')
    expect(backend.protocol.capabilities.usage_audit).toBe(true)
    expect(backend.protocol.capabilities.kill).toBe(true)
  })

  it('detect：代理卫星 /detect 结果', async () => {
    const transport = new FakeSatelliteTransport()
    const backend = new RemoteBackend({ url: 'http://x', vendor: 'claude', transport })
    const d = await backend.detect()
    expect(d.installed).toBe(true)
    expect(d.authed).toBe(true)
    expect(d.models).toEqual(['m1'])
    expect(transport.calls).toContain('GET /detect')
  })

  it('start：代理 /start，轮询 /events，转发 progress，完成时 onExit', async () => {
    const transport = new FakeSatelliteTransport()
    transport.events = [
      { slot_id: 'S-1', task_id: 'T-1', ts: 1, kind: 'text', text: 'hi' },
    ]
    transport.completion = { exit: 'done', usage: { tokens_in: 10, tokens_out: 5, source: 'measured' }, artifacts: ['a'] }
    const backend = new RemoteBackend({ url: 'http://x', vendor: 'dsh', transport, pollMs: 5 })
    const progress: string[] = []
    let completion: WorkerCompletion | null = null
    let resolved = false
    const handle = await backend.start(slot(), task(), 'worktree', {
      onProgress: (ev) => progress.push(ev.text ?? ''),
      onExit: (c) => { completion = c; resolved = true },
    })
    expect(handle.session_ref).toBe('session-abc')
    // 等轮询完成（给足时间）
    while (!resolved) await new Promise((r) => setTimeout(r, 5))
    expect(completion).toBeTruthy()
    const c = completion!
    expect(progress).toContain('hi')
    expect(c.exit).toBe('done')
    expect(c.usage.tokens_in).toBe(10)
    expect(transport.calls).toContain('GET /events')
  })

  it('kill：代理 /kill 到卫星', async () => {
    const transport = new FakeSatelliteTransport()
    const backend = new RemoteBackend({ url: 'http://x', vendor: 'dsh', transport })
    await backend.kill({ session_ref: 'session-abc' })
    expect(transport.killedSession).toBe('session-abc')
  })

  it('远程不可达：detect 如实返回未安装（不 throw）', async () => {
    const backend = new RemoteBackend({ url: 'http://127.0.0.1:1', vendor: 'claude', pollMs: 1 })
    const d = await backend.detect()
    expect(d.installed).toBe(false)
    expect(typeof d.error).toBe('string')
  })

  it('remoteBackendsFromEnv：POD_SATELLITE_URL 缺失 -> 空；存在 -> 构造对应 vendor', () => {
    const oldUrl = process.env.POD_SATELLITE_URL
    const oldVendor = process.env.POD_SATELLITE_VENDOR
    delete process.env.POD_SATELLITE_URL
    delete process.env.POD_SATELLITE_VENDOR
    expect(Object.keys(remoteBackendsFromEnv())).toEqual([])
    process.env.POD_SATELLITE_URL = 'http://127.0.0.1:3950'
    process.env.POD_SATELLITE_VENDOR = 'codex'
    const b = remoteBackendsFromEnv()
    expect(Object.keys(b)).toEqual(['codex'])
    expect(b.codex!.protocol.family).toBe('remote')
    if (oldUrl === undefined) delete process.env.POD_SATELLITE_URL
    if (oldVendor === undefined) delete process.env.POD_SATELLITE_VENDOR
  })
})

describe('satellite-server 真实 loopback 链（RemoteBackend <-> HTTP <-> stub 后端）', () => {
  it('detect + health + start + 进度 + 完成 全链路（stub 后端，经真实 fetch）', async () => {
    const satellite = await listenSatellite({ backend: new StubBackend('dsh', 15) })
    try {
      const transport = new HttpSatelliteTransport(satellite.url)
      const remote = new RemoteBackend({ url: satellite.url, vendor: 'dsh', transport, pollMs: 10 })
      const d = await remote.detect()
      expect(d.installed).toBe(true)
      const health = await fetch(satellite.url + '/health')
      expect(health.status).toBe(200)
      let completion: WorkerCompletion | null = null
      let resolved = false
      const seen: string[] = []
      const handle = await remote.start(slot(), task(), 'worktree', {
        onProgress: (ev) => seen.push(ev.text ?? ''),
        onExit: (c) => { completion = c; resolved = true },
      })
      expect(handle.session_ref).toBeTruthy()
      while (!resolved) await new Promise((r) => setTimeout(r, 10))
      expect(completion).toBeTruthy()
      const c = completion!
      expect(c.exit).toBe('done')
      expect(seen.some((t) => t.startsWith('stub'))).toBe(true)
    } finally {
      await satellite.close()
    }
  })

  it('卫星鉴权：设 token 后无 token 请求 -> 401，正确 Bearer 可访问', async () => {
    const satellite = await listenSatellite({ backend: new StubBackend('dsh'), token: 'secret' })
    try {
      const noAuth = await fetch(satellite.url + '/detect')
      expect(noAuth.status).toBe(401)
      const remote = new RemoteBackend({ url: satellite.url, vendor: 'dsh', token: 'secret', pollMs: 5 })
      const d = await remote.detect()
      expect(d.installed).toBe(true)
    } finally {
      await satellite.close()
    }
  })
})

describe('satellite 服务端 /kill 真杀（P0：此前只置标记，远程 worker 继续烧 token）', () => {
  class KillSpyBackend implements WorkerBackend {
    readonly vendor = 'dsh' as const
    readonly protocol = {
      family: 'native' as const,
      version: 'stub',
      capabilities: { kill: true, session_persist: false, structured_output: true, usage_audit: true },
    }
    readonly killed: WorkerHandle[] = []
    async detect() {
      return { installed: true, authed: true, models: ['m'], session_tiers: ['transient'] as Array<'transient'> }
    }
    async start(
      _slot: AgentSlot,
      task: Task,
      _worktree: string,
      callbacks: { onProgress?(event: WorkerProgressEvent): void; onExit?(completion: WorkerCompletion): void } = {},
    ): Promise<WorkerHandle> {
      queueMicrotask(() =>
        callbacks.onExit?.({ exit: 'done', usage: { tokens_in: 0, tokens_out: 0, source: 'unavailable' }, artifacts: [] }),
      )
      return { pid: 4321, session_ref: `spy-${task.id}` }
    }
    async kill(handle: WorkerHandle): Promise<void> {
      this.killed.push(handle)
    }
  }

  it('/start 存 handle；/kill 经 backend.kill 真正终止远程进程', async () => {
    const backend = new KillSpyBackend()
    const satellite = await listenSatellite({ backend, port: 0 })
    try {
      const startRes = await fetch(satellite.url + '/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slot: slot(), task: task() }),
      })
      const startBody = (await startRes.json()) as { session_ref: string }
      expect(startRes.status).toBe(200)
      const killRes = await fetch(satellite.url + '/kill', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_ref: startBody.session_ref }),
      })
      const killBody = (await killRes.json()) as { killed: boolean; session_found: boolean }
      expect(killBody).toEqual({ killed: true, session_found: true })
      expect(backend.killed).toHaveLength(1)
      expect(backend.killed[0]!.pid).toBe(4321)
    } finally {
      await satellite.close()
    }
  })

  it('/kill 不存在的 session → 200 + session_found=false（不再静默装作杀掉了）', async () => {
    const backend = new KillSpyBackend()
    const satellite = await listenSatellite({ backend, port: 0 })
    try {
      const res = await fetch(satellite.url + '/kill', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_ref: 'nope' }),
      })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { session_found: boolean }).session_found).toBe(false)
      expect(backend.killed).toHaveLength(0)
    } finally {
      await satellite.close()
    }
  })
})

describe('satellite P1 加固（fail-closed + content-type + 请求体上限）', () => {
  it('listenSatellite：非 loopback 无 token → 拒绝启动（fail-closed）', async () => {
    await expect(listenSatellite({ backend: new StubBackend(), host: '0.0.0.0', port: 0 })).rejects.toThrow(/without token/)
    // loopback 无 token / 非 loopback 带 token 均合法
    const a = await listenSatellite({ backend: new StubBackend(), host: '127.0.0.1', port: 0 })
    await a.close()
    const b = await listenSatellite({ backend: new StubBackend(), host: '0.0.0.0', port: 0, token: 't' })
    await b.close()
  })

  it('POST 非 application/json → 415；超 1MB body → 413', async () => {
    const satellite = await listenSatellite({ backend: new StubBackend(), port: 0 })
    try {
      const wrongCt = await fetch(satellite.url + '/kill', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'x',
      })
      expect(wrongCt.status).toBe(415)
      const huge = await fetch(satellite.url + '/kill', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(2 * 1024 * 1024),
      })
      expect(huge.status).toBe(413)
    } finally {
      await satellite.close()
    }
  })
})
