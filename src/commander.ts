/**
 * Commander 会话创建 —— 方案书 3.3 节（CR-01-1 的落地，官方 SDK 实证）：
 *
 *   - ctx.agents.create({ sessionId, meta: { cwd, agentPreset }, setup }) 程序化建会话；
 *   - setup(agentCtx) 在会话/agent 发布前组合作用域世界：pod_* 工具经 agentCtx.tools.register
 *     注册进该 commander agent 的 scope（3.3 节「工具只注册在 commander 会话」的官方正解，
 *     dsh-tools「register globally or in the calling agent scope」+ agent.ctx 作用域）；
 *   - 首条消息（mission goal）经 agent.followup 驱动（创建后驱动，setup 只组合不驱动）。
 *
 * 原始事件纪律（3.3 节不变量 2）：commander 的会话日志与 Pod 的 store 事件流分离，
 * 编排状态以磁盘为唯一事实源，可随时重建。
 */

import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { makePodTools } from './pod-tools.js'
import type { PodService } from './pod-service.js'

export interface CommanderSession {
  sessionId: string
  agent: Agent
  /** 停止并回收 commander 会话（循环退出 + 注销 + 移除 session + 拆除作用域）。 */
  dispose(): Promise<void>
}

export interface CommanderDeps {
  /** ctx.agents（宿主 AgentRegistry；创建工厂由 dsh-agent-loop 提供）。 */
  agents: Pick<AgentRegistry, 'create'>
  service: PodService
  sessionId: string
  cwd: string
  goal: string
  /** 可选专用 agent preset（如 pod-commander）；缺省走部署默认。 */
  agentPreset?: string
}

/** 创建 commander 会话并在其作用域内注册 pod_* 工具，然后以 goal 驱动。 */
export async function createCommanderSession(deps: CommanderDeps): Promise<CommanderSession> {
  const handle = await deps.agents.create({
    sessionId: deps.sessionId as SessionId,
    meta: { cwd: deps.cwd, agentPreset: deps.agentPreset },
    setup: (agentCtx: Context) => {
      // 3.3 节工具作用域：经 agentCtx 注册 → 只进 commander agent 的 scope 层。
      // 注册 disposer 归该作用域所有：agent dispose 时自动拆除（scoped world unwind），
      // setup 只组合不驱动，不返回 commit。
      const { tools } = makePodTools(deps.service)
      for (const tool of tools) agentCtx.tools.register(tool)
    },
  })
  handle.agent.followup(makeGoalMessage(deps.goal))
  return {
    sessionId: deps.sessionId,
    agent: handle.agent,
    dispose: () => handle.dispose(),
  }
}

/** mission goal 的 plugin 来源用户消息（消息源可追溯，durable 日志留痕）。 */
export function makeGoalMessage(goal: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: goal }],
    source: { kind: 'plugin', plugin: 'dsh-pod', form: 'notice', summary: 'mission goal' },
  })
}
