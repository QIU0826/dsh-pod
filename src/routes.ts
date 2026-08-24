/**
 * /api/dsh-pod 路由族 —— W3/W4 的数据面（Canvas/Team Builder 取数）。
 *   同源 fetch（dsh-ssh 实证路径）：浏览器半不做私有传输假设。
 *   GET  /status  → mission/任务看板/员工/审批卡/账本快照
 *   GET  /events  → 事件流尾部（after=ts 游标，客户端按 id 去重）
 *   POST /launch  → Team Builder 提交：启动 mission（含 commander 会话自动创建，CR-05-7）
 * 信任面：全部 loopback-only（launch 会触发真实 LLM 成本，3.8 节 fan-out 限流同源精神）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { PodService } from './pod-service.js'
import type { PlanTaskInput } from './core/orchestrator.js'
import type { TaskType, Vendor } from './core/types.js'

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
          pending_approvals: snapshot.pendingApprovals.map((a) => ({ id: a.id, summary: a.patch.summary })),
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
  ]
}

/** 供路由与客户端共用的任务类型/供应商枚举（schema 校验引用）。 */
export type { TaskType, Vendor }
