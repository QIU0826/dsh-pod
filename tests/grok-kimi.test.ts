/**
 * GrokBackend / KimiBackend —— OpenAI 兼容 native adapter（Berd-G）。
 * 契约按公开文档 + fake fetch 锁定（本机无 key，真机首验清单见各 backend 头注释）。
 */
import { describe, expect, it } from 'vitest'
import { GrokBackend } from '../src/workers/grok-backend.js'
import { KimiBackend } from '../src/workers/kimi-backend.js'
import type { OpenAiCompatBackend } from '../src/workers/openai-compat-backend.js'
import type { AgentSlot, Task } from '../src/core/types.js'

function makeSlot(vendor: string, model = ''): AgentSlot {
  return {
    id: 'S-1', mission_id: 'M-1', vendor, role: 'implementer', capabilities: ['编码'], model,
    effort: 'medium', session_tier: 'transient', status: 'idle', tokens_in: 0, tokens_out: 0, ctx_usage_pct: 0, window_tokens: 200_000,
  }
}

function makeTask(): Task {
  return {
    id: 'T-1', mission_id: 'M-1', title: 't', spec: 's', skill_tags: ['编码'], type: 'implement', depends_on: [], status: 'running',
    attempts: 0, soft_attempts: 0, max_wall_clock_ms: 3600_000, created_at: 1, updated_at: 1,
  }
}

function fakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => handler(String(url), (init ?? {}) as RequestInit)) as typeof fetch
}

const REPORT = JSON.stringify({
  task_id: 'T-1', task_type: 'implement', status: 'done', summary: 'ok', files_changed: ['src/x.ts'],
  test_result: 'not_run', decisions: [], blockers: [], questions: [],
})

/** 两个厂商共用一套断言（仅 baseUrl / 缺省模型 / vendor 名不同）。 */
const VENDORS: Array<{ name: string; baseUrl: string; model: string; make: (o: Record<string, unknown>) => OpenAiCompatBackend }> = [
  { name: 'grok', baseUrl: 'https://api.x.ai/v1', model: 'grok-3', make: (o) => new GrokBackend(o as never) },
  { name: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-128k', make: (o) => new KimiBackend(o as never) },
]

describe.each(VENDORS)('$name backend（OpenAI 兼容 native）', ({ name, baseUrl, model, make }) => {
  it('protocol：native family + 四能力位如实', () => {
    const b = make({ apiKey: 'k' })
    expect(b.vendor).toBe(name)
    expect(b.protocol.family).toBe('native')
    expect(b.protocol.capabilities).toEqual({ kill: false, session_persist: false, structured_output: true, usage_audit: true })
  })

  it('detect：命中约定 baseUrl + 缺省模型；200 → authed，401 → authed=false（含厂商名）', async () => {
    const ok = make({
      apiKey: 'k',
      fetchImpl: fakeFetch(async (url, init) => {
        expect(url).toBe(baseUrl + '/chat/completions')
        expect(JSON.parse(String(init.body)).model).toBe(model)
        return new Response(JSON.stringify({}), { status: 200 })
      }),
    })
    expect((await ok.detect()).authed).toBe(true)

    const bad = make({ apiKey: 'k', fetchImpl: fakeFetch(async () => new Response(JSON.stringify({}), { status: 401 })) })
    const badRes = await bad.detect()
    expect(badRes.authed).toBe(false)
    expect(badRes.error).toContain(name)
    expect(badRes.error).toContain('401')
  })

  it('start：200 + report + usage → done，usage 记 measured', async () => {
    const b = make({
      apiKey: 'k',
      fetchImpl: fakeFetch(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: REPORT } }], usage: { prompt_tokens: 11, completion_tokens: 22 } }), { status: 200 }),
      ),
    })
    const exit = await new Promise<Record<string, unknown>>((resolve) => {
      void b.start(makeSlot(name), makeTask(), 'C:/w', { onExit: resolve as never })
    })
    expect(exit.exit).toBe('done')
    expect((exit.report as { task_id?: string }).task_id).toBe('T-1')
    expect(exit.usage).toEqual({ tokens_in: 11, tokens_out: 22, source: 'measured' })
  })

  it('start：响应缺 usage → done 但 usage 标 unavailable（D7 诚实化）', async () => {
    const b = make({
      apiKey: 'k',
      fetchImpl: fakeFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: REPORT } }] }), { status: 200 })),
    })
    const exit = await new Promise<Record<string, unknown>>((resolve) => {
      void b.start(makeSlot(name), makeTask(), 'C:/w', { onExit: resolve as never })
    })
    expect(exit.exit).toBe('done')
    expect((exit.usage as { source?: string }).source).toBe('unavailable')
  })

  it('start：槽位 model 覆盖缺省模型', async () => {
    const b = make({
      apiKey: 'k',
      fetchImpl: fakeFetch(async (_url, init) => {
        expect(JSON.parse(String(init.body)).model).toBe('custom-model')
        return new Response(JSON.stringify({ choices: [{ message: { content: REPORT } }] }), { status: 200 })
      }),
    })
    await new Promise((resolve) => {
      void b.start(makeSlot(name, 'custom-model'), makeTask(), 'C:/w', { onExit: resolve as never })
    })
  })

  it('start：无 report → fault=mismatch', async () => {
    const b = make({
      apiKey: 'k',
      fetchImpl: fakeFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not a report' } }] }), { status: 200 })),
    })
    const exit = await new Promise<Record<string, unknown>>((resolve) => {
      void b.start(makeSlot(name), makeTask(), 'C:/w', { onExit: resolve as never })
    })
    expect(exit).toMatchObject({ exit: 'failed', fault: 'mismatch' })
  })

  it('start：HTTP 401 → failed，exit_code 透传', async () => {
    const b = make({ apiKey: 'bad', fetchImpl: fakeFetch(async () => new Response(JSON.stringify({ error: { message: 'auth' } }), { status: 401 })) })
    const exit = await new Promise<Record<string, unknown>>((resolve) => {
      void b.start(makeSlot(name), makeTask(), 'C:/w', { onExit: resolve as never })
    })
    expect(exit).toMatchObject({ exit: 'failed', exit_code: 401 })
  })

  it('start：fetch 抛异常 → fault=crash 且 error_detail 透传（不再吞错误）', async () => {
    const b = make({
      apiKey: 'k',
      fetchImpl: fakeFetch(async () => {
        throw new TypeError('network reset')
      }),
    })
    const exit = await new Promise<Record<string, unknown>>((resolve) => {
      void b.start(makeSlot(name), makeTask(), 'C:/w', { onExit: resolve as never })
    })
    expect(exit).toMatchObject({ exit: 'failed', fault: 'crash' })
    expect(String(exit.error_detail)).toContain('network reset')
  })

  it('complete()：裸调用返回文本；HTTP 失败 → ok=false', async () => {
    const ok = make({ apiKey: 'k', fetchImpl: fakeFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: '裸文本' } }] }), { status: 200 })) })
    expect(await ok.complete('hi')).toEqual({ text: '裸文本', ok: true })

    const bad = make({ apiKey: 'bad', fetchImpl: fakeFetch(async () => new Response(JSON.stringify({ error: { message: 'auth' } }), { status: 401 })) })
    const r = await bad.complete('hi')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('auth')
  })
})
