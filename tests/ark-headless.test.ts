/**
 * ArkBackend —— 火山方舟 Agent Plan OpenAI 兼容后端（Berd-G adapter）。
 */
import { describe, expect, it } from 'vitest'
import { ArkBackend } from '../src/workers/ark-headless.js'
import type { AgentSlot, Task } from '../src/core/types.js'

function makeSlot(model = "deepseek-v4-flash"): AgentSlot {
  return {
    id: 'S-1', mission_id: 'M-1', vendor: 'ark', role: 'implementer', capabilities: ['编码'], model,
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
  return (async (url: string | URL | Request, init?: RequestInit) => {
    return handler(String(url), (init ?? {}) as RequestInit)
  }) as typeof fetch
}

describe("ArkBackend（火山方舟 Agent Plan）", () => {
  it("detect：key 有效 → authed，失败 → authed=false", async () => {
    const ok = new ArkBackend({ apiKey: "ark-x", fetchImpl: fakeFetch(async () => new Response(JSON.stringify({}), { status: 200 })) })
    const good = await ok.detect()
    expect(good.authed).toBe(true)
    const bad = new ArkBackend({ apiKey: "ark-x", fetchImpl: fakeFetch(async () => new Response(JSON.stringify({}), { status: 401 })) })
    const badRes = await bad.detect()
    expect(badRes.authed).toBe(false)
    expect(badRes.error).toContain("401")
  })

  it("start：HTTP 200 + 提取 report → onExit(done, report)", async () => {
    const reportText = "{\"task_id\":\"T-1\",\"task_type\":\"implement\",\"status\":\"done\",\"summary\":\"ok\",\"files_changed\":[\"src/x.ts\"],\"test_result\":\"not_run\",\"decisions\":[],\"blockers\":[],\"questions\":[]}"
    const backend = new ArkBackend({
      apiKey: "ark-x",
      fetchImpl: fakeFetch(async (_url, init) => {
        const body = JSON.parse(String(init.body))
        expect(body.model).toBe("deepseek-v4-flash")
        return new Response(JSON.stringify({ choices: [{ message: { content: reportText } }] }), { status: 200 })
      }),
    })
    const exit = await new Promise<unknown>((resolve) => {
      void backend.start(makeSlot(), makeTask(), "C:/w", { onExit: resolve })
    })
    expect(exit).toMatchObject({ exit: "done" })
    expect((exit as { report?: { task_id?: string } }).report?.task_id).toBe("T-1")
  })

  it("start：HTTP 401 → onExit(failed, usage unavailable 诚实化 D7)", async () => {
    const backend = new ArkBackend({
      apiKey: "ark-bad",
      fetchImpl: fakeFetch(async () => new Response(JSON.stringify({ error: { message: "auth" } }), { status: 401 })),
    })
    const exit = await new Promise<unknown>((resolve) => {
      void backend.start(makeSlot(), makeTask(), "C:/w", { onExit: resolve })
    })
    expect(exit).toMatchObject({ exit: "failed", exit_code: 401 })
    expect((exit as { usage?: { source?: string } }).usage?.source).toBe("unavailable")
  })

  it("start：无 report 提取 → fault=mismatch（fail-plausible 对策）", async () => {
    const backend = new ArkBackend({
      apiKey: "ark-x",
      fetchImpl: fakeFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: "not a report" } }] }), { status: 200 })),
    })
    const exit = await new Promise<unknown>((resolve) => {
      void backend.start(makeSlot(), makeTask(), "C:/w", { onExit: resolve })
    })
    expect(exit).toMatchObject({ exit: "failed", fault: "mismatch" })
  })

  it("start：fetch 抛异常 → fault=crash 且 error_detail 透传（诚实化 D7，不再吞错误）", async () => {
    const backend = new ArkBackend({
      apiKey: "ark-x",
      fetchImpl: fakeFetch(async () => { throw new TypeError("network reset") }),
    })
    const exit = await new Promise<unknown>((resolve) => {
      void backend.start(makeSlot(), makeTask(), "C:/w", { onExit: resolve })
    })
    expect(exit).toMatchObject({ exit: "failed", fault: "crash" })
    expect((exit as { error_detail?: string }).error_detail).toContain("network reset")
  })
})

  it("complete()：裸调用返回文本（评分/问答类，不要求 MISSION_REPORT）", async () => {
    const backend = new ArkBackend({
      apiKey: "ark-x",
      fetchImpl: fakeFetch(async (_url, init) => {
        const body = JSON.parse(String(init.body))
        expect(body.model).toBe("deepseek-v4-flash")
        return new Response(JSON.stringify({ choices: [{ message: { content: "这是裸文本" } }] }), { status: 200 })
      }),
    })
    const r = await backend.complete("hi")
    expect(r.ok).toBe(true)
    expect(r.text).toBe("这是裸文本")
  })

  it("complete()：HTTP 失败 → ok=false + error", async () => {
    const backend = new ArkBackend({
      apiKey: "ark-bad",
      fetchImpl: fakeFetch(async () => new Response(JSON.stringify({ error: { message: "auth" } }), { status: 401 })),
    })
    const r = await backend.complete("hi")
    expect(r.ok).toBe(false)
    expect(r.error).toContain("auth")
  })

