/**
 * MCP 双向暴露 —— 方案书 594/797 行 + docs/mcp-bidirectional.md（v0.3 实现切片）。
 *
 * 把 Pod 暴露为 MCP server：Claude Code / Codex 等外部 agent 可反向驱动 Pod。
 *   - 工具面 = pod_* 工具（复用 PodService，零新编排逻辑）
 *   - 审批/合并仍只走原代码入口（架构不变量 3：MCP 是传输层包装，不新增绕过通道）
 *   - 默认 stdio transport（Claude Code `claude mcp add` 最易验证）；SSE 属后续
 *   - 鉴权：stdio 由宿主导航拉起（进程边界即信任面）；SSE 需 loopback + 显式启用（未实现）
 *
 * ADOL P2-1：`toolListing: 'short'` 时 tools/list 只回 name+一句话+tag（`{}` 入参），
 * 完整 JSON Schema 走 `pod_expand_tool` 按需展开（默认仍 full，向后兼容，MCP 客户端无感）。
 * 共享 schema 片段统一收敛在 `src/core/mcp-schema.ts`（schema 去重单一源）。
 *
 * 用法（宿主内）：
 *   import { makeMcpServer } from './mcp-server.js'
 *   const server = makeMcpServer(service)
 *   await server.connect(new StdioServerTransport())
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { PodService } from './pod-service.js'
import type { PlanTaskInput, SlotInput } from './core/orchestrator.js'
import {
  TOOL_BRIEFS,
  approvalIdSchema,
  planTaskShape,
  slotIdSchema,
  slotShape,
  taskTypeEnum,
} from './core/mcp-schema.js'

export interface McpServerOptions {
  /**
   * 工具清单模式（ADOL tools/list --short）：
   *   - 'full'（默认）：完整 JSON Schema（标准 MCP，客户端直接可用）；
   *   - 'short'：只回 name + 一句话 + tag，入参 schema 置空 `{}`，完整 schema 由
   *     `pod_expand_tool` 按需展开（省一次性连接的下发字节）。
   */
  toolListing?: 'full' | 'short'
}

/** defineTool/registerTool 的 args 泛型来自入参 schema；short 模式下入参被置空，入口显式收窄（薄壳边界）。 */
function castArgs<T>(args: unknown): T {
  return args as T
}

interface LaunchArgs {
  name: string
  goal: string
  cwd: string
  budget_usd?: number
  tenets?: string[]
  approval_mode?: number
  slots: SlotInput[]
  plan?: PlanTaskInput[]
}

interface SteerArgs {
  slot_id: string
  instruction: string
}

interface ApproveArgs {
  approval_id: string
  edited?: Record<string, string>
  remember_rule?: boolean
}

interface DenyArgs {
  approval_id: string
  reason: string
}

interface PlanArgs {
  action: 'list' | 'add' | 'replan'
  tasks?: Array<{ id: string; title: string; spec: string; type: string; skill_tags?: string[]; depends_on?: string[] }>
  reason?: string
}

interface AbortArgs {
  reason?: string
}

/**
 * 构造 MCP server：把 pod_* 工具面映射为 MCP tools。
 * 入参/输出为结构化 JSON（对齐 pod_* 工具 schema）；薄壳调用 service。
 */
export function makeMcpServer(service: PodService, opts: McpServerOptions = {}): McpServer {
  const short = opts.toolListing === 'short'
  const server = new McpServer({ name: 'dsh-pod', version: '0.3.0-mcp' })

  // 完整入参 schema 的单一源（供 short 模式下 pod_expand_tool 展开；full 模式直接注册）。
  const fullShapes: Record<string, z.ZodRawShape> = {
    pod_launch: {
      name: z.string().describe('mission 名称'),
      goal: z.string().describe('一句话可验收目标'),
      cwd: z.string().describe('目标 git 仓库绝对路径（主树）'),
      budget_usd: z.number().optional().describe('美元预算上限（默认 3）'),
      tenets: z.array(z.string()).optional().describe('团队宗旨（3-5 条 do/prioritize 价值观锚点；派发时注入每个任务 spec）'),
      approval_mode: z.number().optional().describe('审批模式 1（默认）/2/3（后两者需 experiments 灰度开启）'),
      slots: z.array(slotShape).describe('员工名册'),
      plan: z.array(planTaskShape(taskTypeEnum)).optional().describe('任务 DAG'),
    },
    pod_status: {},
    pod_dispatch: {},
    pod_steer: { slot_id: slotIdSchema, instruction: z.string() },
    pod_approve: {
      approval_id: approvalIdSchema,
      edited: z.record(z.string(), z.string()).optional().describe('人工编辑参数（如 { merge_note: "…" }）'),
      remember_rule: z.boolean().optional().describe('是否生成同类免弹卡规则（默认 true）'),
    },
    pod_deny: { approval_id: approvalIdSchema, reason: z.string() },
    pod_pause: {},
    pod_resume: {},
    pod_plan: {
      action: z.enum(['list', 'add', 'replan']),
      tasks: z.array(planTaskShape(z.enum(['implement', 'review', 'test', 'doc', 'research']))).optional(),
      reason: z.string().optional(),
    },
    pod_abort: { reason: z.string().optional() },
  }

  const inputOf = (name: string): z.ZodRawShape => (short ? {} : fullShapes[name] ?? {})

  // ── pod_launch：发起 mission（含 plan DAG）──
  server.registerTool(
    'pod_launch',
    {
      description: '启动一个 Pod mission（多智能体任务书）：创建 mission 与员工名册，按计划任务 DAG 后台驱动 → 实现 → 独立 review（质量门）→ 审批卡。',
      inputSchema: inputOf('pod_launch'),
    },
    async (args) => {
      const input = castArgs<LaunchArgs>(args)
      const mission = service.launch({
        name: input.name, goal: input.goal, cwd: input.cwd,
        budgetUsd: input.budget_usd ?? 3,
        tenets: input.tenets,
        approvalMode: input.approval_mode === 2 || input.approval_mode === 3 ? input.approval_mode : 1,
        slots: input.slots,
        plan: input.plan,
      })
      return { content: [{ type: 'text', text: JSON.stringify({ mission_id: mission.id, status: mission.status, goal: mission.goal }) }] }
    },
  )

  // ── pod_status：看板/员工/审批卡/账本快照 ──
  server.registerTool(
    'pod_status',
    { description: '当前 mission 快照：任务看板、员工状态灯、审批卡、账本（只读）。', inputSchema: inputOf('pod_status') },
    async () => {
      const s = service.status()
      return { content: [{ type: 'text', text: JSON.stringify({ mission: s.mission ?? null, tasks: s.tasks, slots: s.slots, pendingApprovals: s.pendingApprovals, ledgerTail: service.ledgerTail() }) }] }
    },
  )

  // ── pod_dispatch：手动派发（commander 降级）──
  server.registerTool(
    'pod_dispatch',
    { description: '手动派发下一个就绪任务（commander 异常降级用）。', inputSchema: inputOf('pod_dispatch') },
    async () => {
      const dispatched = await service.dispatchNext()
      return { content: [{ type: 'text', text: JSON.stringify({ dispatched }) }] }
    },
  )

  // ── pod_steer：排队指令 ──
  server.registerTool(
    'pod_steer',
    { description: '向员工排队指令（下次派单必带，不打断进行中进程）。', inputSchema: inputOf('pod_steer') },
    async (args) => {
      const input = castArgs<SteerArgs>(args)
      service.steer(input.slot_id, input.instruction)
      return { content: [{ type: 'text', text: JSON.stringify({ queued: true, slot_id: input.slot_id }) }] }
    },
  )

  // ── pod_approve：裁决审批卡（合并唯一放行入口）──
  server.registerTool(
    'pod_approve',
    {
      description: '批准合并（mission 进入 done）。合并回主树唯一放行入口；deny 用 pod_deny。',
      inputSchema: inputOf('pod_approve'),
    },
    async (args) => {
      const input = castArgs<ApproveArgs>(args)
      const result = await service.approve(input.approval_id, 'mcp', input.edited, input.remember_rule !== false)
      if (!result.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({ decided: false, message: result.message, conflict: result.conflict }) }], isError: true }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ decided: true, merge_commit: result.mergeCommit.slice(0, 8) }) }] }
    },
  )

  // ── pod_deny：驳回审批卡 ──
  server.registerTool(
    'pod_deny',
    { description: '驳回审批卡（mission 回 running，可补任务重跑）。', inputSchema: inputOf('pod_deny') },
    async (args) => {
      const input = castArgs<DenyArgs>(args)
      service.deny(input.approval_id, 'mcp', input.reason)
      return { content: [{ type: 'text', text: JSON.stringify({ decided: true, approval_id: input.approval_id }) }] }
    },
  )

  // ── pod_pause / pod_resume：生命周期 ──
  server.registerTool('pod_pause', { description: '暂停当前 mission（状态磁盘化，可恢复）。', inputSchema: inputOf('pod_pause') }, async () => {
    service.pauseMission()
    return { content: [{ type: 'text', text: JSON.stringify({ paused: true }) }] }
  })
  server.registerTool('pod_resume', { description: '恢复已暂停的 mission。', inputSchema: inputOf('pod_resume') }, async () => {
    service.resumeMission()
    return { content: [{ type: 'text', text: JSON.stringify({ resumed: true }) }] }
  })

  // ── pod_plan：规划层工具面（P1：list / add / replan）──
  server.registerTool('pod_plan', {
    description: '规划层操作：list 查看任务 DAG；add 追加任务节点（同一代码裁决）；replan 有界重规划（上限 2 次 + 预算门控）。',
    inputSchema: inputOf('pod_plan'),
  }, async (args) => {
    const input = castArgs<PlanArgs>(args)
    try {
      if (input.action === 'list') {
        const st = service.status()
        return { content: [{ type: 'text', text: JSON.stringify({ tasks: st.tasks.map((t) => ({ id: t.id, type: t.type, status: t.status, depends_on: t.depends_on })), planner: service.hasPlannerCapability(), replanRemaining: service.replanRemaining() }) }] }
      }
      if (input.action === 'add') {
        const created = service.addPlanTasks((input.tasks ?? []).map((t) => ({ ...t, type: t.type as PlanTaskInput['type'], skill_tags: t.skill_tags ?? [], depends_on: t.depends_on ?? [] })))
        return { content: [{ type: 'text', text: JSON.stringify({ added: created.map((t) => t.id) }) }] }
      }
      const r = service.requestReplan(input.reason ?? 'replan via mcp')
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }] }
    }
  })

  // ── pod_abort：终止 ──
  server.registerTool('pod_abort', { description: '中止当前 mission（终态，不可恢复）。', inputSchema: inputOf('pod_abort') }, async (args) => {
    const input = castArgs<AbortArgs>(args)
    service.abort(input.reason ?? 'aborted via mcp')
    return { content: [{ type: 'text', text: JSON.stringify({ aborted: true }) }] }
  })

  // ── pod_expand_tool：P0-1 按需展开元工具（ADOL --short 的展开通道）──
  server.registerTool(
    'pod_expand_tool',
    { description: '展开某个 pod_* 工具的完整参数 schema（不在当前阶段全量清单里时，先点名展开再调用）。', inputSchema: { name: z.enum(Object.keys(TOOL_BRIEFS) as [string, ...string[]]) } },
    (args) => {
      const name = castArgs<{ name: string }>(args).name
      const brief = TOOL_BRIEFS[name]
      if (brief === undefined) return { content: [{ type: 'text', text: JSON.stringify({ name, brief: '', tag: '', params: {} }) }] }
      if (short) {
        // short 模式：完整 JSON Schema 只在被点名展开时才下发（ADOL「展开时才给完整 schema」）
        const shape = fullShapes[name]
        const params = shape !== undefined ? z.toJSONSchema(z.object(shape)) : {}
        return { content: [{ type: 'text', text: JSON.stringify({ name, brief: brief.brief, tag: brief.tag, params }) }] }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ name, brief: brief.brief, tag: brief.tag, note: '完整 schema 由对应工具的 tools/list 返回；此处给一句话用途与存在性确认。' }) }] }
    },
  )

  return server
}
