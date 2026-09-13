/**
 * Kimi 后端（Moonshot AI）—— OpenAI 兼容 `/v1/chat/completions`，protocol.family="native"。
 *
 * 契约来源：Moonshot 公开文档（baseUrl `https://api.moonshot.cn/v1`、Bearer key、
 * 同步 completion、响应含 usage）。**本机无 key → 契约按公开文档 + fake fetch 测试锁定**
 * （照 opencode 首验模式）。
 *
 * 真机首验清单：① 有效 key → `detect().authed === true`；② 缺省模型在本账号可用
 * （不可用则用槽位 `model` 覆盖）；③ 响应含 `usage.prompt_tokens/completion_tokens`
 * （缺则自动回落 unavailable，ledger 诚实标注）；④ 如有海外/国内双端点，按部署改 `baseUrl`。
 */
import { OpenAiCompatBackend } from './openai-compat-backend.js'

export interface KimiBackendOptions {
  apiKey: string
  baseUrl?: string
  /** 缺省模型（取自公开文档，可按账号实际可用模型覆盖）。 */
  model?: string
  timeoutMs?: number
  maxTokens?: number
  fetchImpl?: typeof fetch
  clock?: () => number
}

export class KimiBackend extends OpenAiCompatBackend {
  constructor(options: KimiBackendOptions) {
    super({
      vendor: 'kimi',
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? 'https://api.moonshot.cn/v1',
      defaultModel: options.model ?? 'moonshot-v1-128k',
      protocolVersion: 'Moonshot OpenAI-compatible /v1/chat/completions (synchronous)',
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
    })
  }
}
