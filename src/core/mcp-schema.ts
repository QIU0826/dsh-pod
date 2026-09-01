/**
 * MCP 暴露面的共享 schema 片段（ADOL P2-1「schema $ref 去重」）。
 *
 * 调研 §3.1 指出同 server 多工具重复 schema 片段是 token bloat 的一类（GitHub 官方 MCP
 * 60 工具重复率 9.84%）。本模块把 pod_* 工具反复出现的公共参数抽成**单一源**，供
 * `mcp-server.ts`（Zod 面）复用——commander 工具清单（pod-tools.ts JSON 面）未来同源
 * 对齐时也从这里派生。
 *
 * 说明：MCP SDK 用 zod→JSON Schema 内联序列化（默认 $refStrategy='none'），故本模块不
 * 直接产出 `$ref` 字节级去重；它的价值是**消除源码层面的重复定义**（防 pod_launch 与
 * pod_plan 的任务节点对象漂移）+ 为未来 $refStrategy='root' 或跨面同源打底。
 */

import { z } from 'zod'

/** 支持的后端厂商（claude/codex/dsh/ark/opencode）。 */
export const VENDORS = ['claude', 'codex', 'dsh', 'ark', 'opencode'] as const
/** 任务类型（implement/review/plan/test/doc/research）。 */
export const TASK_TYPES = ['implement', 'review', 'plan', 'test', 'doc', 'research'] as const

export const vendorEnum = z.enum(VENDORS)
export const taskTypeEnum = z.enum(TASK_TYPES)

/** 员工槽位 id（pod_steer 等反复出现）。 */
export const slotIdSchema = z.string().describe('员工槽位 id')
/** 审批卡 id（pod_approve/pod_deny 反复出现）。 */
export const approvalIdSchema = z.string().describe('pod_status 给出的审批卡 id')

/** 员工名册项（pod_launch.slots）。 */
export const slotShape = z.object({
  id: z.string(),
  vendor: vendorEnum,
  role: z.string(),
  capabilities: z.array(z.string()),
  model: z.string().optional(),
})

/**
 * 任务 DAG 节点公共字段（pod_launch.plan 与 pod_plan.tasks 共享）。
 * `type` 枚举由调用方按语义收紧：pod_launch 允许 6 类（含 plan），pod_plan.add 只允许
 * 5 类（planner 专属创建 plan 节点，手动 add 不开放）。
 */
export function planTaskShape<T extends z.ZodTypeAny>(typeSchema: T) {
  return z.object({
    id: z.string(),
    title: z.string(),
    spec: z.string(),
    type: typeSchema,
    skill_tags: z.array(z.string()).optional(),
    depends_on: z.array(z.string()).optional(),
  })
}

/** pod_* 工具一句话 brief + 阶段标签（ADOL「name+一句话+tag」短清单的单一源）。 */
export const TOOL_BRIEFS: Record<string, { brief: string; tag: string }> = {
  pod_launch: { brief: '启动一个 Pod mission（组队开 mission）', tag: 'orchestration' },
  pod_status: { brief: '查看 mission 状态（看板/员工/审批/账本）', tag: 'read' },
  pod_dispatch: { brief: '手动派发下一个就绪任务', tag: 'orchestration' },
  pod_collect: { brief: '收集任务产物（MISSION_REPORT/commit 区间/事件尾）', tag: 'read' },
  pod_steer: { brief: '向员工排队指令', tag: 'orchestration' },
  pod_approve: { brief: '审批卡裁决（批准合并 / 驳回）', tag: 'approval' },
  pod_abort: { brief: '中止当前 mission（终态）', tag: 'lifecycle' },
  pod_pause: { brief: '暂停当前 mission', tag: 'lifecycle' },
  pod_resume: { brief: '恢复已暂停的 mission', tag: 'lifecycle' },
  pod_plan: { brief: '查看/追加/重规划任务 DAG', tag: 'planning' },
  pod_reassign: { brief: '任务中途换人（交接四件套）', tag: 'orchestration' },
  pod_mem_write: { brief: '主动写入长期记忆记录', tag: 'memory' },
  pod_mem_query: { brief: '查询记忆图谱', tag: 'memory' },
  pod_mem_correct: { brief: '纠正记忆记录', tag: 'memory' },
  pod_cron_list: { brief: '查看定时任务与触发历史', tag: 'read' },
}
