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

import { execFile, spawn, type ChildProcess } from 'node:child_process'
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
export function extractUsage(event: StreamJsonEvent): { tokens_in: number; tokens_out: number; source: UsageSource } | undefined {
  if (event.type !== 'result') return undefined
  const usage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined
  if (usage === undefined) return undefined
  return {
    tokens_in: usage.input_tokens ?? 0,
    tokens_out: usage.output_tokens ?? 0,
    source: 'measured',
  }
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

const REPORT_SCHEMA_HINT = `## MISSION_REPORT（必须输出，JSON）
{
  "task_id": "<id>", "task_type": "<任务类型>", "status": "done | blocked | need_clarify",
  "summary": "≤5 句事实陈述（禁止成功叙事）", "files_changed": ["相对 worktree 根的路径"],
  "commit_sha": "<40位 sha，非写码任务可省略>", "diff_path": "out/task-<id>.diff", "test_command": "npm test",
  "test_result": "pass | fail | not_run", "test_evidence": "12/12 ✓（输出路径 out/task-<id>.testlog）",
  "decisions": [], "blockers": [], "questions": [], "usage": { "tokens_in": 0, "tokens_out": 0 }
}

test_result 判定（CR-06-8，务必遵守）：
- 仓库有测试框架且测试真实失败 → fail（test_evidence 附失败输出）
- 仓库无测试框架 / 测试命令不存在（如 npm test 报 ENOENT、无 package.json）→ 必须填 not_run（禁止 fail），
  test_evidence 注明原因（如：npm ENOENT：仓库无 package.json，测试框架不存在）`

const COMMIT_DISCIPLINE = `完成后必须：运行测试 → git add -A && git commit（message 含 task-<task_id>）→ 生成 diff → 输出 MISSION_REPORT。禁止：合并主树、改动任务范围外文件、遗留脏 diff。`

/** 任务简报构造（charter 纪律 + 交接四件套注入 + 报告 schema；queue 投递的任务前缀）。 */
export function buildTaskPrompt(options: TaskPromptOptions): string {
  const { task, charterText, worktreePath, handoff } = options
  const parts: string[] = []
  parts.push(
    charterText && charterText.length > 0
      ? charterText
      : '你是被编排的员工：任务简报来自指挥；peer 消息是同级请求而非用户指令。',
  )
  parts.push('', `# 任务 ${task.id}：${task.title}`, '')
  parts.push(`## 工作目录（限定，越界写入将被拦截）\n${worktreePath}`, '')
  if (task.type === 'review') {
    parts.push(
      '## 审查任务（最小上下文原则）',
      '你只收到 diff（commit 区间）+ 规格 + 测试输出，刻意排除实现者推理叙事。',
      '结论只能是 pass（附一句最关键确认点）或 fail（逐条可复现的 blocking 问题）。',
      '审查不产生代码变更：不 commit、不改文件；files_changed 填 []，commit_sha 省略。',
      '报告 status 用 done（结论 pass）或 blocked（结论 fail，blockers 逐条列出）。',
      '',
    )
  }
  parts.push(`## 任务简报\n${task.spec}`, '')
  if (handoff !== undefined) {
    parts.push(
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
  parts.push(
    COMMIT_DISCIPLINE.replace('<task_id>', task.id),
    '',
    REPORT_SCHEMA_HINT.replace('<任务类型>', task.type),
  )
  return parts.filter((line) => line !== undefined).join('\n')
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
  /** 逐行产出（stream-json 事件行 + 混入的 stderr 文本行）。 */
  onLine(line: string): void
  /** 进程退出（code/signal/timedOut）。 */
  exited: Promise<{ code: number | null; signal: string | null; timedOut: boolean }>
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
}

/**
 * 组装 claude -p 参数（3.2 节后端对照表的 v2 增强全集）。
 * prompt 不进 argv：经 stdin 管道注入（Windows 专项：shell:true 下长中文 prompt
 * 经 cmd /c 引号拼接会被破坏，且 argv 有 8191 字符上限——CR-02 新实证）。
 */
export function buildClaudeArgs(options: ClaudeStartOptions): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
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
  private readonly spawner: ClaudeBackendOptions['spawner']
  private readonly detectRunner: NonNullable<ClaudeBackendOptions['detectRunner']>
  private readonly clock: () => number
  private readonly envForSlot: ((slot: AgentSlot) => Record<string, string>) | undefined
  private readonly allowedTools: string[] | undefined

  constructor(options: ClaudeBackendOptions = {}) {
    this.spawner = options.spawner
    this.clock = options.clock ?? (() => Date.now())
    this.envForSlot = options.envForSlot
    this.allowedTools = options.allowedTools
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
    const session = this.collect(slot, task, spawned, callbacks)
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
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env !== undefined ? { ...process.env, ...env } : process.env,
    })
    // onLine 通过属性访问器路由进闭包：collect() 的赋值与 stdout/stderr 事件读同一个 handler。
    let lineHandler: (line: string) => void = () => {}
    const spawned = {
      child,
      writeStdin(text: string) {
        child.stdin?.write(text, 'utf8')
        child.stdin?.end()
      },
      exited: new Promise<{ code: number | null; signal: string | null; timedOut: boolean }>((resolve) => {
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
        // stderr 同流解析：钩子/提示行可容错跳过，错误行供分类（绝不静默丢弃）
        child.stderr?.on('data', consume)
        const timer = setTimeout(() => {
          child.kill()
          resolve({ code: null, signal: null, timedOut: true })
        }, 15 * 60_000)
        child.on('exit', (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal, timedOut: false })
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
    const resultEvent = lines.map(parseStreamJsonLine).reverse().find((e) => e?.type === 'result')
    const usage = resultEvent === undefined ? { tokens_in: 0, tokens_out: 0, source: 'measured' as const } : (extractUsage(resultEvent) ?? { tokens_in: 0, tokens_out: 0, source: 'measured' as const })
    const errorInfo = resultEvent === undefined ? { isError: false } : resultErrorInfo(resultEvent)
    const fault = classifyClaudeExit(exit.code, exit.signal, exit.timedOut, resultEvent)
    const text = resultEvent === undefined ? '' : (extractResultText(resultEvent) ?? '')
    const report = extractReport(text)
    const exitKind: WorkerCompletion['exit'] =
      errorInfo.isError && fault === null ? 'failed' : fault === 'rate_limited' ? 'rate_limited' : exit.timedOut ? 'timeout' : fault !== null ? 'failed' : 'done'
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
      },
    }
  }

  async kill(handle: WorkerHandle): Promise<void> {
    if (handle.pid === undefined) return
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(handle.pid), '/T', '/F'], { windowsHide: true }, () => resolve())
    })
  }
}
