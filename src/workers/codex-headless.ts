/**
 * codex-headless 后端 —— 方案书 3.2 节后端对照表。
 *
 * W1 实证（本机 codex-cli 0.148.0-alpha.9，二进制位于 ~/.codex/.sandbox-bin/codex.exe）：
 *   - 进度源：exec --json → JSONL 事件流（thread.started / item.* / turn.completed）
 *   - 完成信号：退出码（确定性）；usage 位于 turn.completed（input/output/reasoning tokens，实测）→ CR-01-5 解除
 *   - 会话持久：exec resume <thread_id> 实测可用——跨进程召回记忆（plant ALPHA-77 → recall "ALPHA-77" ✓）
 *   - 默认 exec 每次新 thread（档位 A 瞬时语义实证）；resume 时 -C 等 flag 位置敏感（放 session_id 前）
 *   - 档位 C（auto-reset）无摘要注入路径 → 等价瞬时新线程（R1 降级档 A 的兄弟路径）
 *
 * Windows 专项：DSH 宿主 PATH 可能滞后于新装 CLI → 二进制候选解析
 * （PATH 中 codex → ~/.codex/.sandbox-bin/codex.exe 兜底），版本 pin 进 preflight。
 */

import { spawn } from 'node:child_process'
import { killTree } from './kill-tree.js'
import { assertSafeArgvPath, assertSafeArgvToken } from './argv-guard.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { extractReport, buildTaskPrompt } from './claude-headless.js'
import { execCommandRunner } from './preflight.js'
import type {
  AgentSlot,
  Task,
  UsageSource,
  WorkerBackend,
  WorkerCompletion,
  WorkerHandle,
  WorkerProgressEvent,
} from '../core/types.js'

export type CodexJsonlEvent = Record<string, unknown> & { type?: string }

/** 容错行解析（登录提示等 stderr 文本会混入 stdout 重定向）。 */
export function parseCodexJsonlLine(line: string): CodexJsonlEvent | undefined {
  const trimmed = line.replace(/^\uFEFF/, '').trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    return JSON.parse(trimmed) as CodexJsonlEvent
  } catch {
    return undefined
  }
}

/** thread.started → thread_id（resume 的钥匙）。 */
export function extractCodexThreadId(event: CodexJsonlEvent): string | undefined {
  if (event.type !== 'thread.started') return undefined
  return typeof event.thread_id === 'string' ? event.thread_id : undefined
}

/** turn.completed → usage（CR-01-5：codex JSONL 实测带 usage）。 */
export function extractCodexUsage(event: CodexJsonlEvent): { tokens_in: number; tokens_out: number; source: UsageSource } | undefined {
  if (event.type !== 'turn.completed') return undefined
  const usage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined
  if (usage === undefined) return undefined
  return { tokens_in: usage.input_tokens ?? 0, tokens_out: usage.output_tokens ?? 0, source: 'measured' }
}

/** item.completed → Canvas 进度（agent_message 文本 / command 工具 / error 系统事件）。 */
export function codexJsonlToProgress(
  slotId: string,
  taskId: string,
  event: CodexJsonlEvent,
  ts: number,
): WorkerProgressEvent | undefined {
  if (event.type !== 'item.completed') return undefined
  const item = event.item as { type?: string; text?: string; name?: string; message?: string } | undefined
  if (item === undefined) return undefined
  if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.length > 0) {
    return { slot_id: slotId, task_id: taskId, ts, kind: 'text', text: item.text }
  }
  if (item.type === 'command' || item.type === 'function_call') {
    return { slot_id: slotId, task_id: taskId, ts, kind: 'tool_call', tool: item.name ?? item.type }
  }
  if (item.type === 'error') {
    return { slot_id: slotId, task_id: taskId, ts, kind: 'system', text: item.message ?? 'codex error event' }
  }
  return undefined
}

/** 会话档位 → 启动模式（W1 实证矩阵）。 */
export type CodexLaunchMode = { kind: 'new-thread' } | { kind: 'resume'; threadId: string }

export function resolveCodexMode(slot: Pick<AgentSlot, 'session_tier' | 'session_ref'>): CodexLaunchMode {
  // 档位 A/C → 新线程；档位 B 且有 thread → resume
  if (slot.session_tier === 'per-mission' && slot.session_ref !== undefined && slot.session_ref.length > 0) {
    return { kind: 'resume', threadId: slot.session_ref }
  }
  return { kind: 'new-thread' }
}

/** 二进制候选（Windows 专项：宿主 PATH 滞后 → 家目录兜底）。 */
export function codexBinaryCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    return ['codex', join(homedir(), '.codex', '.sandbox-bin', 'codex.exe')]
  }
  return ['codex']
}

export interface SpawnedCodex {
  pid?: number
  /** stderr 尾随（失败归因：codex 的 API 报错行混在 stdout/stderr 两路）。 */
  stderrTail: string[]
  onLine(line: string): void
  exited: Promise<{ code: number | null; signal: string | null; timedOut: boolean; spawnFailed?: boolean }>
  /** prompt 经 stdin 注入（短固定 argv，无引号/长度风险——Windows 专项）。 */
  writeStdin(text: string): void
  kill(): void
}

export interface CodexBackendOptions {
  spawner?: (binary: string, args: string[], options: { cwd: string }) => SpawnedCodex
  detectRunner?: { run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> }
  binary?: string
  clock?: () => number
}

/**
 * 组装 codex exec 参数（W1 实证：resume 的 flag 必须放在 session_id 之前）。
 * prompt 不进 argv：以 '-' 占位走 stdin（exec 支持 stdin 读指令）。
 */
export function buildCodexArgs(mode: CodexLaunchMode, worktree: string, model?: string): string[] {
  // P1 注入面收口：win32 shell:true 下 -C worktree / -m model 是客户端可控动态值
  assertSafeArgvPath('codex worktree', worktree)
  assertSafeArgvToken('codex model', model)
  if (mode.kind === 'resume') {
    assertSafeArgvToken('codex threadId', mode.threadId)
    return ['exec', 'resume', '--json', mode.threadId, '-']
  }
  const args = ['exec', '-', '--json', '--color', 'never', '--skip-git-repo-check', '-s', 'read-only', '-C', worktree]
  if (model !== undefined && model.length > 0) args.push('-m', model)
  return args
}

export class CodexHeadlessBackend implements WorkerBackend {
  readonly vendor = 'codex' as const
  readonly protocol = {
    family: 'headless-cli' as const,
    version: 'codex exec (sandbox-bin, --json)',
    capabilities: { kill: true, session_persist: false, structured_output: true, usage_audit: false },
  }
  private readonly spawner?: CodexBackendOptions['spawner']
  private readonly detectRunner: NonNullable<CodexBackendOptions['detectRunner']>
  private readonly binary: string
  private readonly clock: () => number

  constructor(options: CodexBackendOptions = {}) {
    this.spawner = options.spawner
    this.binary = options.binary ?? 'codex'
    this.clock = options.clock ?? (() => Date.now())
    // 默认探测复用 preflight 的 shell-fallback runner（.cmd 包装器兼容）
    this.detectRunner = options.detectRunner ?? execCommandRunner
  }

  async detect(): Promise<Awaited<ReturnType<WorkerBackend['detect']>>> {
    const version = await this.detectRunner.run(this.binary, ['--version'])
    if (version.code !== 0) {
      return { installed: false, authed: false, models: [], session_tiers: ['transient'], error: 'codex not installed' }
    }
    const auth = await this.detectRunner.run(this.binary, ['login', 'status'])
    const authed = /logged in/i.test(auth.stdout) && !/not logged in/i.test(auth.stdout)
    return {
      installed: true,
      authed,
      models: [],
      version: version.stdout.trim(),
      session_tiers: ['transient', 'per-mission'],
      error: authed ? undefined : 'codex not logged in',
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
    const mode = resolveCodexMode(slot)
    // 复用统一任务简报构造（含 MISSION_REPORT schema 与 commit 纪律，CR-03 实证：
    // 无 schema 提示时模型会自创 status 词，破坏输出契约）
    const prompt = buildTaskPrompt({ task, worktreePath: worktree })
    const args = buildCodexArgs(mode, worktree, slot.model !== '' ? slot.model : undefined)
    const spawned = this.spawnCodex(args, worktree)
    spawned.writeStdin(prompt)
    const handle: WorkerHandle = { pid: spawned.pid }
    const session = this.collect(slot, task, spawned, callbacks)
    session.then(({ threadId, completion }) => {
      handle.session_ref = threadId
      callbacks.onExit?.(completion)
    })
    return handle
  }

  private spawnCodex(args: string[], cwd: string): SpawnedCodex {
    if (this.spawner !== undefined) return this.spawner(this.binary, args, { cwd })
    const child = spawn(this.binary, args, {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      // POSIX 建独立进程组：killTree 可组杀孙进程（Windows 走 taskkill /T）
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // onLine 通过属性访问器路由进闭包：collect() 的赋值与 stdout/stderr 事件读同一个 handler。
    let lineHandler: (line: string) => void = () => {}
    const stderrTail: string[] = []
    const spawned = {
      pid: child.pid,
      stderrTail,
      writeStdin(text: string) {
        const stdin = child.stdin
        if (stdin === null) return
        // 对端提前关闭时写入报 EPIPE：吞掉（exit/error 路径接管），绝不炸宿主
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
        // stderr：同流解析之外保留尾随（codex 的 API/鉴权错误行走这里）
        child.stderr?.on('data', (chunk: Buffer) => {
          for (const line of chunk.toString('utf8').split('\n')) {
            const t = line.trim()
            if (t.length > 0) stderrTail.push(t)
          }
          if (stderrTail.length > 12) stderrTail.splice(0, stderrTail.length - 12)
          consume(chunk)
        })
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          // 树杀：shell 包装下 child.kill() 杀不到 CLI 孙进程
          void killTree(child.pid)
        }, 60 * 60_000)
        // spawn 失败（ENOENT/EPERM）：无 error 监听 = uncaught exception 炸宿主；且 exit 不触发，
        // exited 将悬挂到超时——必须在此 resolve 并标记 spawnFailed
        child.on('error', () => {
          clearTimeout(timer)
          resolve({ code: null, signal: null, timedOut: false, spawnFailed: true })
        })
        child.on('exit', (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal, timedOut, spawnFailed: false })
        })
      }),
      kill() {
        void killTree(child.pid)
      },
    }
    Object.defineProperty(spawned, 'onLine', {
      set(fn: (line: string) => void) {
        lineHandler = fn
      },
      get() {
        return lineHandler
      },
    })
    return spawned as SpawnedCodex
  }

  private async collect(
    slot: AgentSlot,
    task: Task,
    spawned: SpawnedCodex,
    callbacks: { onProgress?(event: WorkerProgressEvent): void },
  ): Promise<{ threadId?: string; completion: WorkerCompletion }> {
    let threadId: string | undefined
    let usage: { tokens_in: number; tokens_out: number; source: UsageSource } = { tokens_in: 0, tokens_out: 0, source: 'measured' }
    let lastAgentText = ''
    spawned.onLine = (line) => {
      const event = parseCodexJsonlLine(line)
      if (event === undefined) return
      const tid = extractCodexThreadId(event)
      if (tid !== undefined) threadId = tid
      const extracted = extractCodexUsage(event)
      if (extracted !== undefined) usage = extracted
      const progress = codexJsonlToProgress(slot.id, task.id, event, this.clock())
      if (progress !== undefined) {
        if (progress.kind === 'text') lastAgentText = progress.text ?? ''
        callbacks.onProgress?.(progress)
      }
    }
    const exit = await spawned.exited
    // spawn 失败显式 failed(crash)：code=null 否则不落入任何故障分支，会被误判 done
    const fault = exit.spawnFailed ? 'crash' : exit.timedOut ? null : exit.code !== null && exit.code !== 0 ? 'crash' : null
    const report = extractCodexReport(lastAgentText)
    const exitKind = exit.spawnFailed ? 'failed' : exit.timedOut ? 'timeout' : fault === 'crash' ? 'failed' : 'done'
    // 失败根因（审计实证：codex API_KEY_GROUP_RESOLUTION_FAILED 只见 exit 1）：
    // lastAgentText 里的 ERROR JSON 行优先，其次 stderr 尾随
    let errorDetail: string | undefined
    if (exitKind === 'failed') {
      const errLine = lastAgentText.split('\n').reverse().find((l) => l.includes('ERROR') || l.includes('error'))
      errorDetail = (errLine !== undefined ? errLine : spawned.stderrTail.join(' | ')).slice(0, 400)
      if (errorDetail.length > 0 && /API_KEY|AUTH|401|403|resolution/i.test(errorDetail)) {
        errorDetail += '（检查 codex 登录/API 凭据：codex login 或 OPENAI_API_KEY 配置）'
      }
    }
    return {
      threadId,
      completion: {
        exit: exitKind,
        fault: fault ?? undefined,
        report,
        usage,
        artifacts: [],
        exit_code: exit.code ?? undefined,
        signal: exit.signal ?? undefined,
        ...(errorDetail !== undefined && errorDetail.length > 0 ? { error_detail: errorDetail } : {}),
      },
    }
  }

  async kill(handle: WorkerHandle): Promise<void> {
    // 树杀且跨平台：taskkill 仅 Windows 存在，此前 POSIX 上 ENOENT 被吞 = kill 静默 no-op
    await killTree(handle.pid)
  }
}

/** 从 codex 最终 agent_message 提取报告（复用 claude 的平衡 JSON 扫描逻辑）。 */
export function extractCodexReport(text: string): import('../core/types.js').MissionReport | undefined {
  return extractReport(text)
}
