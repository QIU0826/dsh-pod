/**
 * pod_* 工具定义 —— 方案书 3.3 节工具作用域清单：
 * pod_launch / pod_status / pod_dispatch / pod_collect / pod_steer / pod_approve / pod_abort。
 *
 * 工具 = 薄壳：全部副作用经 PodService → MissionOrchestrator → 状态机裁决
 * （LLM 提议、代码裁决；审批/收集/合并只走代码入口，无 bash 旁路）。
 * 输出为结构化 JSON + 文本渲染（沿 dsh-ssh 的 defineTool 模式）。
 *
 * 作用域说明（CR-04）：MVP 全局注册——pod_* 的副作用已被状态机与审批门约束，
 * 任何会话调用均记录事件与 by 来源；commander 会话创建落地后，按官方 agent
 * scope 机制（dsh-tools「register globally or in the calling agent scope」+
 * agent.ctx 路径，CR-02-8 实证）切换为会话级注册。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { EXPAND_TOOL_NAME } from './core/tool-stages.js'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { PodService } from './pod-service.js'
import type { PlanTaskInput } from './core/orchestrator.js'
import type { TaskType, Vendor } from './core/types.js'

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

function renderJson(value: unknown): ContentBlock[] {
  return text(JSON.stringify(value, null, 2))
}

/** defineTool 的 args 泛型来自 schema，嵌套结构收窄不完整——入口显式收窄（薄壳边界）。 */
function castArgs<T>(args: unknown): T {
  return args as T
}

interface LaunchArgs {
  name: string
  goal: string
  cwd: string
  budget_usd?: number
  /** token 预算上限（方案书 2.3 节⑤）：未设则仅美元熔断。 */
  budget_tokens?: number
  /** 审批模式（1 默认 / 2 交接确认 / 3 全自动）。模式 2/3 需 experiments 灰度开关开启。 */
  approval_mode?: number
  /** 并行执行上限（默认 2，v0.2 并行强化；clamp 1-8）。 */
  parallel?: number
  /** 团队宗旨（P0-B）：3-5 条 do/prioritize 价值观锚点。 */
  tenets?: string[]
  slots: Array<{
    id: string
    vendor: Vendor
    role: string
    capabilities: string[]
    model?: string
  }>
  plan?: PlanTaskInput[]
}

export interface PodToolBundle {
  tools: ReturnType<typeof defineTool>[]
  names: string[]
}

/** 七个 pod_* 工具（PodService 注入，测试用 fake）。 */
export function makePodTools(service: PodService): PodToolBundle {
  const tools = [
    defineTool({
      name: 'pod_launch',
      description:
        '启动一个 Pod mission（多智能体任务书）。创建独立 mission 与员工名册，按计划任务 DAG 后台驱动：' +
        '派发 → 实现 → 独立 review（质量门）→ 审批卡。触发词：Pod 组队 / 多智能体 / 启动 mission / 一键组队。',
      parameters: {
        name: { type: 'string', required: true, description: 'mission 名称' },
        goal: { type: 'string', required: true, description: '一句话可验收目标' },
        cwd: { type: 'string', required: true, description: '目标 git 仓库绝对路径（主树）' },
        budget_usd: { type: 'number', description: '美元预算上限（默认 3）' },
        budget_tokens: { type: 'number', description: 'token 预算上限（可选，方案书 2.3 节⑤）：未设则仅美元熔断' },
        approval_mode: { type: 'number', description: '审批模式：1（默认，合并前确认）/ 2（交接确认）/ 3（全自动）。模式 2/3 需 ~/.dsh/pod/experiments.json 对应开关开启。' },
        parallel: { type: 'number', description: '并行执行上限（默认 2；v0.2 并行强化，clamp 1-8）' },
        tenets: {
          type: 'array',
          description: '团队宗旨（3-5 条价值观锚点，do/prioritize；派发时注入每个任务 spec，给 agent 取舍方向）',
          items: { type: 'string' },
        },
        slots: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              vendor: { type: 'string', required: true, enum: ['claude', 'codex', 'dsh', 'ark', 'opencode'] satisfies Vendor[] },
              role: { type: 'string', required: true, description: 'planner / implementer / reviewer / tester / ...' },
              capabilities: { type: 'array', items: { type: 'string' }, required: true },
              model: { type: 'string', description: '模型名；codex（ChatGPT 内置）留空走其默认' },
            },
          },
        },
        plan: {
          type: 'array',
          description: '任务 DAG：每项含 id/title/spec/type/depends_on；review 任务的 depends_on 指向被审任务',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              title: { type: 'string', required: true },
              spec: { type: 'string', required: true },
              type: { type: 'string', required: true, enum: ['implement', 'review', 'plan', 'test', 'doc', 'research'] satisfies TaskType[] },
              skill_tags: { type: 'array', items: { type: 'string' } },
              depends_on: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mission_id: { type: 'string', required: true },
            status: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value: { mission_id: string; status: string; message: string }) =>
          text(`mission ${value.mission_id} 已启动（${value.status}）：${value.message}`),
      },
      async execute(args, _exec) {
        const input = castArgs<LaunchArgs>(args)
        const mission = service.launch({
          name: input.name,
          goal: input.goal,
          cwd: input.cwd,
          budgetUsd: input.budget_usd ?? 3,
          budgetTokens: input.budget_tokens,
          approvalMode: input.approval_mode === 2 || input.approval_mode === 3 ? input.approval_mode : 1,
          parallel: input.parallel,
          tenets: input.tenets,
          slots: input.slots,
          plan: input.plan,
        })
        return {
          mission_id: mission.id,
          status: mission.status,
          message: `后台驱动中；用 pod_status 查看进度。质量门：合并前必经独立 review（审查者≠实现者）。`,
        }
      },
    }),

    defineTool({
      name: 'pod_status',
      description: '查看当前 Pod mission 状态：任务看板（各任务状态/故障/attempts）、员工状态灯、审批卡、成本账本摘要。触发词：Pod 进度 / mission 状态 / 看板。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mission: { type: 'object', additionalProperties: true },
            tasks: { type: 'array' },
            pending_approvals: { type: 'array' },
            budget: { type: 'object', additionalProperties: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => renderJson(value),
      },
      async execute() {
        const snapshot = service.status()
        if (snapshot.mission === undefined) {
          return {
            tasks: [],
            pending_approvals: [],
            message: '当前没有 active mission；用 pod_launch 启动一个。',
          }
        }
        const tasks = snapshot.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          type: t.type,
          status: t.status,
          fault: t.fault ?? null,
          attempts: t.attempts,
          owner: t.owner_slot_id ?? null,
          commit: t.commit_sha?.slice(0, 8) ?? null,
        }))
        return {
          mission: {
            id: snapshot.mission.id,
            status: snapshot.mission.status,
            goal: snapshot.mission.goal,
            spent_tokens: snapshot.mission.spent_tokens,
            spent_equiv_usd: Number(snapshot.mission.spent_equiv_usd.toFixed(4)),
          },
          tasks,
          pending_approvals: snapshot.pendingApprovals.map((a) => ({ id: a.id, summary: a.patch.summary })),
          budget: { tokens: snapshot.mission.spent_tokens, equiv_usd: snapshot.mission.spent_equiv_usd },
          message: snapshot.mission.status,
        }
      },
    }),

    defineTool({
      name: 'pod_dispatch',
      description: '手动模式（commander 异常降级）：派发下一个就绪任务（拓扑就绪 + 单路并行上限内）。触发词：手动派发 / Pod 接管。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dispatched: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value: { dispatched: boolean; message: string }) => text(`${value.dispatched ? '已派发' : '无可派任务'}：${value.message}`),
      },
      async execute() {
        const dispatched = await service.dispatchNext()
        return { dispatched, message: dispatched ? '下一就绪任务已派发' : '无就绪任务或已达并行上限' }
      },
    }),

    defineTool({
      name: 'pod_collect',
      description: '查看/收集任务产物：MISSION_REPORT、commit 区间、事件流尾部。收集不信任叙事，只呈现已校验事实（Verifier 落盘结果）。触发词：Pod 收集 / 任务产物 / 报告。',
      parameters: {
        task_id: { type: 'string', description: '任务 id；省略则列出全部任务产物摘要' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tasks: { type: 'array' },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => renderJson(value),
      },
      async execute(args, _exec) {
        const snapshot = service.status()
        const tasks = snapshot.tasks
          .filter((t) => args.task_id === undefined || t.id === args.task_id)
          .map((t) => ({
            id: t.id,
            status: t.status,
            fault: t.fault ?? null,
            last_error: t.last_error ?? null,
            commit: t.commit_sha?.slice(0, 8) ?? null,
            parent: t.parent_sha?.slice(0, 8) ?? null,
            result_ref: t.result_ref ?? null,
          }))
        return { tasks, message: tasks.length === 0 ? '无匹配任务' : `共 ${tasks.length} 个任务产物` }
      },
    }),

    defineTool({
      name: 'pod_steer',
      description: '向员工发指令：运行中指令排队为 micro-task（该员工下次派单必带），不打断进行中的进程（CR-01-2）。触发词：Pod 指令 / steer / 指挥员工。',
      parameters: {
        slot_id: { type: 'string', required: true, description: '员工槽位 id' },
        instruction: { type: 'string', required: true, description: '指令内容（如：加一层缓存）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            queued: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value: { queued: boolean; message: string }) => text(value.message),
      },
      async execute(args, _exec) {
        service.steer(args.slot_id, args.instruction)
        return { queued: true, message: `指令已排队给 ${args.slot_id}（下次派单必带）` }
      },
    }),

    defineTool({
      name: 'pod_approve',
      description:
        '审批卡裁决：批准合并（mission 进入 done）。这是合并回主树的唯一放行入口；deny 用 reason 参数。触发词：Pod 审批 / 批准合并 / 驳回。',
      parameters: {
        approval_id: { type: 'string', required: true, description: 'pod_status 给出的审批卡 id' },
        decision: { type: 'string', required: true, enum: ['approve', 'deny'] },
        reason: { type: 'string', description: 'deny 时的原因（必填）' },
        by: { type: 'string', description: '决定人（默认 user）' },
        edited: { type: 'object', description: 'approve 时的人工编辑参数（如 { merge_note: "…" }，AS-3/AgentScope-C）', additionalProperties: true },
        remember_rule: { type: 'boolean', description: 'approve 时是否生成同类免弹卡规则（W4 记住规则；默认 true）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            decided: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value: { decided: boolean; message: string }) => text(value.message),
      },
      async execute(args, _exec) {
        if (args.decision === 'deny' && (args.reason === undefined || args.reason.length === 0)) {
          return { decided: false, message: 'deny 必须提供 reason' }
        }
        try {
          // 模式 2 派发确认门（kind='dispatch'）：批准=授权派发，驳回=对应任务转人工。
          const approval = service.getApproval(args.approval_id)
          if (approval !== undefined && approval.kind === 'dispatch') {
            if (args.decision === 'approve') {
              service.approveDispatchGate(args.approval_id, args.by ?? 'user')
              return { decided: true, message: `派发确认卡 ${args.approval_id} 已放行，任务待派发（pod_dispatch 继续）` }
            }
            service.denyDispatchGate(args.approval_id, args.by ?? 'user', args.reason!)
            return { decided: true, message: `派发确认卡 ${args.approval_id} 已驳回，对应任务转人工` }
          }
          if (args.decision === 'approve') {
            const edited = args.edited !== undefined ? (args.edited as Record<string, string>) : undefined
            const result = await service.approve(args.approval_id, args.by ?? 'user', edited, args.remember_rule !== false)
            if (!result.ok) {
              return {
                decided: false,
                message: result.conflict
                  ? `合并冲突，主树未动（已 abort）：${result.message.slice(0, 300)}。请解决冲突或驳回后重新派发。`
                  : `合并失败：${result.message}`,
              }
            }
            return { decided: true, message: `审批卡 ${args.approval_id} 已批准并合并回主树（merge ${result.mergeCommit.slice(0, 8)}）` }
          }
          service.deny(args.approval_id, args.by ?? 'user', args.reason!)
          return { decided: true, message: `审批卡 ${args.approval_id} 已驳回（mission 回到 running，可补任务重跑）` }
        } catch (error) {
          return { decided: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
    }),

    defineTool({
      name: 'pod_mem_write',
      description: '主动写入长期记忆记录（2.8.1 知识层）：type/importance/tags/content_ref/live_ref，owner_slot_id 隔离。团队级（mission 复盘）用 team:<mission_id> 作为 owner_slot_id，由 commander 主动策展（不做自动摘要）。触发词：记经验 / 记住。',
      parameters: {
        owner_slot_id: { type: 'string', required: true, description: '拥有者槽位；团队级（mission 复盘）用 team:<mission_id>' },
        type: { type: 'string', enum: ['lesson', 'pattern', 'decision', 'fact', 'episode'] },
        importance: { type: 'number', description: '1-5，越高越重要' },
        tags: { type: 'array', items: { type: 'string' } },
        content_ref: { type: 'string', description: '内容引用（文件/路径/摘要，非原始对话转录）' },
        live_ref: { type: 'string', description: '可选实时状态引用（live_ref：非快照）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value: { id: string; message: string }) => text('已写入记忆 ' + value.id + '：' + value.message),
      },
      async execute(args, _exec) {
        const rec = service.memoryWrite({
          owner_slot_id: args.owner_slot_id,
          type: args.type as 'lesson' | 'pattern' | 'decision' | 'fact' | 'episode' | undefined,
          importance: args.importance as number | undefined,
          tags: args.tags as string[] | undefined,
          content_ref: args.content_ref as string | undefined,
          live_ref: args.live_ref as string | undefined,
        })
        return { id: rec.id, message: rec.content_ref || rec.type }
      },
    }),

    defineTool({
      name: 'pod_mem_query',
      description: '查询记忆图谱：按 owner/type/tags/importance，或沿 supports/contradicts/derived-from 遍历。仅返回结构化记录，不含原始对话。触发词：查经验 / 记忆。',
      parameters: {
        owner_slot_id: { type: 'string' },
        type: { type: 'string', enum: ['lesson', 'pattern', 'decision', 'fact', 'episode'] },
        tags: { type: 'array', items: { type: 'string' } },
        importance_min: { type: 'number' },
        relation: { type: 'string', enum: ['supports', 'contradicts', 'derived-from'] },
        relates_to: { type: 'string', description: '图谱遍历起点记录 id' },
        limit: { type: 'number' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            records: { type: 'array', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value: { records: Array<{ id: string }>; message: string }) => text(value.message + '：' + value.records.map((r) => r.id).join(', ')),
      },
      async execute(args, _exec) {
        const records = service.memoryQuery(args as never)
        return {
          records: records.map((r) => ({ id: r.id, owner_slot_id: r.owner_slot_id, type: r.type, importance: r.importance, tags: r.tags, content_ref: r.content_ref, live_ref: r.live_ref ?? null })),
          message: '返回 ' + records.length + ' 条记忆',
        }
      },
    }),

    defineTool({
      name: 'pod_mem_correct',
      description: '纠正/更新记忆记录（保留变更历史，可审计）。触发词：纠正记忆 / 改记忆。',
      parameters: {
        id: { type: 'string', required: true },
        type: { type: 'string', enum: ['lesson', 'pattern', 'decision', 'fact', 'episode'] },
        importance: { type: 'number', description: '1-5' },
        tags: { type: 'array', items: { type: 'string' } },
        content_ref: { type: 'string' },
        live_ref: { type: 'string' },
        by: { type: 'string', description: '变更人（默认 user，审计留痕）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            corrected: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value: { corrected: boolean; message: string }) => text(value.message),
      },
      async execute(args, _exec) {
        const rec = service.memoryCorrect(args.id, {
          type: args.type as 'lesson' | 'pattern' | 'decision' | 'fact' | 'episode' | undefined,
          importance: args.importance as number | undefined,
          tags: args.tags as string[] | undefined,
          content_ref: args.content_ref as string | undefined,
          live_ref: args.live_ref as string | undefined,
        }, (args.by as string | undefined) ?? 'user')
        return { corrected: true, message: '记忆 ' + rec.id + ' 已更新（变更历史已留痕）' }
      },
    }),
    defineTool({
      name: 'pod_reassign',
      description: '任务中途换人正式化（v0.2）：把任务所有权从我（旧槽位）转到目标槽位——kill 旧进程 + 交接四件套落盘 + 事件审计，任务置 ready 由 dispatchNext 重派。done 已终态不可换；目标槽位不可用拒绝。触发词：换人 / 换个人干 / 转派。',
      parameters: {
        task_id: { type: 'string', required: true, description: '要换人任务 id' },
        to_slot_id: { type: 'string', required: true, description: '目标槽位 id' },
        reason: { type: 'string', required: true, description: '换人原因（进入交接 intent 与事件审计）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            handoff_id: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value: { handoff_id: string; message: string }) => text('换人完成：' + value.message + '（交接 ' + value.handoff_id + '）'),
      },
      async execute(args, _exec) {
        try {
          const h = await service.reassign(args.task_id, args.to_slot_id, args.reason)
          return { handoff_id: h.id, message: `任务 ${args.task_id} 已转给 ${args.to_slot_id}` }
        } catch (error) {
          return { handoff_id: '', message: error instanceof Error ? error.message : String(error) }
        }
      },
    }),
    defineTool({
      name: 'pod_abort',
      description: '中止当前 mission（终态，不可恢复）；所有运行中的员工进程会被终止。触发词：Pod 中止 / 终止 mission。',
      parameters: {
        reason: { type: 'string', description: '中止原因' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            aborted: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value: { aborted: boolean; message: string }) => text(value.message),
      },
      async execute(args, _exec) {
        try {
          service.abort(args.reason ?? 'aborted by operator')
          return { aborted: true, message: 'mission 已中止' }
        } catch (error) {
          return { aborted: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
    }),
    defineTool({
      name: 'pod_pause',
      description: '暂停当前 mission（运行中/待审批可暂停；状态磁盘化，可恢复）。触发词：Pod 暂停。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            paused: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value: { paused: boolean; message: string }) => text(value.message),
      },
      async execute() {
        try {
          service.pauseMission()
          return { paused: true, message: 'mission 已暂停' }
        } catch (error) {
          return { paused: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
    }),
    defineTool({
      name: 'pod_resume',
      description: '恢复已暂停的 mission（paused → 继续运行/待审批，取决于 pending 审批卡）。触发词：Pod 恢复。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            resumed: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value: { resumed: boolean; message: string }) => text(value.message),
      },
      async execute() {
        try {
          service.resumeMission()
          return { resumed: true, message: 'mission 已恢复' }
        } catch (error) {
          return { resumed: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
    }),
    defineTool({
      name: 'pod_cron_list',
      description: '查看定时任务（Cron，AgentScope-J）：cron.json 里的 jobs 与最近触发历史。触发词：Pod 定时 / cron。编辑 <dataDir>/cron.json 后调用本工具即热加载。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            jobs: { type: 'array' },
            recent: { type: 'array' },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(value.message),
      },
      async execute() {
        const cron = service.cronList()
        const jobs = cron.jobs.map((j) => ({
          id: j.id,
          label: j.label ?? null,
          interval_ms: j.intervalMs,
          enabled: j.enabled,
          command_kind: j.command.kind,
          last_fired_at: j.lastFiredAt ?? null,
        }))
        return {
          jobs,
          recent: cron.recent.map((h) => ({ job_id: h.job_id, fired: h.fired, reason: h.reason, reply: h.reply_text ?? null, ts: h.ts })),
          message:
            jobs.length === 0
              ? '无定时任务。配置 <dataDir>/cron.json（{"jobs":[{id,intervalMs,command,enabled}]}，enabled 默认 false 须显式 true），保存后调 pod_cron_list 热加载。'
              : jobs.length + ' 个定时任务（enabled ' + jobs.filter((j) => j.enabled).length + '），随宿主 maintenanceTick 节拍触发；最近 ' + cron.recent.length + ' 条触发历史见 recent。',
        }
      },
    }),
    defineTool({
      name: 'pod_plan',
      description:
        'P1 规划层工具面（AgentScope DAGPlanExecutor 借鉴）：action=list 查看当前任务 DAG；' +
        'action=add 运行中追加任务节点（走 createTasks 同一裁决：id 白名单/环检测 fail-closed）；' +
        'action=replan 有界重规划——把失败现状喂回 planner 槽位重新分解（上限 ' + '2 次 + 预算门控）。触发词：Pod 计划 / 重规划 / 加任务。',
      parameters: {
        action: { type: 'string', required: true, description: 'list | add | replan' },
        tasks: {
          type: 'array',
          description: 'action=add 必填：追加的任务节点',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true, description: '任务 id（T-n 形式，字母数字._-）' },
              title: { type: 'string', required: true },
              spec: { type: 'string', required: true, description: '完整任务书（给员工的）' },
              type: { type: 'string', required: true, description: 'implement | review | test | doc | research' },
              skill_tags: { type: 'array', items: { type: 'string' } },
              depends_on: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        reason: { type: 'string', description: 'action=replan 时的重规划原因' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
            tasks: { type: 'array' },
          },
        },
        render: (_args, value: { ok: boolean; message: string }) => text(value.message),
      },
      async execute(args: { action: string; tasks?: Array<{ id: string; title: string; spec: string; type: string; skill_tags?: string[]; depends_on?: string[] }>; reason?: string }) {
        try {
          if (args.action === 'list') {
            const st = service.status()
            return {
              ok: true,
              message: `任务 ${st.tasks.length} 个（mission ${st.mission?.status ?? '无'}；planner 槽位：${service.hasPlannerCapability() ? '有' : '无'}；重规划余量 ${service.replanRemaining()} 次）`,
              tasks: st.tasks.map((t) => ({ id: t.id, title: t.title, type: t.type, status: t.status, depends_on: t.depends_on })),
            }
          }
          if (args.action === 'add') {
            const tasks = args.tasks ?? []
            if (tasks.length === 0) return { ok: false, message: 'action=add 需要 tasks 数组' }
            const created = service.addPlanTasks(
              tasks.map((t) => ({
                id: t.id, title: t.title, spec: t.spec,
                type: t.type as PlanTaskInput['type'],
                skill_tags: t.skill_tags ?? [], depends_on: t.depends_on ?? [],
              })),
            )
            return { ok: true, message: `已追加 ${created.length} 个任务节点（同一裁决：id 白名单/环 fail-closed）`, tasks: created.map((t) => ({ id: t.id, title: t.title, type: t.type, status: t.status })) }
          }
          if (args.action === 'replan') {
            const r = service.requestReplan(args.reason ?? '人工触发重规划')
            return { ok: r.requested, message: `${r.message}（剩余 ${r.remaining} 次）` }
          }
          return { ok: false, message: `未知 action：${args.action}（支持 list | add | replan）` }
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
    }),
  ]
  // P0-1 元工具：需要跨 stage 工具时先展开完整 schema（模型下一轮再调用，不占本轮全量注入）。
  // 展开内容（description+parameters）只在被点名时才进上下文——正是分层加载的「按需展开」。
  tools.push(
    defineTool({
      name: EXPAND_TOOL_NAME,
      description:
        '展开某个 pod_* 工具的完整参数 schema 与说明（仅当该工具不在当前 stage 全量清单里时使用；展开结果只供你下一轮直接调用，无需二次展开）',
      parameters: {
        name: { type: 'string', required: true, enum: tools.map((t) => t.name) },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            brief: { type: 'string', required: true },
            params: { type: 'object', additionalProperties: true, required: true },
          },
        },
        render: (_args, value: { name: string; brief: string }) => text(`[${value.name}] ${value.brief}`),
      },
      async execute(args: { name?: string }) {
        const name = args.name
        const t = tools.find((x) => x.name === name)
        if (typeof name !== 'string' || t === undefined) return { name: String(name), brief: '（未知工具）', params: {} }
        return { name, brief: t.description, params: t.parameters as unknown as Record<string, JsonValue> }
      },
    }),
  )
  // AgentScope-E 工具级 middleware（Should 落地）：每个 pod_* 工具 execute 包审计钩子——
  // 调用前记开始、调用后记耗时/成败（service.recordToolAudit → pod_tool_called 事件）。
  // 薄壳边界保持：wrapTool 只做横切记账，不改变工具返回值。
  const audited = tools.map((tool) => {
    const inner = tool.execute
    return {
      ...tool,
      execute: (async (args: never, exec: never) => {
        const started = Date.now()
        try {
          const result = await inner(args, exec)
          service.recordToolAudit({ tool: tool.name, ok: true, ms: Date.now() - started })
          return result
        } catch (error) {
          service.recordToolAudit({
            tool: tool.name,
            ok: false,
            ms: Date.now() - started,
            error: error instanceof Error ? error.message : String(error),
          })
          throw error
        }
      }) as typeof inner,
    }
  })
  return { tools: audited, names: audited.map((tool) => tool.name) }
}

export interface CommanderLaunch {
  (goal: string, cwd: string, agentPreset?: string): Promise<{ sessionId: string; message: string }>
}

/**
 * pod_commander_start —— 创建 commander 会话（3.3 节）：
 * 经 ctx.agents.create 建立独立 mission 会话，pod_* 工具只注册在该会话作用域（CR-05-2），
 * 首条 goal 消息驱动。真实宿主的 commander 行为验证入口（重启后自检用）。
 */
export function makeCommanderStartTool(launch: CommanderLaunch) {
  return defineTool({
    name: 'pod_commander_start',
    description:
      '创建 Commander 独立会话（mission 编排会话，pod_* 工具仅注册于该会话作用域），以 goal 首条消息驱动。' +
      '触发词：Pod commander / 编排会话 / mission 会话。',
    parameters: {
      goal: { type: 'string', required: true, description: 'mission 目标（一句话，可验收）' },
      cwd: { type: 'string', required: true, description: '目标 git 仓库绝对路径' },
      agent_preset: { type: 'string', description: '可选 agent preset（如 pod-commander）；缺省走部署默认' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value: { session_id: string; message: string }) => text(`[${value.session_id}] ${value.message}`),
    },
    async execute(args, _exec) {
      try {
        const result = await launch(args.goal, args.cwd, args.agent_preset)
        return { session_id: result.sessionId, message: result.message }
      } catch (error) {
        return { session_id: '', message: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
