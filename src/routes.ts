/**
 * /api/dsh-pod 路由族 —— W3/W4 的数据面（Canvas/Team Builder 取数）。
 *   同源 fetch（dsh-ssh 实证路径）：浏览器半不做私有传输假设。
 *   GET  /status  → mission/任务看板/员工/审批卡/账本快照
 *   GET  /events  → 事件流尾部（after=ts 游标，客户端按 id 去重）
 *   POST /launch  → Team Builder 提交：启动 mission（含 commander 会话自动创建，CR-05-7）
 *   POST /steer /approve /deny /dispatch /abort → W4 交互面（审批卡/指令/手动模式/终止）
 *   status 含 ledger 双列（tokens 实测 + equiv_usd 标注，W5）
 * 信任面：全部 loopback-only（launch 会触发真实 LLM 成本，3.8 节 fan-out 限流同源精神）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { lstatSync, realpathSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PodService } from './pod-service.js'
import { resolveAsset, contentTypeFor } from './core/asset-whitelist.js'
import type { PlanTaskInput } from './core/orchestrator.js'
import type { TaskType, Vendor } from './core/types.js'

/** SSE 帧格式化（AgentScope-I / EV-2：replay 优先 + live 增量；测试可断言纯函数）。 */
export function formatSseFrame(
  event: { id: string; ts: number; kind: string; task_id?: string; slot_id?: string; payload: Record<string, unknown> },
): string {
  return `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk.toString('utf8')
    if (raw.length > 64 * 1024) return undefined
  }
  if (raw.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** 路由的输入校验（复用 orchestrator 的 LaunchInput 形状；模型名可空 = CLI 默认）。 */
export interface LaunchRouteBody {
  name?: unknown
  goal?: unknown
  cwd?: unknown
  budget_usd?: unknown
  slots?: unknown
  plan?: unknown
}

export function validateLaunch(body: LaunchRouteBody): { ok: true; value: { name: string; goal: string; cwd: string; budgetUsd: number; slots: Array<{ id: string; vendor: Vendor; role: string; capabilities: string[]; model?: string }>; plan?: unknown } } | { ok: false; error: string } {  if (typeof body.name !== 'string' || body.name.length === 0) return { ok: false, error: 'name is required' }
  if (typeof body.goal !== 'string' || body.goal.length === 0) return { ok: false, error: 'goal is required' }
  if (typeof body.cwd !== 'string' || body.cwd.length === 0) return { ok: false, error: 'cwd is required' }
  if (!Array.isArray(body.slots) || body.slots.length === 0) return { ok: false, error: 'slots must be a non-empty array' }
  const slots: Array<{ id: string; vendor: Vendor; role: string; capabilities: string[]; model?: string }> = []
  for (const raw of body.slots) {
    const slot = raw as { id?: unknown; vendor?: unknown; role?: unknown; capabilities?: unknown; model?: unknown }
    if (typeof slot.id !== 'string' || typeof slot.vendor !== 'string' || typeof slot.role !== 'string') {
      return { ok: false, error: 'each slot needs id/vendor/role' }
    }
    if (!['claude', 'codex', 'dsh'].includes(slot.vendor)) return { ok: false, error: `unknown vendor: ${slot.vendor}` }
    slots.push({
      id: slot.id,
      vendor: slot.vendor as Vendor,
      role: slot.role,
      capabilities: Array.isArray(slot.capabilities) ? (slot.capabilities as string[]) : [],
      model: typeof slot.model === 'string' ? slot.model : undefined,
    })
  }
  const budgetUsd = typeof body.budget_usd === 'number' && body.budget_usd > 0 ? body.budget_usd : 3
  return { ok: true, value: { name: body.name, goal: body.goal, cwd: body.cwd, budgetUsd, slots, plan: body.plan } }
}

export function makePodRoutes(service: () => PodService | undefined): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: '/api/dsh-pod/status',
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const current = service()
        if (current === undefined) {
          writeJson(res, 503, { error: 'pod runtime not initialized' })
          return
        }
        const snapshot = current.status()
        writeJson(res, 200, {
          mission: snapshot.mission
            ? {
                id: snapshot.mission.id,
                status: snapshot.mission.status,
                goal: snapshot.mission.goal,
                spent_tokens: snapshot.mission.spent_tokens,
                spent_equiv_usd: Number(snapshot.mission.spent_equiv_usd.toFixed(4)),
                budget_usd: snapshot.mission.budget_usd,
              }
            : null,
          tasks: snapshot.tasks.map((t) => ({
            id: t.id,
            title: t.title,
            type: t.type,
            status: t.status,
            fault: t.fault ?? null,
            attempts: t.attempts,
            owner: t.owner_slot_id ?? null,
            commit: t.commit_sha?.slice(0, 8) ?? null,
          })),
          slots: snapshot.slots.map((s) => ({
            id: s.id,
            role: s.role,
            vendor: s.vendor,
            status: s.status,
            ctx_usage_pct: s.ctx_usage_pct,
          })),
          pending_approvals: snapshot.pendingApprovals.map((a) => ({
            id: a.id,
            summary: a.patch.summary,
            worktree_path: a.patch.worktree_path,
          })),
          ledger: current.ledgerTail(),
          message: snapshot.mission?.status ?? 'no active mission',
        })
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-pod/events',
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const current = service()
        if (current === undefined) {
          writeJson(res, 503, { error: 'pod runtime not initialized' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const after = Number(url.searchParams.get('after') ?? '0')
        const events = current.eventsTail(after)
        writeJson(res, 200, { events })
      },
    },
    {
      // DoD-17（AS-4，Berd-C）：Canvas 资产读取白名单——只读 mission worktree 根集合，
      // 穿越（.. / 绝对路径 / 盘符 / 符号链接 / realpath 逃逸）全部 403。
      kind: 'exact',
      path: '/api/dsh-pod/assets',
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const current = service()
        if (current === undefined) {
          writeJson(res, 503, { error: 'pod runtime not initialized' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rel = url.searchParams.get('path') ?? ''
        const roots = current.worktreeRoots()
        if (roots.length === 0) {
          writeJson(res, 404, { error: 'no active mission worktree roots' })
          return
        }
        const fsApi = {
          isSymbolicLink: (abs: string): boolean => {
            try {
              return lstatSync(abs).isSymbolicLink()
            } catch {
              return false
            }
          },
          realpath: (abs: string): string => {
            try {
              return realpathSync(abs)
            } catch {
              return abs
            }
          },
          exists: (abs: string): boolean => {
            try {
              return existsSync(abs)
            } catch {
              return false
            }
          },
        }
        const resolution = resolveAsset(roots, rel, fsApi)
        if (!resolution.ok) {
          writeJson(res, 403, { error: `forbidden: ${resolution.reason}` })
          return
        }
        try {
          const bytes = readFileSync(join(resolution.abs))
          res.writeHead(200, {
            'content-type': contentTypeFor(rel),
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          })
          res.end(bytes)
        } catch (error) {
          writeJson(res, 404, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      // AgentScope-I / EV-2（DC：SSE replay）：新订阅者先收 buffered history 再收 live。
      // 数据源 = store（磁盘唯一事实源），replay + 1s 增量轮询；客户端按 id 去重。
      kind: 'exact',
      path: '/api/dsh-pod/events/stream',
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const current = service()
        if (current === undefined) {
          writeJson(res, 503, { error: 'pod runtime not initialized' })
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        res.write('retry: 2000\n\n')
        let lastTs = 0
        const push = (events: Array<{ id: string; ts: number; kind: string; task_id?: string; slot_id?: string; payload: Record<string, unknown> }>): void => {
          for (const event of events) {
            if (res.writableEnded) return
            res.write(formatSseFrame(event))
            if (event.ts > lastTs) lastTs = event.ts
          }
        }
        // 1) replay：新订阅者先收 buffered history（不丢上下文）
        push(current.eventsAfter(0))
        // 2) live：增量轮询（ts 游标；客户端按 id 去重，容忍同 ts 重复帧）
        const timer = setInterval(() => {
          try {
            push(current.eventsAfter(lastTs))
          } catch {
            /* 订阅期间 store 读取异常：保持连接，下轮重试 */
          }
        }, 1_000)
        req.on('close', () => clearInterval(timer))
        res.on('close', () => clearInterval(timer))
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-pod/launch',
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const current = service()
        if (current === undefined) {
          writeJson(res, 503, { error: 'pod runtime not initialized' })
          return
        }
        const body = (await readJsonBody(req)) as LaunchRouteBody | undefined
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid or missing JSON body' })
          return
        }
        const validated = validateLaunch(body)
        if (!validated.ok) {
          writeJson(res, 422, { error: validated.error })
          return
        }
        try {
          const mission = current.launch({
            ...validated.value,
            plan: validated.value.plan as PlanTaskInput[] | undefined,
          })
          writeJson(res, 200, { mission_id: mission.id, status: mission.status })
        } catch (error) {
          writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-pod/steer',
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const current = service()
        if (current === undefined) {
          writeJson(res, 503, { error: 'pod runtime not initialized' })
          return
        }
        const body = await readJsonBody(req)
        const slotId = body?.slot_id
        const instruction = body?.instruction
        if (typeof slotId !== 'string' || slotId.length === 0 || typeof instruction !== 'string' || instruction.length === 0) {
          writeJson(res, 422, { error: 'slot_id and instruction are required' })
          return
        }
        try {
          current.steer(slotId, instruction)
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-pod/approve',
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const current = service()
        if (current === undefined) {
          writeJson(res, 503, { error: 'pod runtime not initialized' })
          return
        }
        const body = await readJsonBody(req)
        const approvalId = body?.approval_id
        if (typeof approvalId !== 'string' || approvalId.length === 0) {
          writeJson(res, 422, { error: 'approval_id is required' })
          return
        }
        // AS-3（AgentScope-C）：approve 可携带人工编辑参数（编辑参数后放行）
        const editedRaw = body?.edited
        const edited =
          editedRaw !== undefined &&
          typeof editedRaw === 'object' &&
          editedRaw !== null &&
          !Array.isArray(editedRaw)
            ? (Object.fromEntries(
                Object.entries(editedRaw as Record<string, unknown>).filter(
                  (entry): entry is [string, string] => typeof entry[1] === 'string',
                ),
              ) as Record<string, string>)
            : undefined
        // apply_patch 单入口：合并成功才裁决 mission done；冲突保持 awaiting_approval（CR-05-3）
        const result = await current.approve(approvalId, 'canvas-ui', edited)
        if (!result.ok) {
          writeJson(res, result.conflict ? 409 : 404, { error: result.message, conflict: result.conflict })
          return
        }
        writeJson(res, 200, { ok: true, merge_commit: result.mergeCommit.slice(0, 8) })
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-pod/deny',
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const current = service()
        if (current === undefined) {
          writeJson(res, 503, { error: 'pod runtime not initialized' })
          return
        }
        const body = await readJsonBody(req)
        const approvalId = body?.approval_id
        if (typeof approvalId !== 'string' || approvalId.length === 0) {
          writeJson(res, 422, { error: 'approval_id is required' })
          return
        }
        const reason = typeof body?.reason === 'string' ? body.reason : 'denied via canvas-ui'
        try {
          current.deny(approvalId, 'canvas-ui', reason)
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-pod/dispatch',
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const current = service()
        if (current === undefined) {
          writeJson(res, 503, { error: 'pod runtime not initialized' })
          return
        }
        try {
          // 手动模式（3.3 节）：UI 直连状态机派单，绕开 LLM 编排
          const dispatched = await current.dispatchNext()
          writeJson(res, 200, { dispatched })
        } catch (error) {
          writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-pod/resolve',
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const current = service()
        if (current === undefined) {
          writeJson(res, 503, { error: 'pod runtime not initialized' })
          return
        }
        const body = await readJsonBody(req)
        const taskId = body?.task_id
        const outcome = body?.outcome
        if (typeof taskId !== 'string' || taskId.length === 0 || (outcome !== 'done' && outcome !== 'blocked')) {
          writeJson(res, 422, { error: 'task_id and outcome (done|blocked) are required' })
          return
        }
        try {
          // 转人工接管（3.4 节）：人工裁决 escalated 任务并恢复驱动（CR-06-8）
          const summary = await current.humanResolveAndResume(taskId, {
            outcome,
            commit_sha: typeof body?.commit_sha === 'string' ? body.commit_sha : undefined,
            parent_sha: typeof body?.parent_sha === 'string' ? body.parent_sha : undefined,
            note: typeof body?.note === 'string' ? body.note : undefined,
          })
          writeJson(res, 200, { ok: true, run_status: summary.status })
        } catch (error) {
          writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-pod/rules',
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const current = service()
        if (current === undefined) {
          writeJson(res, 503, { error: 'pod runtime not initialized' })
          return
        }
        if (req.method === 'GET') {
          writeJson(res, 200, { rules: current.listRules() })
          return
        }
        // POST：记住此规则（AgentScope-B：suggested-rules 落 Store）
        const body = await readJsonBody(req)
        const tool = body?.tool
        const decision = body?.decision
        if (typeof tool !== 'string' || tool.length === 0 || (decision !== 'allow' && decision !== 'deny' && decision !== 'ask')) {
          writeJson(res, 422, { error: 'tool and decision (allow|deny|ask) are required' })
          return
        }
        try {
          const rule = current.addRule({
            tool,
            pattern: typeof body?.pattern === 'string' && body.pattern.length > 0 ? body.pattern : undefined,
            decision,
            scope: body?.scope === 'mission' ? 'mission' : 'global',
          })
          writeJson(res, 201, { ok: true, rule })
        } catch (error) {
          writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-pod/abort',
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const current = service()
        if (current === undefined) {
          writeJson(res, 503, { error: 'pod runtime not initialized' })
          return
        }
        const body = await readJsonBody(req)
        const reason = typeof body?.reason === 'string' && body.reason.length > 0 ? body.reason : 'aborted via canvas-ui'
        try {
          current.abort(reason)
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
}

/** 供路由与客户端共用的任务类型/供应商枚举（schema 校验引用）。 */
export type { TaskType, Vendor }
