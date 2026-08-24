import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { makePodRoutes, validateLaunch } from '../src/routes.js'
import type { PodService } from '../src/pod-service.js'

/** 手工构造响应捕获对象。 */
function captureResponse() {
  const written: Array<{ status: number; body: unknown }> = []
  const res = {
    writeHead: (status: number) => {
      written.push({ status, body: undefined })
      return res
    },
    end: (payload: string) => {
      written[written.length - 1]!.body = JSON.parse(payload)
    },
  } as unknown as ServerResponse
  return { res, written }
}

function loopbackRequest(url = '/'): IncomingMessage {
  return {
    url,
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage
}

function fakeService(over: Partial<PodService> = {}) {
  const service = {
    status: () => ({ mission: null, tasks: [], slots: [], pendingApprovals: [] }),
    eventsTail: () => [],
    launch: (input: unknown) => ({
      id: 'M-1',
      status: 'planning' as const,
      name: 'm',
      goal: 'g',
      budget_usd: 3,
      spent_tokens: 0,
      spent_equiv_usd: 0,
      approval_mode: 1,
      cwd: 'C:\\repo',
      worktree_policy: 'per-slot' as const,
      orchestration_mode: 'commander' as const,
      commander_healthy: true,
      created_at: 0,
      updated_at: 0,
      ...(input as object),
    }),
    ...over,
  }
  return service as unknown as PodService
}

describe('validateLaunch（Team Builder 提交校验）', () => {
  it('合法输入 → 默认预算 3、模型可空', () => {
    const result = validateLaunch({
      name: 'm',
      goal: 'g',
      cwd: 'C:\\repo',
      slots: [{ id: 'S-1', vendor: 'claude', role: 'implementer', capabilities: ['编码'] }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.budgetUsd).toBe(3)
    expect(result.value.slots[0]!.model).toBeUndefined()
  })

  it('缺 goal / 未知 vendor / 空 slots → 422 校验失败', () => {
    expect(validateLaunch({ name: 'm', cwd: 'x', slots: [] }).ok).toBe(false)
    expect(validateLaunch({ name: 'm', goal: 'g', cwd: 'x', slots: [{ id: 's', vendor: 'grok', role: 'r' }] }).ok).toBe(false)
    expect(validateLaunch({ name: 'm', goal: 'g', cwd: 'x' }).ok).toBe(false)
  })
})

describe('pod 数据面路由（W3/W4）', () => {
  it('GET /status → 快照 JSON（无 active mission 也 200）', async () => {
    const routes = makePodRoutes(() => fakeService())
    const status = routes.find((r) => r.path === '/api/dsh-pod/status')!
    const { res, written } = captureResponse()
    await status.handler(loopbackRequest('/api/dsh-pod/status'), res)
    expect(written[0]!.status).toBe(200)
    expect((written[0]!.body as { mission: unknown }).mission).toBeNull()
  })

  it('GET /events 透传 after 游标', async () => {
    const events = [
      { id: 'e1', ts: 100, kind: 'task_done', payload: {} },
      { id: 'e2', ts: 200, kind: 'approval_requested', payload: {} },
    ]
    const routes = makePodRoutes(() => fakeService({ eventsTail: (after: number) => events.filter((e) => e.ts > after) }))
    const eventsRoute = routes.find((r) => r.path === '/api/dsh-pod/events')!
    const { res, written } = captureResponse()
    await eventsRoute.handler(loopbackRequest('/api/dsh-pod/events?after=100'), res)
    const body = written[0]!.body as { events: Array<{ id: string }> }
    expect(body.events.map((e) => e.id)).toEqual(['e2'])
  })

  it('POST /launch 调 service.launch 并返回 mission id', async () => {
    const launched: unknown[] = []
    const service = fakeService({
      launch: (input) => {
        launched.push(input)
        return {
          id: 'M-9',
          status: 'planning',
          name: 'm',
          goal: 'g',
          budget_usd: 3,
          spent_tokens: 0,
          spent_equiv_usd: 0,
          approval_mode: 1,
          cwd: 'C:\\repo',
          worktree_policy: 'per-slot',
          orchestration_mode: 'commander',
          commander_healthy: true,
          created_at: 0,
          updated_at: 0,
        }
      },
    })
    const routes = makePodRoutes(() => service)
    const launchRoute = routes.find((r) => r.path === '/api/dsh-pod/launch')!
    const { res, written } = captureResponse()
    const req = {
      url: '/api/dsh-pod/launch',
      method: 'POST',
      socket: { remoteAddress: '127.0.0.1' },
      [Symbol.asyncIterator]() {
        const chunks = [Buffer.from(
          JSON.stringify({
            name: 'demo',
            goal: 'g',
            cwd: 'C:\\repo',
            slots: [{ id: 'S-1', vendor: 'codex', role: 'reviewer', capabilities: [] }],
          }),
        )]
        let index = 0
        return {
          next: () =>
            index < chunks.length
              ? Promise.resolve({ done: false, value: chunks[index++] })
              : Promise.resolve({ done: true, value: undefined }),
        }
      },
    } as unknown as IncomingMessage
    await launchRoute.handler(req, res)
    expect(written[0]!.status).toBe(200)
    expect((written[0]!.body as { mission_id: string }).mission_id).toBe('M-9')
    expect(launched).toHaveLength(1)
  })

  it('非 loopback → 403（launch 触发真实 LLM 成本，信任面收窄）', async () => {
    const routes = makePodRoutes(() => fakeService())
    const launchRoute = routes.find((r) => r.path === '/api/dsh-pod/launch')!
    const { res, written } = captureResponse()
    const req = {
      url: '/api/dsh-pod/launch',
      method: 'POST',
      socket: { remoteAddress: '192.168.1.5' },
    } as unknown as IncomingMessage
    await launchRoute.handler(req, res)
    expect(written[0]!.status).toBe(403)
  })

  it('运行时未初始化 → 503', async () => {
    const routes = makePodRoutes(() => undefined)
    const status = routes.find((r) => r.path === '/api/dsh-pod/status')!
    const { res, written } = captureResponse()
    await status.handler(loopbackRequest('/api/dsh-pod/status'), res)
    expect(written[0]!.status).toBe(503)
  })
})
