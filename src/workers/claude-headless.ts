/**
 * claude-headless 后端 —— 方案书 3.2 节后端对照表。
 *
 * W1 实证（本机 2.1.129）：
 *   - 进度源：--output-format stream-json + --include-partial-messages（必须配 --verbose）
 *   - 完成信号：退出码 + result 事件双判定——**result.is_error 优先于退出码**
 *     （实测 404 模型错误时 CLI 仍产出完整 result 事件；静默假成功对策，附录 F-25）
 *   - 会话持久：result.session_id 可用；--resume / --session-id 双路径（档位 B）
 *   - v2 增强：--json-schema 报告强制 / --max-budget-usd 双熔断 / --allowedTools 白名单 /
 *     --permission-mode bypassPermissions（worktree 隔离内自主执行；acceptEdits 只放行写盘
 *     不放行 Bash，实测 npm test 被权限系统拦截——CR-06-10）
 *
 * Windows 专项：claude 以 .cmd 分发 → win32 下 spawn 必须 shell:true（本机实证 ENOENT）。
 */

import { execFile as execFileCb, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFileCb)
import { killTree } from './kill-tree.js'
import { assertSafeArgvToken } from './argv-guard.js'
import { randomUUID } from 'node:crypto'
import type { ProcessRegistry } from './process-registry.js'
import type {
  AgentSlot,
  HandoffPayload,
  Task,
  UsageSource,
  WorkerBackend,
  WorkerCompletion,
  WorkerHandle,
  WorkerProgressEvent,
} from '../core/types.js'
import { execCommandRunner } from './preflight.js'
import { renderReportPromptFragment } from '../core/report-schema.js'
import { makeEnvelope } from '../core/error-envelope.js'
import type { WorkerErrorEnvelope } from '../core/error-envelope.js'

export type StreamJsonEvent = Record<string, unknown> & { type?: string }

/** 容错行解析：跳过空行/BOM/stderr 混入（stream-json 保证 JSONL，但钩子输出会混入）。 */
export function parseStreamJsonLine(line: string): StreamJsonEvent | undefined {
  const trimmed = line.replace(/^\uFEFF/, '').trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    return JSON.parse(trimmed) as StreamJsonEvent
  } catch {
    return undefined
  }
}

/** assistant 事件 → Canvas 进度（文本增量 / 工具调用）。 */
export function streamJsonToProgress(
  slotId: string,
  taskId: string,
  event: StreamJsonEvent,
  ts: number,
): WorkerProgressEvent | undefined {
  // system/api_retry 透传（审计实证：token 失效时 CLI 重试 2-3 分钟，期间零事件
  // → 停摆兜底误杀 + 用户只见神秘 exit 1）。system 进度既可观测又计入停摆判定。
  if (event.type === 'system') {
    const systemEvent = event as { subtype?: string; attempt?: number; max_retries?: number; error?: string; status?: string }
    if (systemEvent.subtype === 'api_retry') {
      return {
        slot_id: slotId, task_id: taskId, ts, kind: 'system',
        text: `API 重试 ${systemEvent.attempt ?? '?'}/${systemEvent.max_retries ?? '?'}（${systemEvent.error ?? '未知错误'}）`,
      }
    }
    return undefined
  }
  if (event.type !== 'assistant') return undefined
  const message = event.message as
    | { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> }
    | undefined
  const block = message?.content?.find((b) => b.type === 'text' || b.type === 'tool_use')
  if (block === undefined) return undefined
  if (block.type === 'text' && block.text !== undefined) {
    return { slot_id: slotId, task_id: taskId, ts, kind: 'text', text: block.text }
  }
  if (block.type === 'tool_use') {
    return { slot_id: slotId, task_id: taskId, ts, kind: 'tool_call', tool: block.name }
  }
  return undefined
}

/** result 事件 → usage（CR-01-5：实测 usage 位于 result 事件）。 */
export function extractUsage(event: StreamJsonEvent): { tokens_in: number; tokens_out: number; source: UsageSource; cache_read_tokens?: number; cache_creation_tokens?: number } | undefined {
  if (event.type !== 'result') return undefined
  const usage = event.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined
  if (usage === undefined) return undefined
  const result: { tokens_in: number; tokens_out: number; source: UsageSource; cache_read_tokens?: number; cache_creation_tokens?: number } = {
    tokens_in: usage.input_tokens ?? 0,
    tokens_out: usage.output_tokens ?? 0,
    source: 'measured',
  }
  // P0-2 prompt cache 对齐测量：result.usage 里实测 cache_read/cache_creation（W1 实证字段名）
  if (usage.cache_read_input_tokens !== undefined) result.cache_read_tokens = usage.cache_read_input_tokens
  if (usage.cache_creation_input_tokens !== undefined) result.cache_creation_tokens = usage.cache_creation_input_tokens
  return result
}

/** result 事件 → 最终文本（报告提取的数据源）。 */
export function extractResultText(event: StreamJsonEvent): string | undefined {
  if (event.type !== 'result') return undefined
  return typeof event.result === 'string' ? event.result : undefined
}

/** result 事件的错误面（实测：is_error + api_error_status 404）。 */
export function resultErrorInfo(event: StreamJsonEvent): { isError: boolean; apiStatus?: number; message?: string } {
  if (event.type !== 'result') return { isError: false }
  return {
    isError: event.is_error === true,
    apiStatus: typeof event.api_error_status === 'number' ? event.api_error_status : undefined,
    message: typeof event.result === 'string' ? event.result : undefined,
  }
}

/** 退出码/信号/超时 + result 事件 → FaultKind（3.4 节故障表；不猜 idle vs wall_clock）。 */
export function classifyClaudeExit(
  code: number | null,
  signal: string | null,
  timedOut: boolean,
  resultEvent?: StreamJsonEvent,
): import('../core/types.js').FaultKind | null {
  const info = resultEvent === undefined ? { isError: false, apiStatus: undefined } : resultErrorInfo(resultEvent)
  if (info.apiStatus === 429) return 'rate_limited'
  // 404 模型/配置类错误：重试无意义（与凭据过期同类处置：slot error，停止重试）
  if (info.isError && info.apiStatus === 404) return 'auth_expired'
  if (timedOut || signal !== null) return null // 超时/被杀由 watchdog 层显式分类
  if (code !== null && code !== 0) return 'crash'
  return null
}

/**
 * 从 claude 已结构化的信号构造错误信封（P2-2：给机器短码、给人留全文）。
 *
 * 优先级：`result.apiErrorStatus`（厂商结构化字段）> api_retry 尾记录 > 退出码。
 * 只有结构化字段全缺时才看重试文本（有界兜底），stderr 12 行彻底退出判定链路。
 */
export function claudeErrorEnvelope(
  resultEvent: StreamJsonEvent | undefined,
  lastRetry: { error?: string } | undefined,
  exit: { code: number | null; timedOut: boolean; spawnFailed?: boolean },
): WorkerErrorEnvelope | undefined {
  const info = resultEvent === undefined ? { isError: false, apiStatus: undefined, message: undefined } : resultErrorInfo(resultEvent)
  if (info.apiStatus === 429) return makeEnvelope('RATE_LIMIT_429', true, info.message)
  if (info.apiStatus === 401 || info.apiStatus === 403) return makeEnvelope(`AUTH_${info.apiStatus}`, false, info.message)
  // 404 = 模型/接口配置不存在，重试无意义（与凭据过期同类处置：停重试转人工）
  if (info.apiStatus === 404) return makeEnvelope('AUTH_CONFIG_404', false, '模型或接口配置不存在（检查 ANTHROPIC_BASE_URL 与模型名）')
  if (lastRetry !== undefined) {
    const text = lastRetry.error ?? ''
    if (/401|403|unauthorized|auth|credential/i.test(text)) return makeEnvelope('AUTH_401', false, text)
    if (/429|rate limit|too many requests/i.test(text)) return makeEnvelope('RATE_LIMIT_429', true, text)
    return makeEnvelope('CRASH', true, text)
  }
  if (info.isError) return makeEnvelope('CRASH', true, info.message)
  if (exit.spawnFailed === true) return makeEnvelope('CRASH_SPAWN', false, 'worker 进程启动失败（二进制缺失或权限不足）')
  if (exit.timedOut) return makeEnvelope('WALL_CLOCK_TIMEOUT', false, undefined)
  if (exit.code !== null && exit.code !== 0) return makeEnvelope('CRASH', true, `exit ${exit.code}`)
  return undefined
}

/**
 * 从最终文本提取 MISSION_REPORT JSON（附录 C 输出契约）。
 * 优先 ```json 围栏块；回退为文本中首个含 task_id+status 的平衡花括号 JSON。
 * 提取失败 → undefined（Verifier 层判 silent_failure，不静默放行）。
 */
export function extractReport(text: string): import('../core/types.js').MissionReport | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g
  for (const match of text.matchAll(fenced)) {
    try {
      const parsed: unknown = JSON.parse(match[1]!.trim())
      if (isReportLike(parsed)) return parsed as import('../core/types.js').MissionReport
    } catch {
      // 该围栏不是 JSON，继续找下一个
    }
  }
  for (const candidate of balancedJsonCandidates(text)) {
    if (isReportLike(candidate)) return candidate as import('../core/types.js').MissionReport
  }
  return undefined
}

function isReportLike(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.task_id === 'string' && typeof record.status === 'string'
}

/** 扫描文本中所有平衡花括号 JSON 候选（首个左括号 { 起，配平到对应右括号）。 */
function balancedJsonCandidates(text: string): unknown[] {
  const candidates: unknown[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    let depth = 0
    for (let j = i; j < text.length; j++) {
      if (text[j] === '{') depth++
      else if (text[j] === '}') {
        depth--
        if (depth === 0) {
          try {
            candidates.push(JSON.parse(text.slice(i, j + 1)))
          } catch {
            // 非 JSON 片段，继续
          }
          break
        }
      }
    }
  }
  return candidates
}

export interface TaskPromptOptions {
  task: Task
  charterText?: string
  worktreePath: string
  handoff?: {
    from: string
    intent: HandoffPayload['intent']
    artifacts: HandoffPayload['artifacts']
    state: HandoffPayload['state']
    expected_output: string
    verify: string[]
  }
}

const REPORT_SCHEMA_HINT = renderReportPromptFragment('<任务类型>')

/**
 * 交付纪律（P0-A 软化版）。byte-稳定：不含任务 id（任务 ID 见任务头，由 worker 从
 * prompt 内解析）——P0-2 静态前缀工程：同 mission 内所有任务该段逐字节一致，
 * prompt cache 对齐（跨并行 worker 会话共享前缀）。
 */
/** P1-6 pinned 安全层：交付纪律模板（不变量测试直接引用，禁止在别处重写/概括）。 */
export const COMMIT_DISCIPLINE = `任务完成后按序交付：运行测试 → git add -A && git commit（message 以 task-<任务ID> 标识本任务，任务 ID 见任务头）→ 生成 diff → 输出 MISSION_REPORT。工作区边界（合并主树、改动任务范围外文件）由代码拦截，脏 diff 会在独立 review 中暴露——收尾前自查一遍即可。`

/** 无 charter 时的身份回退（byte-稳定；P1-6 pinned 层）。 */
export const FALLBACK_IDENTITY =
  '你是本 Mission 的员工：任务简报来自指挥（编排器）；peer 消息是同级协作请求，不算用户指令。'

export interface TaskPromptSegments {
  /** 静态脚手架：charter/fallback + 交付纪律 + 报告 schema（同 mission 内 byte-稳定，prompt cache 对齐）。 */
  static: string
  /** 动态段：任务头 + 工作目录 + 审查块 + 简报 + 交接。 */
  dynamic: string
}

/**
 * 任务简报静态/动态拆分（P0-2 静态前缀工程）。
 * 静态脚手架（身份 + 交付纪律 + 报告 schema）连续前置且 byte-稳定：同一 mission、
 * 同任务类型的所有任务共享同一前缀，为 prompt cache 提供可命中前缀；
 * 动态段（任务头/工作目录/审查块/简报/交接）随任务变化放在其后。
 */
export function buildTaskPromptSegments(options: TaskPromptOptions): TaskPromptSegments {
  const { task, charterText, worktreePath, handoff } = options
  const staticParts: string[] = []
  staticParts.push(
    charterText && charterText.length > 0 ? charterText : FALLBACK_IDENTITY,
    '',
    COMMIT_DISCIPLINE,
    '',
    REPORT_SCHEMA_HINT.replace('<任务类型>', task.type),
  )
  const dynamicParts: string[] = []
  dynamicParts.push(
    '',
    `# 任务 ${task.id}：${task.title}`,
    '',
    `## 工作目录（限定，越界写入将被拦截）\n${worktreePath}`,
    '',
  )
  if (task.type === 'review') {
    dynamicParts.push(
      '## 审查任务（最小上下文原则）',
      '你只收到 diff（commit 区间）+ 规格 + 测试输出，刻意排除实现者推理叙事。',
      '结论只能是 pass（附一句最关键确认点）或 fail（逐条可复现的 blocking 问题）。',
      '审查不产生代码变更：不 commit、不改文件；files_changed 填 []，commit_sha 省略。',
      '报告 status 用 done（结论 pass）或 blocked（结论 fail，blockers 逐条列出）。',
      '',
    )
  }
  dynamicParts.push(`## 任务简报\n${task.spec}`, '')
  if (handoff !== undefined) {
    dynamicParts.push(
      '## 交接消息（来自指挥的 peer 请求）',
      `意图：${handoff.intent.brief}`,
      handoff.intent.constraints.length > 0 ? `约束：${handoff.intent.constraints.join('；')}` : '',
      `验收：${handoff.intent.acceptance}`,
      `规格指针：${handoff.artifacts.spec}`,
      handoff.artifacts.context_files.length > 0
        ? `上下文文件（只读点名文件，勿通读全库）：${handoff.artifacts.context_files.join('、')}`
        : '',
      `期望产物：${handoff.expected_output}`,
      `收方校验（可检查物）：${handoff.verify.join('、')}`,
      '',
    )
  }
  return { static: staticParts.join('\n'), dynamic: dynamicParts.join('\n') }
}

/** 任务简报构造（静态脚手架 + 动态任务段；P0-2 静态前缀工程拆分后仍为单字符串）。 */
export function buildTaskPrompt(options: TaskPromptOptions): string {
  const segments = buildTaskPromptSegments(options)
  return `${segments.static}\n\n${segments.dynamic}`
}

export interface ClaudeStartOptions {
  prompt: string
  cwd: string
  model?: string
  sessionTier: AgentSlot['session_tier']
  sessionRef?: string
  /** --session-id 预分配（档位 B 首次派单）。 */
  newSessionId?: string
  maxBudgetUsd?: number
  allowedTools?: string[]
  permissionMode?: 'acceptEdits' | 'bypassPermissions'
  timeoutMs?: number
}

export interface SpawnedClaude {
  child: ChildProcess
  /** stderr 尾随（最后 ~12 行，失败归因的数据源；审计实证：API 401 曾被静默丢弃）。 */
  stderrTail: string[]
  /** 逐行产出（stream-json 事件行 + 混入的 stderr 文本行）。 */
  onLine(line: string): void
  /** 进程退出（code/signal/timedOut；spawnFailed = 二进制启动失败，如 ENOENT）。 */
  exited: Promise<{ code: number | null; signal: string | null; timedOut: boolean; spawnFailed?: boolean }>
  /** prompt 经 stdin 注入（短固定 argv，无引号/长度风险）。 */
  writeStdin(text: string): void
}

export interface ClaudeBackendOptions {
  spawner?: (cmd: string, args: string[], options: { cwd: string; shell: boolean; env?: Record<string, string> }) => SpawnedClaude
  detectRunner?: { run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> }
  registry?: ProcessRegistry
  /** 供测试注入的时钟。 */
  clock?: () => number
  /**
   * 进程级 env 覆盖（ccswitch 共存方案，CR-03）：
   * 每个员工可按 slot 注入 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL 等，
   * 实现「不同员工不同模型/提供商」而不改写全局 settings.json。
   */
  envForSlot?: (slot: AgentSlot) => Record<string, string>
  /** --allowedTools 进程白名单（3.8 节三道防线之一），每次 start 统一注入。 */
  allowedTools?: string[]
  /** 单任务进程超时（默认 15 分钟；长任务经 orchestrator max_wall_clock_ms 传递）。 */
  taskTimeoutMs?: number
}

/**
 * 组装 claude -p 参数（3.2 节后端对照表的 v2 增强全集）。
 * prompt 不进 argv：经 stdin 管道注入（Windows 专项：shell:true 下长中文 prompt
 * 经 cmd /c 引号拼接会被破坏，且 argv 有 8191 字符上限——CR-02 新实证）。
 */
export function buildClaudeArgs(options: ClaudeStartOptions): string[] {
  // P1 注入面收口：win32 shell:true 下 Node 不做逐参数引用，动态值里的 cmd 元字符即命令注入
  assertSafeArgvToken('claude model', options.model)
  assertSafeArgvToken('claude sessionRef', options.sessionRef)
  assertSafeArgvToken('claude newSessionId', options.newSessionId)
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages',
    // CR-29 补充实证：headless worker 不需要 skills/斜杠命令；全局安装 293 个 skills 时
    // 其 system-reminder 注入会让部分 anthropic 兼容上游（GLM 中转）报 400（input 应为 string）。
    '--disable-slash-commands',
    '--bare',
  ]
  if (options.model !== undefined) args.push('--model', options.model)
  if (options.sessionTier !== 'transient') {
    if (options.sessionRef !== undefined) args.push('--resume', options.sessionRef)
    else if (options.newSessionId !== undefined) args.push('--session-id', options.newSessionId)
  }
  if (options.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(options.maxBudgetUsd))
  if (options.allowedTools !== undefined && options.allowedTools.length > 0) {
    args.push('--allowedTools', options.allowedTools.join(','))
  }
  if (options.permissionMode !== undefined) args.push('--permission-mode', options.permissionMode)
  return args
}

export class ClaudeHeadlessBackend implements WorkerBackend {
  readonly vendor = 'claude' as const
  readonly protocol = {
    family: 'headless-cli' as const,
    version: 'claude -p (--output-format json + --allowedTools)',
    capabilities: { kill: true, session_persist: true, structured_output: true, usage_audit: true },
  }
  private readonly spawner: ClaudeBackendOptions['spawner']
  private readonly detectRunner: NonNullable<ClaudeBackendOptions['detectRunner']>
  private readonly clock: () => number
  private readonly envForSlot: ((slot: AgentSlot) => Record<string, string>) | undefined
  private readonly allowedTools: string[] | undefined
  private readonly taskTimeoutMs: number

  constructor(options: ClaudeBackendOptions = {}) {
    this.spawner = options.spawner
    this.clock = options.clock ?? (() => Date.now())
    this.envForSlot = options.envForSlot
    this.allowedTools = options.allowedTools
    this.taskTimeoutMs = options.taskTimeoutMs ?? 15 * 60_000
    // 默认探测复用 preflight 的 shell-fallback runner（.cmd 包装器兼容）
    this.detectRunner = options.detectRunner ?? execCommandRunner
  }

  async detect(): Promise<Awaited<ReturnType<WorkerBackend['detect']>>> {
    const version = await this.detectRunner.run('claude', ['--version'])
    if (version.code !== 0) {
      return { installed: false, authed: false, models: [], session_tiers: ['per-mission'], error: 'claude not installed' }
    }
    const auth = await this.detectRunner.run('claude', ['auth', 'status'])
    const authed = /"loggedIn"\s*:\s*true/.test(auth.stdout)
    return {
      installed: true,
      authed,
      models: [],
      version: version.stdout.trim(),
      session_tiers: ['per-mission'],
      error: authed ? undefined : 'claude not logged in',
    }
  }

  async start(
    slot: AgentSlot,
    task: Task,
    worktree: string,
    callbacks: {
      onProgress?(event: WorkerProgressEvent): void
      onExit?(completion: WorkerCompletion): void
    } = {},
  ): Promise<WorkerHandle> {
    const prompt = buildTaskPrompt({ task, worktreePath: worktree })
    // 档位 B 首次派单：预分配 --session-id（后续派单用 slot.session_ref 走 --resume）
    const needsNewSession = slot.session_tier !== 'transient' && (slot.session_ref === undefined || slot.session_ref.length === 0)
    const args = buildClaudeArgs({
      prompt,
      cwd: worktree,
      model: slot.model !== '' ? slot.model : undefined,
      sessionTier: slot.session_tier,
      sessionRef: slot.session_ref,
      newSessionId: needsNewSession ? randomUUID() : undefined,
      permissionMode: 'bypassPermissions',
      allowedTools: this.allowedTools,
    })
    const env = this.envForSlot !== undefined ? this.envForSlot(slot) : undefined
    const spawned = this.spawnClaude(args, worktree, env)
    spawned.writeStdin(prompt)
    const handle: WorkerHandle = { pid: spawned.child.pid }
    const session = this.collect(slot, task, worktree, spawned, callbacks)
    session.then(({ sessionRef, completion }) => {
      handle.session_ref = sessionRef
      callbacks.onExit?.(completion)
    })
    return handle
  }

  private spawnClaude(args: string[], cwd: string, env?: Record<string, string>): SpawnedClaude {
    if (this.spawner !== undefined) return this.spawner('claude', args, { cwd, shell: true, env })
    const child = spawn('claude', args, {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      // POSIX 建独立进程组：killTree 才能连带终止 CLI 的孙进程（Windows 用 taskkill /T，无需建组）
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env !== undefined ? { ...process.env, ...env } : process.env,
    })
    // onLine 通过属性访问器路由进闭包：collect() 的赋值与 stdout/stderr 事件读同一个 handler。
    let lineHandler: (line: string) => void = () => {}
    const stderrTail: string[] = []
    const spawned = {
      child,
      stderrTail,
      writeStdin(text: string) {
        const stdin = child.stdin
        if (stdin === null) return
        // 对端提前关闭时写入报 EPIPE：吞掉（exit/error 路径接管完成信号），绝不炸宿主
        stdin.on('error', () => {})
        stdin.write(text, 'utf8')
        stdin.end()
      },
      exited: new Promise<{ code: number | null; signal: string | null; timedOut: boolean; spawnFailed: boolean }>((resolve) => {
        let buffer = ''
        const consume = (chunk: Buffer): void => {
          buffer += chunk.toString('utf8')
          let index: number
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index)
            buffer = buffer.slice(index + 1)
            lineHandler(line)
          }
        }
        child.stdout?.on('data', consume)
        // stderr：除同流解析外，单独保留尾随（CLI 的 API 报错/鉴权失败走这里——
        // 审计实证：401 时 collect 只看得到 exit 1，根因被静默丢弃）
        child.stderr?.on('data', (chunk: Buffer) => {
          for (const line of chunk.toString('utf8').split('\n')) {
            const t = line.trim()
            if (t.length === 0) continue
            stderrTail.push(t)
          }
          if (stderrTail.length > 12) stderrTail.splice(0, stderrTail.length - 12)
          consume(chunk)
        })
        const timer = setTimeout(() => {
          // 树杀：shell 包装下 child.kill() 只杀到 cmd.exe，CLI 孙进程会继续烧 token
          void killTree(child.pid)
          resolve({ code: null, signal: null, timedOut: true, spawnFailed: false })
        }, this.taskTimeoutMs)
        // spawn 失败（ENOENT/EPERM）：无 error 监听会以 uncaught exception 炸掉宿主进程；
        // 且 exit 不会触发——必须在这里 resolve，否则只能等超时误分类为 timeout
        child.on('error', () => {
          clearTimeout(timer)
          resolve({ code: null, signal: null, timedOut: false, spawnFailed: true })
        })
        child.on('exit', (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal, timedOut: false, spawnFailed: false })
        })
      }),
    }
    Object.defineProperty(spawned, 'onLine', {
      set(fn: (line: string) => void) {
        lineHandler = fn
      },
      get() {
        return lineHandler
      },
    })
    return spawned as SpawnedClaude
  }

  private async collect(
    slot: AgentSlot,
    task: Task,
    worktree: string,
    spawned: SpawnedClaude,
    callbacks: {
      onProgress?(event: WorkerProgressEvent): void
    },
  ): Promise<{ sessionRef?: string; completion: WorkerCompletion }> {
    const lines: string[] = []
    spawned.onLine = (line) => {
      lines.push(line)
      const event = parseStreamJsonLine(line)
      if (event !== undefined) {
        const progress = streamJsonToProgress(slot.id, task.id, event, this.clock())
        if (progress !== undefined) callbacks.onProgress?.(progress)
      }
    }
    const exit = await spawned.exited
    const parsedLines = lines.map(parseStreamJsonLine)
    // 用副本反转取「最后一条」：原代码两次 reverse() 原地反转再反转回来互相抵消，
    // 一旦中间插入新的取数就会静默取错方向。ES2022 无 findLast，故显式副本。
    const resultEvent = [...parsedLines].reverse().find((e) => e?.type === 'result')
    // stdout 的最后一条 api_retry/错误类 system 事件 = 真实根因（401 等）。同样用副本反转，
    // 不在 parsedLines 上原地 reverse（原地反转会污染后续取数方向）。
    const lastRetry = [...parsedLines].reverse().find((e) => e?.type === 'system' && (e as { subtype?: string }).subtype === 'api_retry') as
      | { attempt?: number; max_retries?: number; error?: string }
      | undefined
    // 失败根因（审计实证：API 401 曾只见 exit 1）：优先 stdout 的 api_retry 尾记录，
    // 其次 stderr 尾随；成功时不附
    const stderrDetail = spawned.stderrTail.length > 0 && resultEvent === undefined
      ? spawned.stderrTail.join(' | ').slice(0, 400)
      : undefined
    const usage = resultEvent === undefined ? { tokens_in: 0, tokens_out: 0, source: 'measured' as const } : (extractUsage(resultEvent) ?? { tokens_in: 0, tokens_out: 0, source: 'measured' as const })
    const errorInfo = resultEvent === undefined ? { isError: false } : resultErrorInfo(resultEvent)
    // spawn 失败显式归为 failed(crash)：不标则 code=null 走不到任何故障分支，会被误判 done
    const fault = exit.spawnFailed ? 'crash' : classifyClaudeExit(exit.code, exit.signal, exit.timedOut, resultEvent)
    // P2-2 结构化错误信封：给机器短码（编排器按 error_code 确定性分流，替换 stderr 正则嗅探），
    // 给人留全文（hint 只进 UI/审计，不进 LLM 上下文）。成功时 undefined。
    const envelope = claudeErrorEnvelope(resultEvent, lastRetry, exit)
    const text = resultEvent === undefined ? '' : (extractResultText(resultEvent) ?? '')
    const report = extractReport(text)
    // commit_sha 权威校正（E2E 实证 2026-09-01）：模型在 MISSION_REPORT 里手填的
    // commit_sha 与真实 commit 不一致率 ≈19%（16 个写码任务 3 个错）——verifier 按
    // fail-closed 会把「真实成功」判成 silent_failure。保守校正：仅当报告存在、任务为
    // 写码类、status=done 且报告 sha 在 worktree 无法解析时，以 worktree HEAD 真实
    // sha 覆盖——绝不从无到有补 sha（无 sha 保持原判，防谎报 done 绕过 fail-plausible）。
    if (report !== undefined && report.status === 'done' && (task.type === 'implement' || task.type === 'test') && typeof report.commit_sha === 'string' && report.commit_sha.length > 0 && worktree.length > 0) {
      try {
        await execFileAsync('git', ['-C', worktree, 'rev-parse', '--verify', '--quiet', `${report.commit_sha}^{commit}`], { timeout: 5000, windowsHide: true })
      } catch {
        try {
          const head = await execFileAsync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
          const headSha = head.stdout.trim()
          if (/^[0-9a-f]{40}$/.test(headSha) && headSha !== report.commit_sha) {
            console.warn(`[claude-headless] report commit_sha 不可解析（${report.commit_sha}），以 worktree HEAD 校正为 ${headSha}`)
            report.commit_sha = headSha
          }
        } catch {
          // HEAD 也取不到（worktree 异常）：保持原值，交 verifier fail-closed
        }
      }
    }
    const exitKind: WorkerCompletion['exit'] =
      exit.spawnFailed ? 'failed' : errorInfo.isError && fault === null ? 'failed' : fault === 'rate_limited' ? 'rate_limited' : exit.timedOut ? 'timeout' : fault !== null ? 'failed' : 'done'
    let errorDetail: string | undefined
    if (exitKind !== 'done') {
      if (lastRetry !== undefined) {
        errorDetail = `API 重试 ${lastRetry.attempt ?? '?'}/${lastRetry.max_retries ?? '?'} 次后失败：${lastRetry.error ?? '未知错误'}（检查 ANTHROPIC_BASE_URL/AUTH_TOKEN 凭据）`
      } else if (stderrDetail !== undefined) {
        errorDetail = stderrDetail
      }
    }
    return {
      sessionRef: typeof resultEvent?.session_id === 'string' ? resultEvent.session_id : undefined,
      completion: {
        exit: exitKind,
        fault: fault ?? undefined,
        report,
        usage,
        artifacts: report?.diff_path !== undefined ? [report.diff_path] : [],
        exit_code: exit.code ?? undefined,
        signal: exit.signal ?? undefined,
        ...(errorDetail !== undefined ? { error_detail: errorDetail } : {}),
        ...(envelope !== undefined ? { error_envelope: envelope } : {}),
      },
    }
  }

  async kill(handle: WorkerHandle): Promise<void> {
    // 树杀且跨平台：taskkill 仅 Windows 存在，此前 POSIX 上 ENOENT 被吞 = kill 静默 no-op
    await killTree(handle.pid)
  }
}
