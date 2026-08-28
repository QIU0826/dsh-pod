/**
 * opencode-headless 后端 —— 方案书 3.2 节后端对照表 v0.3 扩展（Berd-G 管线：新 vendor = 新 adapter，零编排改动）。
 *
 * CLI 契约（sst/opencode `run` 子命令，本机未装——以下为公开文档契约 + fake 测试锁定）：
 *   - 非交互：opencode run [message..]（prompt 末位位置参数；亦支持 stdin 管道注入——P0 待真机实证，
 *     Windows 专项 CR-02：cmd /c 引号拼接对长中文 prompt 有破坏风险，故优先 stdin）
 *   - 模型：--model <provider/model>（slot.model 原样透传；留空走 opencode 默认）
 *   - 会话：--session <id> 续会话（session_ref）；transient 档每次新会话
 *   - 进度/完成：stdout 最终文本（无 JSONL 结构化事件流）；退出码非 0 = failed
 *   - usage：文本模式无结构化 token 上报 → usage_audit: false（tokens 0/unmeasured，CR-01-5 如实标注）
 *   - 真机首验清单：stdin 注入、--session 回传 id 的提取点、auth list 输出格式
 */

import { execFile, spawn } from 'node:child_process'
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

export type OpenCodeLaunchMode = { kind: 'new-run' } | { kind: 'resume'; sessionId: string }

export function resolveOpenCodeMode(slot: Pick<AgentSlot, 'session_tier' | 'session_ref'>): OpenCodeLaunchMode {
  // transient → 新会话；per-mission 且有 session_ref → --session 续接
  if (slot.session_tier === 'per-mission' && slot.session_ref !== undefined && slot.session_ref.length > 0) {
    return { kind: 'resume', sessionId: slot.session_ref }
  }
  return { kind: 'new-run' }
}

/** 二进制候选（Windows：宿主 PATH 滞后 → 家目录 .opencode 兜底，同 codex 模式）。 */
export function opencodeBinaryCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    return ['opencode', join(homedir(), '.opencode', 'bin', 'opencode.exe')]
  }
  return ['opencode']
}

export interface SpawnedOpenCode {
  pid?: number
  writeStdin(text: string): void
  exited: Promise<{ code: number | null; signal: string | null; timedOut: boolean }>
  kill(): void
}

export interface OpenCodeBackendOptions {
  spawner?: (binary: string, args: string[], options: { cwd: string }) => SpawnedOpenCode
  detectRunner?: { run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> }
  binary?: string
  clock?: () => number
}

/** 组装 opencode run 参数（prompt 走 stdin；--session 置于位置参数前）。 */
export function buildOpenCodeArgs(mode: OpenCodeLaunchMode, worktree: string, model?: string): string[] {
  const args = ['run', '-C', worktree]
  if (model !== undefined && model.length > 0) args.push('--model', model)
  if (mode.kind === 'resume') args.push('--session', mode.sessionId)
  return args
}

export class OpenCodeHeadlessBackend implements WorkerBackend {
  readonly vendor = 'opencode' as const
  readonly protocol = {
    family: 'headless-cli' as const,
    version: 'opencode run (stdin prompt, plain-text stdout)',
    capabilities: { kill: true, session_persist: false, structured_output: false, usage_audit: false },
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
      return { installed: false, authed: false, models: [], session_tiers: ['transient'], error: 'opencode not installed' }
    }
    // auth 探测：opencode auth list 列出已配置 provider（无 credentials 时输出空/报错）
    const auth = await this.detectRunner.run(this.binary, ['auth', 'list'])
    const authed = version.code === 0 && auth.code === 0
    return {
      installed: true,
      authed,
      models: [],
      version: version.stdout.trim(),
      session_tiers: ['transient'],
      error: authed ? undefined : 'opencode auth list empty (run `opencode auth login`)'
        + (auth.code !== 0 ? `: ${auth.stderr.slice(0, 120)}` : ''),
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
    // 复用统一任务简报（MISSION_REPORT schema 与 claude/codex 同契约）
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

  private spawnOpenCode(args: string[], cwd: string): SpawnedOpenCode {
    if (this.spawner !== undefined) return this.spawner(this.binary, args, { cwd })
    const child = spawn(this.binary, args, { cwd, shell: process.platform === 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    const spawned = {
      pid: child.pid,
      writeStdin(text: string) {
        child.stdin?.write(text, 'utf8')
        child.stdin?.end()
      },
      exited: new Promise<{ code: number | null; signal: string | null; timedOut: boolean }>((resolve) => {
        const consume = (chunk: Buffer): void => { output += chunk.toString('utf8') }
        child.stdout?.on('data', consume)
        child.stderr?.on('data', consume)
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
    // stdout 全量累计（纯文本流，无结构化事件）；collect 时整体提取 MISSION_REPORT。
    ;(spawned as SpawnedOpenCode & { __output(): string }).__output = () => output
    return spawned as SpawnedOpenCode
  }

  private async collect(
    slot: AgentSlot,
    task: Task,
    spawned: SpawnedOpenCode,
    callbacks: { onProgress?(event: WorkerProgressEvent): void },
  ): Promise<{ sessionId?: string; completion: WorkerCompletion }> {
    const exit = await spawned.exited
    const output = (spawned as SpawnedOpenCode & { __output(): string }).__output()
    // 进度：无事件流 → 起止两个事件（started / finished 文本截断）
    callbacks.onProgress?.({ slot_id: slot.id, task_id: task.id, ts: this.clock(), kind: 'system', text: `opencode run started (${task.id})` })
    const fault =
      exit.timedOut ? null : exit.code !== null && exit.code !== 0 ? 'crash' : null
    const report = extractReport(output)
    if (report !== undefined) {
      callbacks.onProgress?.({ slot_id: slot.id, task_id: task.id, ts: this.clock(), kind: 'text', text: output.slice(-2000) })
    }
    const usage: { tokens_in: number; tokens_out: number; source: UsageSource } = { tokens_in: 0, tokens_out: 0, source: 'unavailable' }
    return {
      sessionId: undefined,
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

/** 从 opencode 最终文本提取报告（复用 claude 的平衡 JSON 扫描）。 */
export function extractOpenCodeReport(text: string): import('../core/types.js').MissionReport | undefined {
  return extractReport(text)
}
