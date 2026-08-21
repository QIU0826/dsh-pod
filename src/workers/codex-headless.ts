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

import { execFile, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { extractReport } from './claude-headless.js'
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
  onLine(line: string): void
  exited: Promise<{ code: number | null; signal: string | null; timedOut: boolean }>
  kill(): void
}

export interface CodexBackendOptions {
  spawner?: (binary: string, args: string[], options: { cwd: string }) => SpawnedCodex
  detectRunner?: { run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> }
  binary?: string
  clock?: () => number
}

/** 组装 codex exec 参数（W1 实证：resume 的 flag 必须放在 session_id 之前）。 */
export function buildCodexArgs(mode: CodexLaunchMode, prompt: string, worktree: string, model?: string): string[] {
  if (mode.kind === 'resume') {
    return ['exec', 'resume', '--json', mode.threadId, prompt]
  }
  const args = ['exec', prompt, '--json', '--color', 'never', '--skip-git-repo-check', '-s', 'read-only', '-C', worktree]
  if (model !== undefined && model.length > 0) args.push('-m', model)
  return args
}

export class CodexHeadlessBackend implements WorkerBackend {
  readonly vendor = 'codex' as const
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
    const prompt = `# 任务 ${task.id}：${task.title}\n${task.spec}\n\n完成后输出 MISSION_REPORT JSON（task_id/status/summary/files_changed/commit_sha/test_command/test_result/test_evidence/decisions/blockers/questions）。commit message 含 task-${task.id}。`
    const args = buildCodexArgs(mode, prompt, worktree, slot.model !== '' ? slot.model : undefined)
    const spawned = this.spawnCodex(args, worktree)
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
    const child = spawn(this.binary, args, { cwd, shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    // onLine 通过属性访问器路由进闭包：collect() 的赋值与 stdout 事件读同一个 handler。
    let lineHandler: (line: string) => void = () => {}
    const spawned = {
      pid: child.pid,
      exited: new Promise<{ code: number | null; signal: string | null; timedOut: boolean }>((resolve) => {
        let buffer = ''
        child.stdout?.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8')
          let index: number
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index)
            buffer = buffer.slice(index + 1)
            lineHandler(line)
          }
        })
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          child.kill()
        }, 60 * 60_000)
        child.on('exit', (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal, timedOut })
        })
      }),
      kill() {
        child.kill()
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
    const fault =
      exit.timedOut ? null : exit.code !== null && exit.code !== 0 ? 'crash' : null
    const report = extractCodexReport(lastAgentText)
    return {
      threadId,
      completion: {
        exit: exit.timedOut ? 'timeout' : fault === 'crash' ? 'failed' : 'done',
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
    if (handle.pid === undefined) return
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(handle.pid), '/T', '/F'], { windowsHide: true }, () => resolve())
    })
  }
}

/** 从 codex 最终 agent_message 提取报告（复用 claude 的平衡 JSON 扫描逻辑）。 */
export function extractCodexReport(text: string): import('../core/types.js').MissionReport | undefined {
  return extractReport(text)
}
