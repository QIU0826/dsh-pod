/**
 * dsh-subagent 后端 —— 方案书 3.2 节后端对照表（W2 三 worker 后端之一）。
 *
 * DSH 原生 subagent 会话承载任务（非"零开发"：start/onProgress/kill 映射）：
 *   - start：宿主 agent 工厂创建独立会话 → 发送 goal（任务简报）→ 收集消息（事件流）
 *   - 进度：收集到的 assistant 消息转发为 text 进度事件（事件总线语义）
 *   - 完成：消息流结束 → 从最终消息提取 MISSION_REPORT（复用 report-schema）
 *   - kill：dispose 会话（无进程句柄，幂等）
 *
 * agentFactory 可选注入（宿主无 agent-loop 工厂时 detect 如实报告未安装，名册灰掉）；
 * 测试注入 fake，不依赖真实宿主。
 */

import type { AgentSlot, Task, WorkerBackend, WorkerCompletion, WorkerHandle, WorkerProgressEvent } from '../core/types.js'
import { extractReport } from './claude-headless.js'
import { validateMissionReport } from '../core/report-schema.js'

export interface DshAgentMessage {
  id: string
  role: 'assistant' | 'user' | string
  content: string
}

/** 宿主 agent 工厂（插件层注入；形态仿 ctx.agents.create + followup + 消息读取）。 */
export interface DshAgentFactory {
  createSession(): Promise<{ sessionId: string }>
  sendGoal(sessionId: string, goal: string): Promise<void>
  collectMessages(sessionId: string): Promise<DshAgentMessage[]>
  disposeSession(sessionId: string): Promise<void>
}

export interface DshSubagentOptions {
  agentFactory?: DshAgentFactory
  clock?: () => number
}

export class DshSubagentBackend implements WorkerBackend {
  readonly vendor = 'dsh' as const
  private readonly agentFactory: DshAgentFactory | undefined
  private readonly clock: () => number

  constructor(options: DshSubagentOptions = {}) {
    this.agentFactory = options.agentFactory
    this.clock = options.clock ?? (() => Date.now())
  }

  async detect(): Promise<Awaited<ReturnType<WorkerBackend['detect']>>> {
    if (this.agentFactory === undefined) {
      return { installed: false, authed: false, models: [], session_tiers: ['transient'], error: 'no dsh agent factory (host agent-loop unavailable)' }
    }
    return { installed: true, authed: true, models: [], session_tiers: ['transient'] }
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
    if (this.agentFactory === undefined) {
      throw new Error('dsh-subagent backend has no agent factory (host agent-loop unavailable)')
    }
    const { sessionId } = await this.agentFactory.createSession()
    const handle: WorkerHandle = { session_ref: sessionId }

    // 异步驱动：发送 goal → 收集消息 → 完成信号（不阻塞 start 返回，进程语义等价）
    void this.agentFactory
      .sendGoal(sessionId, buildDshGoal(task, worktree))
      .then(() => this.agentFactory!.collectMessages(sessionId))
      .then((messages) => {
        for (const message of messages) {
          callbacks.onProgress?.({
            slot_id: slot.id,
            task_id: task.id,
            ts: this.clock(),
            kind: 'text',
            text: message.content,
          })
        }
        // 完成判定：消息流结束 + 最终消息含合法报告（复用 claude 的提取与 schema 校验）
        const last = messages.length > 0 ? messages[messages.length - 1]!.content : ''
        const report = extractReport(last)
        const structural = report !== undefined ? validateMissionReport(report) : undefined
        const completion: WorkerCompletion = {
          exit: structural?.ok === true ? 'done' : 'failed',
          fault: structural?.ok === true ? undefined : 'silent_failure',
          report: structural?.ok === true ? report : undefined,
          usage: { tokens_in: 0, tokens_out: 0, source: 'unavailable' },
          artifacts: [],
        }
        callbacks.onExit?.(completion)
      })
      .catch((error) => {
        callbacks.onExit?.({
          exit: 'failed',
          fault: 'crash',
          usage: { tokens_in: 0, tokens_out: 0, source: 'unavailable' },
          artifacts: [],
        })
        void error
      })

    return handle
  }

  async kill(_handle: WorkerHandle): Promise<void> {
    // DSH 会话无进程句柄：dispose 由宿主回收；kill 为幂等 no-op
    if (this.agentFactory !== undefined && _handle.session_ref !== undefined) {
      await this.agentFactory.disposeSession(_handle.session_ref)
    }
  }
}

/** dsh 任务的 goal 消息（任务简报 + 工作目录限定 + 报告契约）。 */
export function buildDshGoal(task: Task, worktree: string): string {
  return [
    `# 任务 ${task.id}：${task.title}`,
    '',
    `## 工作目录（限定）\n${worktree}`,
    '',
    `## 任务简报\n${task.spec}`,
    '',
    '完成后输出 MISSION_REPORT（JSON，字段见报告契约）。禁止合并主树、禁止改动任务范围外文件。',
  ].join('\n')
}
