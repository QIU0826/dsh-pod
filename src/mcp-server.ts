/**
 * MCP 双向暴露 —— 方案书 594/797 行 + docs/mcp-bidirectional.md（v0.3 实现切片）。
 *
 * 把 Pod 暴露为 MCP server：Claude Code / Codex 等外部 agent 可反向驱动 Pod。
 *   - 工具面 = pod_* 工具（复用 PodService，零新编排逻辑）
 *   - 审批/合并仍只走原代码入口（架构不变量 3：MCP 是传输层包装，不新增绕过通道）
 *   - 默认 stdio transport（Claude Code `claude mcp add` 最易验证）；SSE 属后续
 *   - 鉴权：stdio 由宿主导航拉起（进程边界即信任面）；SSE 需 loopback + 显式启用（未实现）
 *
 * 用法（宿主内）：
 *   import { makeMcpServer } from './mcp-server.js'
 *   const server = makeMcpServer(service)
 *   await server.connect(new StdioServerTransport())
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { PodService } from './pod-service.js'

/**
 * 构造 MCP server：把 pod_* 工具面映射为 MCP tools。
 * 入参/输出为结构化 JSON（对齐 pod_* 工具 schema）；薄壳调用 service。
 */
export function makeMcpServer(service: PodService): McpServer {
  const server = new McpServer({ name: 'dsh-pod', version: '0.3.0-mcp' })

  // ── pod_launch：发起 mission（含 plan DAG）──
  server.registerTool(
    'pod_launch',
    {
      description: '启动一个 Pod mission（多智能体任务书）：创建 mission 与员工名册，按计划任务 DAG 后台驱动 → 实现 → 独立 review（质量门）→ 审批卡。',
      inputSchema: {
        name: z.string().describe('mission 名称'),
        goal: z.string().describe('一句话可验收目标'),
        cwd: z.string().describe('目标 git 仓库绝对路径（主树）'),
        budget_usd: z.number().optional().describe('美元预算上限（默认 3）'),
        approval_mode: z.number().optional().describe('审批模式 1（默认）/2/3（后两者需 experiments 灰度开启）'),
        slots: z.array(z.object({
          id: z.string(), vendor: z.enum(['claude', 'codex', 'dsh', 'ark']), role: z.string(),
          capabilities: z.array(z.string()), model: z.string().optional(),
        })).describe('员工名册'),
        plan: z.array(z.object({
          id: z.string(), title: z.string(), spec: z.string(),
          type: z.enum(['implement', 'review', 'plan', 'test', 'doc', 'research']),
          skill_tags: z.array(z.string()).optional(), depends_on: z.array(z.string()).optional(),
        })).optional().describe('任务 DAG'),
      },
    },
    async (args) => {
      const mission = service.launch({
        name: args.name, goal: args.goal, cwd: args.cwd,
        budgetUsd: args.budget_usd ?? 3,
        approvalMode: args.approval_mode === 2 || args.approval_mode === 3 ? args.approval_mode : 1,
        slots: args.slots,
        plan: args.plan,
      })
      return { content: [{ type: 'text', text: JSON.stringify({ mission_id: mission.id, status: mission.status, goal: mission.goal }) }] }
    },
  )

  // ── pod_status：看板/员工/审批卡/账本快照 ──
  server.registerTool(
    'pod_status',
    { description: '当前 mission 快照：任务看板、员工状态灯、审批卡、账本（只读）。', inputSchema: z.object({}) },
    async () => {
      const s = service.status()
      return { content: [{ type: 'text', text: JSON.stringify({ mission: s.mission ?? null, tasks: s.tasks, slots: s.slots, pendingApprovals: s.pendingApprovals, ledgerTail: service.ledgerTail() }) }] }
    },
  )

  // ── pod_dispatch：手动派发（commander 降级）──
  server.registerTool(
    'pod_dispatch',
    { description: '手动派发下一个就绪任务（commander 异常降级用）。', inputSchema: z.object({}) },
    async () => {
      const dispatched = await service.dispatchNext()
      return { content: [{ type: 'text', text: JSON.stringify({ dispatched }) }] }
    },
  )

  // ── pod_steer：排队指令 ──
  server.registerTool(
    'pod_steer',
    {
      description: '向员工排队指令（下次派单必带，不打断进行中进程）。',
      inputSchema: { slot_id: z.string(), instruction: z.string() },
    },
    async (args) => {
      service.steer(args.slot_id, args.instruction)
      return { content: [{ type: 'text', text: JSON.stringify({ queued: true, slot_id: args.slot_id }) }] }
    },
  )

  // ── pod_approve：裁决审批卡（合并唯一放行入口）──
  server.registerTool(
    'pod_approve',
    {
      description: '批准合并（mission 进入 done）。合并回主树唯一放行入口；deny 用 pod_deny。',
      inputSchema: {
        approval_id: z.string().describe('pod_status 给出的审批卡 id'),
        edited: z.record(z.string(), z.string()).optional().describe('人工编辑参数（如 { merge_note: "…" }）'),
        remember_rule: z.boolean().optional().describe('是否生成同类免弹卡规则（默认 true）'),
      },
    },
    async (args) => {
      const result = await service.approve(args.approval_id, 'mcp', args.edited, args.remember_rule !== false)
      if (!result.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({ decided: false, message: result.message, conflict: result.conflict }) }], isError: true }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ decided: true, merge_commit: result.mergeCommit.slice(0, 8) }) }] }
    },
  )

  // ── pod_deny：驳回审批卡 ──
  server.registerTool(
    'pod_deny',
    {
      description: '驳回审批卡（mission 回 running，可补任务重跑）。',
      inputSchema: { approval_id: z.string(), reason: z.string() },
    },
    async (args) => {
      service.deny(args.approval_id, 'mcp', args.reason)
      return { content: [{ type: 'text', text: JSON.stringify({ decided: true, approval_id: args.approval_id }) }] }
    },
  )

  // ── pod_pause / pod_resume：生命周期 ──
  server.registerTool('pod_pause', { description: '暂停当前 mission（状态磁盘化，可恢复）。', inputSchema: z.object({}) }, async () => {
    service.pauseMission()
    return { content: [{ type: 'text', text: JSON.stringify({ paused: true }) }] }
  })
  server.registerTool('pod_resume', { description: '恢复已暂停的 mission。', inputSchema: z.object({}) }, async () => {
    service.resumeMission()
    return { content: [{ type: 'text', text: JSON.stringify({ resumed: true }) }] }
  })

  // ── pod_abort：终止 ──
  server.registerTool('pod_abort', { description: '中止当前 mission（终态，不可恢复）。', inputSchema: { reason: z.string().optional() } }, async (args) => {
    service.abort(args.reason ?? 'aborted via mcp')
    return { content: [{ type: 'text', text: JSON.stringify({ aborted: true }) }] }
  })

  return server
}
