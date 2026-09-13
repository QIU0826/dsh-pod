/**
 * OpenAI 兼容 chat/completions 后端基类（Berd-G：protocol.family="native"）——
 * Grok(xAI) / Kimi(Moonshot) 等「OpenAI 协议 HTTP 直调」厂商共用。
 *
 * 形态：同步 completion（无进程 / 无流式 / kill 为语义占位）；prompt 复用 claude-headless 的
 * buildTaskPrompt（含 MISSION_REPORT 强制 schema）；响应 usage 有则实测、无则 unavailable（诚实化 D7）。
 *
 * 契约来源：各家公开文档（本机无 key，故 capability 声明以文档为准、行为以调用实测为准——
 * 「能力位是声明不是断言」见 docs/adapters.md §6）。
 *
 * 注：ark-headless.ts 是同族实现（火山 agent-plan 端点无 usage 字段等 quirks），后续可迁到本基类。
 */
import { extractReport, buildTaskPrompt } from './claude-headless.js'
import type {
  AgentSlot,
  Task,
  UsageSource,
  Vendor,
  WorkerBackend,
  WorkerCompletion,
  WorkerHandle,
  WorkerProgressEvent,
} from '../core/types.js'

export interface OpenAiCompatOptions {
  vendor: Vendor
  /** Bearer API key。 */
  apiKey: string
  /** 协议版本描述（写进 protocol.version，文档/UI 用）。 */
  protocolVersion: string
  /** base URL（不含 /chat/completions）。 */
  baseUrl: string
  /** 缺省模型（槽位 model 为空时用）。 */
  defaultModel: string
  /** 单次请求超时（默认 5 分钟；task 层墙钟另行兜底）。 */
  timeoutMs?: number
  /** 任务完成的 max_tokens（默认 8192）。 */
  maxTokens?: number
  /** 可注入 fetch（测试）。 */
  fetchImpl?: typeof fetch
  /** 可注入时钟（测试）。 */
  clock?: () => number
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string }
}

export class OpenAiCompatBackend implements WorkerBackend {
  readonly vendor: Vendor
  readonly protocol: WorkerBackend['protocol']

  protected readonly apiKey: string
  protected readonly baseUrl: string
  protected readonly defaultModel: string
  protected readonly timeoutMs: number
  protected readonly maxTokens: number
  protected readonly fetchImpl: typeof fetch
  protected readonly clock: () => number

  constructor(options: OpenAiCompatOptions) {
    this.vendor = options.vendor
    this.apiKey = options.apiKey
    this.baseUrl = options.baseUrl
    this.defaultModel = options.defaultModel
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000
    this.maxTokens = options.maxTokens ?? 8192
    this.fetchImpl = options.fetchImpl ?? fetch
    this.clock = options.clock ?? (() => Date.now())
    this.protocol = {
      family: 'native' as const,
      version: options.protocolVersion,
      // OpenAI 契约返回 usage（实测为准）；无进程故 kill=false、无会话层故 session_persist=false
      capabilities: { kill: false, session_persist: false, structured_output: true, usage_audit: true },
    }
  }

  protected headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.apiKey }
  }

  /** 从 OpenAI 兼容响应里取 usage；缺字段 → unavailable（D7 诚实化）。 */
  protected usageOf(body: ChatResponse): { tokens_in: number; tokens_out: number; source: UsageSource } {
    const inTok = body.usage?.prompt_tokens
    const outTok = body.usage?.completion_tokens
    if (typeof inTok === 'number' && typeof outTok === 'number') {
      return { tokens_in: inTok, tokens_out: outTok, source: 'measured' as UsageSource }
    }
    return { tokens_in: 0, tokens_out: 0, source: 'unavailable' as UsageSource }
  }

  async detect() {
    try {
      const res = await this.fetchImpl(this.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model: this.defaultModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        return { installed: true, authed: true, models: [this.defaultModel], version: this.protocol.version, session_tiers: ['transient' as const] }
      }
      return { installed: true, authed: false, models: [], version: this.protocol.version, session_tiers: [], error: `${this.vendor} auth failed: ` + res.status }
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
    const model = slot.model !== '' && slot.model !== undefined ? slot.model : this.defaultModel
    void this.runOnce({ prompt, model, callbacks })
    return { pid: undefined, session_ref: `${this.vendor}-` + task.id }
  }

  private async runOnce(opts: {
    prompt: string
    model: string
    callbacks?: { onProgress?(event: WorkerProgressEvent): void; onExit?(completion: WorkerCompletion): void }
  }): Promise<void> {
    try {
      const res = await this.fetchImpl(this.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model: opts.model, messages: [{ role: 'user', content: opts.prompt }], max_tokens: this.maxTokens }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      const body = (await res.json()) as ChatResponse
      if (!res.ok) {
        opts.callbacks?.onExit?.({ exit: 'failed', usage: this.usageOf(body), artifacts: [], exit_code: res.status, error_detail: body.error?.message })
        return
      }
      const report = extractReport(body.choices?.[0]?.message?.content ?? '')
      if (report === undefined) {
        opts.callbacks?.onExit?.({ exit: 'failed', usage: this.usageOf(body), artifacts: [], fault: 'mismatch', exit_code: 0 })
        return
      }
      opts.callbacks?.onExit?.({ exit: 'done', report, usage: this.usageOf(body), artifacts: report.files_changed ?? [] })
    } catch (error) {
      // 诚实化（D7）：异常信息透传到 error_detail（否则编排器只见 crash 零诊断）
      opts.callbacks?.onExit?.({
        exit: 'failed',
        usage: { tokens_in: 0, tokens_out: 0, source: 'unavailable' as UsageSource },
        artifacts: [],
        fault: 'crash',
        error_detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** 裸调用：直接返回 assistant 文本（不要求 MISSION_REPORT）。评分/问答类用。 */
  async complete(prompt: string, model?: string): Promise<{ text: string; ok: boolean; error?: string }> {
    try {
      const res = await this.fetchImpl(this.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model: model ?? this.defaultModel, messages: [{ role: 'user', content: prompt }], max_tokens: 2048 }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      const body = (await res.json()) as ChatResponse
      if (!res.ok) return { text: '', ok: false, error: body.error?.message ?? `${this.vendor} http ` + res.status }
      return { text: body.choices?.[0]?.message?.content ?? '', ok: true }
    } catch (error) {
      return { text: '', ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async kill(_handle: WorkerHandle): Promise<void> {
    // HTTP 同步请求无法中断（AbortSignal 已随超时）；kill 为语义占位（capabilities.kill=false 如实）
  }
}
