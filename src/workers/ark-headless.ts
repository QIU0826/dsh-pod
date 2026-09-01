/**
 * ark-headless 后端 —— 火山方舟（Volcengine Ark）Agent Plan OpenAI 兼容端点。
 *
 * 实证（2026-08-27）：
 *   - 端点：https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions（OpenAI 协议；
 *     标准 /api/v3 对 agent plan key 返回 401，必须走 /api/plan/v3）
 *   - 认证：Authorization: Bearer <ark-...>（agent plan key，46 字符）
 *   - 模型：deepseek-v4-flash / deepseek-v4-pro 可用；deepseek-v3/chat 不支持 agent plan（UnsupportedModel）
 *   - 特性：同步 completion（无流式进度事件）；响应含 reasoning_content；无 usage 字段 → usage 标 unavailable（D7 诚实化）
 *
 * Berd-G：protocol.family="native"（HTTP 直调，非进程式 CLI）；capabilities 如实声明。
 */

import { extractReport, buildTaskPrompt } from './claude-headless.js'
import type {
  AgentSlot,
  Task,
  UsageSource,
  WorkerBackend,
  WorkerCompletion,
  WorkerHandle,
  WorkerProgressEvent,
} from '../core/types.js'

export interface ArkBackendOptions {
  /** agent plan API key（ark- 开头，46 字符）。 */
  apiKey: string
  /** base URL；默认火山方舟北京区 agent plan 端点。 */
  baseUrl?: string
  /** 单次请求超时（默认 5 分钟；长任务需 task 层墙钟另行兜底）。 */
  timeoutMs?: number
  /** 可注入 fetch（测试）。 */
  fetchImpl?: typeof fetch
}

/**
 * 火山方舟后端：OpenAI 兼容 HTTP 直调（同步 completion）。
 * 无流式进度 → onProgress 不触发（如实）；完成信号 = HTTP 200 + 提取到 report。
 * 任务 prompt 复用 claude-headless 的 buildTaskPrompt（含 MISSION_REPORT 强制 schema）。
 */
export class ArkBackend implements WorkerBackend {
  readonly vendor = 'ark' as const
  readonly protocol = {
    family: 'native' as const,
    version: 'Volcengine Ark Agent Plan /api/plan/v3 (OpenAI-compatible, synchronous)',
    capabilities: { kill: false, session_persist: false, structured_output: true, usage_audit: false },
  }

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly clock: () => number
  private readonly model: string

  constructor(options: ArkBackendOptions & { model?: string; clock?: () => number }) {
    this.apiKey = options.apiKey
    this.baseUrl = options.baseUrl ?? 'https://ark.cn-beijing.volces.com/api/plan/v3'
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000
    this.fetchImpl = options.fetchImpl ?? fetch
    this.clock = options.clock ?? (() => Date.now())
    this.model = options.model ?? 'deepseek-v4-flash'
  }

  async detect() {
    try {
      // 轻量探测：一次最小 chat 调用（模型名任意合法即可；401 = key 无效）
      const res = await this.fetchImpl(this.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.apiKey },
        body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        return { installed: true, authed: true, models: [this.model], version: 'ark-agent-plan', session_tiers: ['transient' as const] }
      }
      return { installed: true, authed: false, models: [], version: 'ark-agent-plan', session_tiers: [], error: 'ark auth failed: ' + res.status }
    } catch (error) {
      return { installed: false, authed: false, models: [], version: undefined, session_tiers: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  async start(
    slot: AgentSlot,
    task: Task,
    worktree: string,
    callbacks?: { onProgress?(event: WorkerProgressEvent): void; onExit?(completion: WorkerCompletion): void },
  ): Promise<WorkerHandle> {
    const prompt = buildTaskPrompt({ task, worktreePath: worktree })
    const startedAt = this.clock()
    const model = slot.model !== '' && slot.model !== undefined ? slot.model : this.model
    // 异步执行（不阻塞 start）；完成信号 = HTTP 200 + report 提取
    void this.runOnce({ prompt, model, callbacks, startedAt })
    return { pid: undefined, session_ref: 'ark-' + task.id }
  }

  private async runOnce(opts: {
    prompt: string
    model: string
    callbacks?: { onProgress?(event: WorkerProgressEvent): void; onExit?(completion: WorkerCompletion): void }
    startedAt: number
  }): Promise<void> {
    try {
      const res = await this.fetchImpl(this.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.apiKey },
        body: JSON.stringify({
          model: opts.model,
          messages: [{ role: 'user', content: opts.prompt }],
          max_tokens: 8192,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        error?: { message?: string; code?: string }
      }
      if (!res.ok) {
        opts.callbacks?.onExit?.({
          exit: 'failed',
          usage: { tokens_in: 0, tokens_out: 0, source: 'unavailable' as UsageSource },
          artifacts: [],
          exit_code: res.status,
        })
        return
      }
      const text = body.choices?.[0]?.message?.content ?? ''
      const report = extractReport(text)
      if (report === undefined) {
        opts.callbacks?.onExit?.({
          exit: 'failed',
          usage: { tokens_in: 0, tokens_out: 0, source: 'unavailable' as UsageSource },
          artifacts: [],
          fault: 'mismatch',
          exit_code: 0,
        })
        return
      }
      const usage = { tokens_in: 0, tokens_out: 0, source: 'unavailable' as UsageSource }
      opts.callbacks?.onExit?.({
        exit: report.status === 'done' ? 'done' : 'failed',
        report,
        usage,
        artifacts: report.files_changed ?? [],
      })
    } catch (error) {
      // 诚实化（D7）：fetch 异常吞掉会让编排器只见「worker failed (exit ?)」零诊断
      // （08-31 E2E 实证）——异常信息透传到 error/error_detail，与 claude-headless 对齐。
      const message = error instanceof Error ? error.message : String(error)
      opts.callbacks?.onExit?.({
        exit: 'failed',
        usage: { tokens_in: 0, tokens_out: 0, source: 'unavailable' as UsageSource },
        artifacts: [],
        fault: 'crash',
        error_detail: message,
      })
    }
    void opts.startedAt
  }

  /** 裸调用：直接返回 assistant 文本（不要求 MISSION_REPORT 格式）。评分/问答类用。 */
  async complete(prompt: string, model?: string): Promise<{ text: string; ok: boolean; error?: string }> {
    try {
      const res = await this.fetchImpl(this.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.apiKey },
        body: JSON.stringify({
          model: model ?? this.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2048,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
      if (!res.ok) return { text: '', ok: false, error: body.error?.message ?? ('ark http ' + res.status) }
      return { text: body.choices?.[0]?.message?.content ?? '', ok: true }
    } catch (error) {
      return { text: '', ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async kill(_handle: WorkerHandle): Promise<void> {
    // HTTP 同步请求无法中断（AbortSignal 已随超时）；kill 为语义占位（protocol.capabilities.kill=false 如实）
  }
}
