/**
 * opencode-headless 后端 —— 方案书 3.2 节后端对照表 v0.3（Berd-G 管线：新 vendor = 新 adapter，零编排改动）。
 *
 * 真机实证（opencode-ai 1.18.24，2026-08-28，Windows / GLM-5.3-Flash 经 OpenAI 兼容端点）：
 *   - 非交互：`opencode run` + prompt 走 stdin（实测支持；位置参数亦可，stdin 与 claude/codex 同纪律规避 CR-02 argv 风险）
 *   - `--dir <worktree>` 必须显式：cwd 会被 opencode 项目根探测忽略（实证：任务落到宿主仓库根）
 *   - `--format json`：JSONL 事件流（step_start/text/step_finish），sessionID 在每个事件顶层，
 *     usage 在 step_finish.part.tokens（input/output 实测）→ usage_audit: true
 *   - 会话：`-s/--session <id>` 续会话；transient 档每次新会话
 *   - auth：`opencode auth list` 0 credentials → authed=false（指引 auth login / 配置文件 provider）
 *   - Windows 安装布局：npm 全局包自带 bin/opencode.exe（postinstall 下载平台子包），
 *     PATH shim 可能缺失 → 二进制候选含 node_modules 实路径
 */

import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { killTree } from './kill-tree.js'
import { assertSafeArgvPath, assertSafeArgvToken } from './argv-guard.js'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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

export type OpenCodeLaunchMode = { kind: 'new-run' } | { kind: 'resume'; sessionId: string }

export function resolveOpenCodeMode(slot: Pick<AgentSlot, 'session_tier' | 'session_ref'>): OpenCodeLaunchMode {
  // transient → 新会话；per-mission 且有 session_ref → --session 续接
  if (slot.session_tier === 'per-mission' && slot.session_ref !== undefined && slot.session_ref.length > 0) {
    return { kind: 'resume', sessionId: slot.session_ref }
  }
  return { kind: 'new-run' }
}

/** 二进制候选（Windows：PATH shim 可能缺失 → npm 全局包内 exe 兜底，实证 1.18.24 布局）。 */
export function opencodeBinaryCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    return [
      'opencode',
      join(homedir(), '.opencode', 'bin', 'opencode.exe'),
      join(dirname(process.execPath), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
    ]
  }
  return ['opencode']
}

export interface SpawnedOpenCode {
  pid?: number
  onLine(line: string): void
  writeStdin(text: string): void
  exited: Promise<{ code: number | null; signal: string | null; timedOut: boolean; spawnFailed?: boolean }>
  kill(): void
}

export interface OpenCodeBackendOptions {
  spawner?: (binary: string, args: string[], options: { cwd: string }) => SpawnedOpenCode
  detectRunner?: { run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> }
  binary?: string
  clock?: () => number
}

/**
 * 组装 opencode run 参数（真机实证 1.18.24）。
 * prompt 走 stdin（短固定 argv）；--dir 显式指定 worktree（cwd 探测不可靠，实证）。
 */
export function buildOpenCodeArgs(mode: OpenCodeLaunchMode, worktree: string, model?: string): string[] {
  // P1 注入面收口：--dir / --model / --session 均为运行期动态值（虽走 shell:false，统一纪律）
  assertSafeArgvPath('opencode worktree', worktree)
  assertSafeArgvToken('opencode model', model)
  if (mode.kind === 'resume') assertSafeArgvToken('opencode sessionId', mode.sessionId)
  const args = ['run', '--dir', worktree, '--format', 'json']
  if (model !== undefined && model.length > 0) args.push('--model', model)
  if (mode.kind === 'resume') args.push('--session', mode.sessionId)
  return args
}

/** JSONL 行容错解析（日志/告警行混入 stdout 时跳过）。 */
export function parseOpenCodeJsonlLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.replace(/^\uFEFF/, '').trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** sessionID：opencode 每个事件顶层都带（--session 续会话的钥匙）。 */
export function extractOpenCodeSessionId(event: Record<string, unknown>): string | undefined {
  return typeof event.sessionID === 'string' ? event.sessionID : undefined
}

/** step_finish.part.tokens → usage 实测（CR-01-5 同款纪律）。 */
export function extractOpenCodeUsage(event: Record<string, unknown>): { tokens_in: number; tokens_out: number; source: UsageSource } | undefined {
  if (event.type !== 'step_finish') return undefined
  const part = event.part as { tokens?: { input?: number; output?: number } } | undefined
  const tokens = part?.tokens
  if (tokens === undefined) return undefined
  return { tokens_in: tokens.input ?? 0, tokens_out: tokens.output ?? 0, source: 'measured' }
}

/** step_finish 是 opencode 的回合终结事件（exit 判定的结构化佐证）。 */
export function isOpenCodeStepFinish(event: Record<string, unknown>): boolean {
  return event.type === 'step_finish'
}

export class OpenCodeHeadlessBackend implements WorkerBackend {
  readonly vendor = 'opencode' as const
  readonly protocol = {
    family: 'headless-cli' as const,
    version: 'opencode run --format json (1.18.24 实证)',
    capabilities: { kill: true, session_persist: false, structured_output: true, usage_audit: true },
  }
  private readonly spawner?: OpenCodeBackendOptions['spawner']
  private readonly detectRunner: NonNullable<OpenCodeBackendOptions['detectRunner']>
  private readonly binary: string
  private readonly clock: () => number

  constructor(options: OpenCodeBackendOptions = {}) {
    this.spawner = options.spawner
    this.binary = options.binary ?? 'opencode'
    this.clock = options.clock ?? (() => Date.now())
    this.detectRunner = options.detectRunner ?? execCommandRunner
  }

  async detect(): Promise<Awaited<ReturnType<WorkerBackend['detect']>>> {
    const version = await this.detectRunner.run(this.binary, ['--version'])
    if (version.code !== 0) {
      // 逐候选兜底（npm 全局包内 exe）
      for (const candidate of opencodeBinaryCandidates().slice(1)) {
        const retry = await this.detectRunner.run(candidate, ['--version'])
        if (retry.code === 0) {
          return this.detectAuth(candidate, retry.stdout.trim())
        }
      }
      return { installed: false, authed: false, models: [], session_tiers: ['transient'], error: 'opencode not installed' }
    }
    return this.detectAuth(this.binary, version.stdout.trim())
  }

  private async detectAuth(binary: string, version: string): Promise<Awaited<ReturnType<WorkerBackend['detect']>>> {
    const auth = await this.detectRunner.run(binary, ['auth', 'list'])
    const hasCredentials = /\d+\s+credentials|provider/i.test(auth.stdout) && !/0 credentials/.test(auth.stdout)
    return {
      installed: true,
      authed: hasCredentials,
      models: [],
      version,
      session_tiers: ['transient'],
      error: hasCredentials ? undefined : 'opencode auth list 0 credentials（opencode auth login 或配置 provider）',
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
    const mode = resolveOpenCodeMode(slot)
    const prompt = buildTaskPrompt({ task, worktreePath: worktree })
    const args = buildOpenCodeArgs(mode, worktree, slot.model !== '' ? slot.model : undefined)
    const spawned = this.spawnOpenCode(args, worktree)
    spawned.writeStdin(prompt)
    const handle: WorkerHandle = { pid: spawned.pid }
    const session = this.collect(slot, task, spawned, callbacks)
    session.then(({ sessionId, completion }) => {
      handle.session_ref = sessionId
      callbacks.onExit?.(completion)
    })
    return handle
  }

  private spawnOpenCode(args: string[], cwd: string): SpawnedOpenCode & { onLine(line: string): void } {
    if (this.spawner !== undefined) return this.spawner(this.binary, args, { cwd })
    // 真 .exe → shell:false（无 cmd 引号破坏面）；PATH shim 缺失时由 detect 候选解析出全路径传入
    const child = spawn(this.binary, args, {
      cwd,
      windowsHide: true,
      // POSIX 建独立进程组：killTree 可组杀孙进程（Windows 走 taskkill /T）
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // StringDecoder（2026-09-05）：管道按字节切块，CJK 多字节字符跨块边界时
    // 逐块 toString 产出 U+FFFD → JSONL 解析静默失败。decoder 跨块拼接后再解码。
    let buffer = ''
    const decoder = new StringDecoder('utf8')
    let lineHandler: (line: string) => void = () => {}
    const spawned = {
      pid: child.pid,
      writeStdin(text: string) {
        const stdin = child.stdin
        if (stdin === null) return
        // 对端提前关闭时写入报 EPIPE：吞掉（exit/error 路径接管），绝不炸宿主
        stdin.on('error', () => {})
        stdin.write(text, 'utf8')
        stdin.end()
      },
      exited: new Promise<{ code: number | null; signal: string | null; timedOut: boolean; spawnFailed: boolean }>((resolve) => {
        const consume = (chunk: Buffer): void => {
          buffer += decoder.write(chunk)
          let index: number
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index)
            buffer = buffer.slice(index + 1)
            lineHandler(line)
          }
        }
        child.stdout?.on('data', consume)
        child.stderr?.on('data', consume)
        // 残尾冲刷：无换行的最后一行不能丢
        child.on('close', () => {
          const rest = buffer + decoder.end()
          buffer = ''
          if (rest.length > 0) lineHandler(rest)
        })
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          // 树杀：仅杀直接子进程会留下 CLI 孙进程继续烧 token
          void killTree(child.pid)
        }, 60 * 60_000)
        // spawn 失败（ENOENT/EPERM，PATH shim 缺失时高发）：无 error 监听 = uncaught exception 炸宿主；
        // 且 exit 不触发——必须在此 resolve 并标记 spawnFailed，否则悬挂到超时误分类 timeout
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
    return spawned as SpawnedOpenCode & { onLine(line: string): void }
  }

  private async collect(
    slot: AgentSlot,
    task: Task,
    spawned: SpawnedOpenCode,
    callbacks: { onProgress?(event: WorkerProgressEvent): void },
  ): Promise<{ sessionId?: string; completion: WorkerCompletion }> {
    let sessionId: string | undefined
    let usage: { tokens_in: number; tokens_out: number; source: UsageSource } = { tokens_in: 0, tokens_out: 0, source: 'unavailable' }
    let lastText = ''
    spawned.onLine = (line) => {
      const event = parseOpenCodeJsonlLine(line)
      if (event === undefined) return
      const sid = extractOpenCodeSessionId(event)
      if (sid !== undefined) sessionId = sid
      const extracted = extractOpenCodeUsage(event)
      if (extracted !== undefined) {
        usage = extracted
      }
      if (event.type === 'text') {
        const part = event.part as { text?: string } | undefined
        if (typeof part?.text === 'string' && part.text.length > 0) {
          lastText = part.text
          callbacks.onProgress?.({ slot_id: slot.id, task_id: task.id, ts: this.clock(), kind: 'text', text: part.text.slice(0, 2000) })
        }
      }
    }
    const exit = await spawned.exited
    // spawn 失败显式 failed(crash)：code=null 否则不落入任何故障分支，会被误判 done
    const fault = exit.spawnFailed ? 'crash' : exit.timedOut ? null : exit.code !== null && exit.code !== 0 ? 'crash' : null
    const report = extractReport(lastText)
    return {
      sessionId,
      completion: {
        exit: exit.spawnFailed ? 'failed' : exit.timedOut ? 'timeout' : fault === 'crash' ? 'failed' : 'done',
        fault: fault ?? undefined,
        report,
        usage,
        artifacts: [],
        exit_code: exit.code ?? undefined,
        signal: exit.signal ?? undefined,
      },
    }
  }

  async kill(handle: WorkerHandle): Promise<void> {
    // 树杀且跨平台：taskkill 仅 Windows 存在，此前 POSIX 上 ENOENT 被吞 = kill 静默 no-op
    await killTree(handle.pid)
  }
}

/** 从 opencode 最终文本提取报告（复用 claude 的平衡 JSON 扫描）。 */
export function extractOpenCodeReport(text: string): import('../core/types.js').MissionReport | undefined {
  return extractReport(text)
}
