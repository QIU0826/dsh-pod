import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { makePodRoutes, validateLaunch, formatSseFrame } from '../src/routes.js'
import type { PodService } from '../src/pod-service.js'
import type { ApprovalRule } from '../src/core/types.js'
import { NotFoundError } from '../src/core/errors.js'

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
    eventsTail: () => ({ events: [], cursor: '', has_more: false }),
    ledgerTail: () => ({ total_tokens: 0, total_equiv_usd: 0, entries: [], by_stage: {} }),
    isDemo: () => false,
    pauseMission: () => undefined,
    resumeMission: () => undefined,
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

  it('预算语义（token 主计价）：显式 0 = 不限（事实无限）；缺省仍 $3 安全兜底；avatar 白名单透传', () => {
    const unlimited = validateLaunch({
      name: 'm', goal: 'g', cwd: 'x', budget_usd: 0,
      slots: [{ id: 'S-1', vendor: 'claude', role: 'planner', capabilities: ['规划'], avatar: 'owl' }],
    })
    expect(unlimited.ok).toBe(true)
    if (!unlimited.ok) return
    expect(unlimited.value.budgetUsd).toBe(1_000_000_000)
    expect(unlimited.value.slots[0]!.avatar).toBe('owl')
    const tokens = validateLaunch({
      name: 'm', goal: 'g', cwd: 'x', budget_usd: 0, budget_tokens: 2_000_000,
      slots: [{ id: 'S-1', vendor: 'claude', role: 'r', avatar: 'griffin' }],
    })
    expect(tokens.ok).toBe(true)
    if (!tokens.ok) return
    expect(tokens.value.budgetTokens).toBe(2_000_000)
    expect(tokens.value.slots[0]!.avatar).toBeUndefined()
    const fallback = validateLaunch({ name: 'm', goal: 'g', cwd: 'x', slots: [{ id: 's', vendor: 'claude', role: 'r' }] })
    expect(fallback.ok).toBe(true)
    if (!fallback.ok) return
    expect(fallback.value.budgetUsd).toBe(3)
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
    const routes = makePodRoutes(() => fakeService({
      eventsTail: (after: number) => ({ events: events.filter((e) => e.ts > after), cursor: '', has_more: false }),
    }))
    const eventsRoute = routes.find((r) => r.path === '/api/dsh-pod/events')!
    const { res, written } = captureResponse()
    await eventsRoute.handler(loopbackRequest('/api/dsh-pod/events?after=100'), res)
    const body = written[0]!.body as { events: Array<{ id: string }> }
    expect(body.events.map((e) => e.id)).toEqual(['e2'])
  })

  it('formatSseFrame：SSE 帧格式（event: + data: + 空行）', () => {
    const frame = formatSseFrame({ id: 'e1', ts: 100, kind: 'task_done', payload: { a: 1 } })
    expect(frame).toContain('event: task_done')
    expect(frame).toContain('data: {"id":"e1","ts":100,"kind":"task_done","payload":{"a":1}}')
    expect(frame.endsWith('\n\n')).toBe(true)
  })

  it('GET /events/stream：新订阅先收 buffered history（SSE replay，AgentScope-I/EV-2）', async () => {
    const history = [
      { id: 'e1', ts: 100, kind: 'task_dispatched', payload: {} },
      { id: 'e2', ts: 200, kind: 'worker_progress', payload: {} },
    ]
    const service = fakeService({ eventsAfter: (after: number) => history.filter((e) => e.ts > after) })
    const routes = makePodRoutes(() => service)
    const streamRoute = routes.find((r) => r.path === '/api/dsh-pod/events/stream')!
    // 捕获流式 write 输出（不结束连接）
    const writtenChunks: string[] = []
    const res = {
      writeHead: () => res,
      write: (chunk: string) => {
        writtenChunks.push(String(chunk))
        return true
      },
      end: () => res,
      writableEnded: false,
      on: () => res,
    } as unknown as ServerResponse
    const req = {
      url: '/api/dsh-pod/events/stream',
      method: 'GET',
      socket: { remoteAddress: '127.0.0.1' },
      on: () => req,
    } as unknown as IncomingMessage
    await streamRoute.handler(req, res)
    const output = writtenChunks.join('')
    // replay：两条 history 事件都在（顺序保留）
    expect(output).toContain('data: {"id":"e1"')
    expect(output).toContain('data: {"id":"e2"')
    expect(output.indexOf('e1')).toBeLessThan(output.indexOf('e2'))
    expect(output.startsWith('retry:')).toBe(true)
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

  it('POST /approve 携带 edited 参数（AS-3：编辑参数后放行）', async () => {
    const approved: Array<{ id: string; edited?: Record<string, string> }> = []
    const service = fakeService({
      approve: (approvalId: string, _by: string, edited?: Record<string, string>) => {
        approved.push({ id: approvalId, edited })
        return Promise.resolve({ ok: true, mergeCommit: 'abc12345' })
      },
    })
    const routes = makePodRoutes(() => service)
    const approveRoute = routes.find((r) => r.path === '/api/dsh-pod/approve')!
    const { res, written } = captureResponse()
    const req = {
      url: '/api/dsh-pod/approve',
      method: 'POST',
      socket: { remoteAddress: '127.0.0.1' },
      [Symbol.asyncIterator]() {
        const chunks = [Buffer.from(JSON.stringify({ approval_id: 'A-1', edited: { merge_note: '评审确认' } }))]
        let index = 0
        return {
          next: () =>
            index < chunks.length
              ? Promise.resolve({ done: false, value: chunks[index++] })
              : Promise.resolve({ done: true, value: undefined }),
        }
      },
    } as unknown as IncomingMessage
    await approveRoute.handler(req, res)
    expect(written[0]!.status).toBe(200)
    expect(approved).toEqual([{ id: 'A-1', edited: { merge_note: '评审确认' } }])
  })

  it('POST /approve 编辑参数只保留字符串键值（过滤非字符串，防注入）', async () => {
    const approved: Array<{ id: string; edited?: Record<string, string> }> = []
    const service = fakeService({
      approve: (approvalId: string, _by: string, edited?: Record<string, string>) => {
        approved.push({ id: approvalId, edited })
        return Promise.resolve({ ok: true, mergeCommit: 'abc12345' })
      },
    })
    const routes = makePodRoutes(() => service)
    const approveRoute = routes.find((r) => r.path === '/api/dsh-pod/approve')!
    const { res } = captureResponse()
    const req = {
      url: '/api/dsh-pod/approve',
      method: 'POST',
      socket: { remoteAddress: '127.0.0.1' },
      [Symbol.asyncIterator]() {
        const chunks = [Buffer.from(JSON.stringify({ approval_id: 'A-2', edited: { merge_note: 'ok', evil: 123, arr: [1] } }))]
        let index = 0
        return {
          next: () =>
            index < chunks.length
              ? Promise.resolve({ done: false, value: chunks[index++] })
              : Promise.resolve({ done: true, value: undefined }),
        }
      },
    } as unknown as IncomingMessage
    await approveRoute.handler(req, res)
    expect(approved).toEqual([{ id: 'A-2', edited: { merge_note: 'ok' } }])
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

describe('POST /api/dsh-pod/plan（P1 规划层：list / add / replan）', () => {
  it('action=list 返回任务 DAG 与重规划余量', async () => {
    const service = fakeService({
      status: () => ({ tasks: [] as never[], slots: [], pendingApprovals: [], experiments: { topology_animation: false, canvas_third_column: false } }),
      hasPlannerCapability: () => true,
      replanRemaining: () => 1,
    })
    const routes = makePodRoutes(() => service as unknown as PodService)
    const route = routes.find((r) => r.path === '/api/dsh-pod/plan')!
    const { res, written } = captureResponse()
    const req = {
      url: '/api/dsh-pod/plan',
      method: 'POST',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'content-type': 'application/json', 'content-length': '22' },
      [Symbol.asyncIterator]() {
        const chunks = [Buffer.from(JSON.stringify({ action: 'list' }))]
        let i = 0
        return { next: () => (i < chunks.length ? Promise.resolve({ done: false, value: chunks[i++] }) : Promise.resolve({ done: true, value: undefined })) }
      },
    } as unknown as IncomingMessage
    await route.handler(req, res)
    expect(written[0]!.status).toBe(200)
    expect((written[0]!.body as { planner: boolean }).planner).toBe(true)
    expect((written[0]!.body as { replan_remaining: number }).replan_remaining).toBe(1)
  })

  it('action=add 任务缺字段 → 422', async () => {
    const service = fakeService()
    const routes = makePodRoutes(() => service as unknown as PodService)
    const route = routes.find((r) => r.path === '/api/dsh-pod/plan')!
    const { res, written } = captureResponse()
    const req = {
      url: '/api/dsh-pod/plan',
      method: 'POST',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'content-type': 'application/json', 'content-length': '40' },
      [Symbol.asyncIterator]() {
        const chunks = [Buffer.from(JSON.stringify({ action: 'add', tasks: [{ id: 'T-1' }] }))]
        let i = 0
        return { next: () => (i < chunks.length ? Promise.resolve({ done: false, value: chunks[i++] }) : Promise.resolve({ done: true, value: undefined })) }
      },
    } as unknown as IncomingMessage
    await route.handler(req, res)
    expect(written[0]!.status).toBe(422)
  })
})

describe('GET /api/dsh-pod/fs/browse（设置页目录点选器）', () => {
  it('空 path → 根级（盘符 / POSIX 根），200', async () => {
    const routes = makePodRoutes(() => fakeService())
    const route = routes.find((r) => r.path === '/api/dsh-pod/fs/browse')!
    const { res, written } = captureResponse()
    await route.handler(loopbackRequest('/api/dsh-pod/fs/browse'), res)
    expect(written[0]!.status).toBe(200)
    const body = written[0]!.body as { path: string; home: string }
    expect(typeof body.home).toBe('string')
    if (process.platform === 'win32') expect(body.path).toBe('')
    else expect(body.path).toBe('/')
  })

  it('非法 path（相对路径）→ 400', async () => {
    const routes = makePodRoutes(() => fakeService())
    const route = routes.find((r) => r.path === '/api/dsh-pod/fs/browse')!
    const { res, written } = captureResponse()
    await route.handler(loopbackRequest('/api/dsh-pod/fs/browse?path=relative'), res)
    expect(written[0]!.status).toBe(400)
  })

  it('非 GET → 405；非 loopback → 403', async () => {
    const routes = makePodRoutes(() => fakeService())
    const route = routes.find((r) => r.path === '/api/dsh-pod/fs/browse')!
    const methodRes = captureResponse()
    await route.handler({ ...loopbackRequest('/api/dsh-pod/fs/browse'), method: 'POST' } as IncomingMessage, methodRes.res)
    expect(methodRes.written[0]!.status).toBe(405)
    const remoteRes = captureResponse()
    await route.handler({ url: '/', socket: { remoteAddress: '10.0.0.5' } } as unknown as IncomingMessage, remoteRes.res)
    expect(remoteRes.written[0]!.status).toBe(403)
  })
})

describe('/api/dsh-pod/rules（审批规则：列 / 记 / 撤）', () => {
  /** 内存规则表；deleteRule 对缺失 id 抛 NotFoundError（与 JsonStore/SqliteStore 行为一致）。 */
  function harness() {
    const rules = new Map<string, ApprovalRule>([
      ['R-1', { id: 'R-1', tool: 'Bash', decision: 'allow', scope: 'global', ts: 1 }],
      ['R-2', { id: 'R-2', tool: 'Write', decision: 'ask', scope: 'mission', ts: 2 }],
    ])
    const service = fakeService({
      listRules: () => [...rules.values()],
      deleteRule: (id: string) => {
        if (!rules.has(id)) throw new NotFoundError('rule', id)
        rules.delete(id)
      },
    })
    const route = makePodRoutes(() => service).find((r) => r.path === '/api/dsh-pod/rules')!
    return { rules, route }
  }

  it('GET → 返回规则列表', async () => {
    const { route } = harness()
    const { res, written } = captureResponse()
    await route.handler(loopbackRequest('/api/dsh-pod/rules'), res)
    expect(written[0]!.status).toBe(200)
    expect((written[0]!.body as { rules: Array<{ id: string }> }).rules.map((r) => r.id)).toEqual(['R-1', 'R-2'])
  })

  it('DELETE 存在的规则 → 200 且规则确实被移除（此前只有 GET/POST，规则只增不减）', async () => {
    const { rules, route } = harness()
    const { res, written } = captureResponse()
    await route.handler({ url: '/api/dsh-pod/rules?id=R-1', method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage, res)
    expect(written[0]!.status).toBe(200)
    expect([...rules.keys()]).toEqual(['R-2'])
  })

  it('DELETE 不存在的 id → 404（幂等破坏显式暴露，不静默成功）', async () => {
    const { rules, route } = harness()
    const { res, written } = captureResponse()
    await route.handler({ url: '/api/dsh-pod/rules?id=nope', method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage, res)
    expect(written[0]!.status).toBe(404)
    expect(rules.size).toBe(2)
  })

  it('DELETE 缺 id → 422 校验失败', async () => {
    const { rules, route } = harness()
    const { res, written } = captureResponse()
    await route.handler({ url: '/api/dsh-pod/rules', method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage, res)
    expect(written[0]!.status).toBe(422)
    expect(rules.size).toBe(2)
  })

  it('DELETE 非 loopback → 403（信任面与 GET/POST 同源）', async () => {
    const { rules, route } = harness()
    const { res, written } = captureResponse()
    await route.handler({ url: '/api/dsh-pod/rules?id=R-1', method: 'DELETE', socket: { remoteAddress: '10.0.0.5' } } as unknown as IncomingMessage, res)
    expect(written[0]!.status).toBe(403)
    expect(rules.size).toBe(2)
  })
})

describe('POST /api/dsh-pod/pause 与 /resume（暂停/恢复接线到 UI）', () => {
  const routeOf = (path: string) =>
    makePodRoutes(() => fakeService()).find((r) => r.path === path)!

  function request(path: string, method = 'POST', remoteAddress = '127.0.0.1'): IncomingMessage {
    return { url: path, method, socket: { remoteAddress } } as unknown as IncomingMessage
  }

  it('pause → 200 且调用 service.pauseMission', async () => {
    const paused = vi.fn()
    const routes = makePodRoutes(() => fakeService({ pauseMission: paused }))
    const route = routes.find((r) => r.path === '/api/dsh-pod/pause')!
    const { res, written } = captureResponse()
    await route.handler(request('/api/dsh-pod/pause'), res)
    expect(written[0]!.status).toBe(200)
    expect(paused).toHaveBeenCalledTimes(1)
  })

  it('resume → 200 且调用 service.resumeMission', async () => {
    const resumed = vi.fn()
    const routes = makePodRoutes(() => fakeService({ resumeMission: resumed }))
    const route = routes.find((r) => r.path === '/api/dsh-pod/resume')!
    const { res, written } = captureResponse()
    await route.handler(request('/api/dsh-pod/resume'), res)
    expect(written[0]!.status).toBe(200)
    expect(resumed).toHaveBeenCalledTimes(1)
  })

  it('非 POST → 405', async () => {
    for (const path of ['/api/dsh-pod/pause', '/api/dsh-pod/resume']) {
      const { res, written } = captureResponse()
      await routeOf(path).handler(request(path, 'GET'), res)
      expect(written[0]!.status).toBe(405)
    }
  })

  it('非 loopback → 403（与其余数据面同源）', async () => {
    for (const path of ['/api/dsh-pod/pause', '/api/dsh-pod/resume']) {
      const { res, written } = captureResponse()
      await routeOf(path).handler(request(path, 'POST', '10.0.0.5'), res)
      expect(written[0]!.status).toBe(403)
    }
  })

  it('非法状态迁移 → 409（不静默成功）', async () => {
    const routes = makePodRoutes(() => fakeService({
      pauseMission: () => { throw new Error('INVALID_TRANSITION: paused -> paused') },
    }))
    const route = routes.find((r) => r.path === '/api/dsh-pod/pause')!
    const { res, written } = captureResponse()
    await route.handler(request('/api/dsh-pod/pause'), res)
    expect(written[0]!.status).toBe(409)
    expect(String((written[0]!.body as { error: string }).error)).toContain('INVALID_TRANSITION')
  })
})
