/**
 * A2A Push Notification 交付层（v1.0 §4.3，P2-3）端到端：
 * 真实本地 webhook server 收 POST —— 终态 StreamResponse 单键 statusUpdate + 鉴权头；
 * 覆盖：正常投递 / 非 2xx 重试后放弃 / mission 被替换即作废不误投 / 事件过滤（只认本 mission）。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createA2aPushRegistry } from '../src/a2a-push.js'
import type { A2aPushServiceLike } from '../src/a2a-push.js'
import type { PodEvent } from '../src/core/types.js'

const ev = (kind: string, missionId = 'M-1'): PodEvent => ({
  id: `ev-${kind}-${Math.random().toString(36).slice(2, 8)}`,
  mission_id: missionId,
  ts: 1_700_000_000_000,
  kind,
  payload: {},
})

/** 收 POST 的本地 webhook：记录请求，可按 path 配置返回状态码。 */
const received: Array<{ path: string; auth: string | undefined; token: string | undefined; body: unknown }> = []
let respondWith = 200
const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = ''
  req.on('data', (c: Buffer) => {
    raw += c.toString('utf8')
  })
  req.on('end', () => {
    received.push({
      path: req.url ?? '',
      auth: req.headers.authorization as string | undefined,
      token: req.headers['x-a2a-notification-token'] as string | undefined,
      body: raw.length > 0 ? JSON.parse(raw) : undefined,
    })
    res.statusCode = respondWith
    res.end()
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
const port = (server.address() as { port: number }).port

afterAll(() => {
  void server.close()
})

function serviceWithEvents(batches: PodEvent[][]): A2aPushServiceLike & { calls: number } {
  const state = { call: 0, calls: 0 }
  return {
    get calls() {
      return state.calls
    },
    missionEventsAfter() {
      const batch = batches[Math.min(state.call, batches.length - 1)] ?? []
      state.call++
      state.calls++
      return batch
    },
    missionExists() {
      return true
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 条件等待：全套并行争用下固定 sleep 会偶发不够（本项目 flaky 教训），轮询到条件成立或超时。 */
async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond() && Date.now() < deadline) await sleep(10)
  expect(cond()).toBe(true)
}

describe('A2A push notification（webhook 回调）', () => {
  it('终态事件 → POST StreamResponse 单键 statusUpdate（completed, final）+ token 头；投递后注册表清理', async () => {
    received.length = 0
    respondWith = 200
    const service = serviceWithEvents([[], [ev('mission_done')]])
    const registry = createA2aPushRegistry({ pollMs: 5 })
    registry.register(service, 'M-1', { url: `http://127.0.0.1:${port}/hook-a`, token: 'tok-1' })
    await waitFor(() => received.length >= 1)
    const hit = received[0]!
    expect(hit.path).toBe('/hook-a')
    expect(hit.token).toBe('tok-1')
    const body = hit.body as { statusUpdate: { status: { state: string }; final: boolean; taskId: string } }
    expect(body.statusUpdate.status.state).toBe('completed')
    // v1.0：final 是 TaskStatusUpdateEvent 顶层键，不在 status 内
    expect(body.statusUpdate.final).toBe(true)
    expect(body.statusUpdate.taskId).toBe('M-1')
    expect(registry.activeCount()).toBe(0)
    registry.stopAll()
  })

  it('authentication → Authorization 头（规范形态优先于 token 字段）', async () => {
    received.length = 0
    respondWith = 200
    const service = serviceWithEvents([[ev('mission_aborted')]])
    const registry = createA2aPushRegistry({ pollMs: 5 })
    registry.register(service, 'M-1', {
      url: `http://127.0.0.1:${port}/hook-b`,
      token: 'ignored',
      authentication: { scheme: 'Bearer', credentials: 'sekret' },
    })
    await waitFor(() => received.length >= 1)
    expect(received).toHaveLength(1)
    expect(received[0]!.auth).toBe('Bearer sekret')
    expect(received[0]!.token).toBeUndefined()
    expect((received[0]!.body as { statusUpdate: { status: { state: string } } }).statusUpdate.status.state).toBe('canceled')
    registry.stopAll()
  })

  it('非 2xx → 按 maxAttempts 重试后放弃（stderr 留痕），注册表仍清理（旁路不挂死）', async () => {
    received.length = 0
    respondWith = 500
    const service = serviceWithEvents([[ev('mission_done')]])
    const registry = createA2aPushRegistry({ pollMs: 5, maxAttempts: 2, retryDelayMs: 5 })
    registry.register(service, 'M-1', { url: `http://127.0.0.1:${port}/hook-c` })
    await waitFor(() => received.length >= 2)
    expect(received).toHaveLength(2) // 首投 + 1 次重试
    expect(registry.activeCount()).toBe(0)
    registry.stopAll()
  })

  it('mission 被删除（deleteMission）→ watcher 作废不投递；跨 mission 事件不投递（防御过滤）', async () => {
    received.length = 0
    respondWith = 200
    // 桩故意无视 missionId 返回 M-OTHER 的终态事件：watcher 的归属过滤必须拦下
    const service = serviceWithEvents([[ev('mission_done', 'M-OTHER')]])
    const registry = createA2aPushRegistry({ pollMs: 5 })
    registry.register({ ...service, missionExists: () => true }, 'M-1', { url: `http://127.0.0.1:${port}/hook-d` })
    await sleep(80)
    expect(received).toHaveLength(0) // 事件属 M-OTHER，M-1 watcher 不认
    registry.stopAll()

    // missionExists=false（级联删除）→ 下一 tick watcher 作废
    received.length = 0
    registry.register({ ...service, missionExists: () => false }, 'M-2', { url: `http://127.0.0.1:${port}/hook-d2` })
    await waitFor(() => registry.activeCount() === 0)
    expect(received).toHaveLength(0)
    registry.stopAll()
  })
})
