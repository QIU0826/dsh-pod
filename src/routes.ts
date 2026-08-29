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
import { allowsJsonBody } from './core/http-guard.js'
import { NotFoundError } from './core/errors.js'
import { browseDirectories } from './core/fs-browse.js'
import type { PlanTaskInput } from './core/orchestrator.js'
import { AGENT_AVATARS, UNLIMITED_BUDGET_USD } from './core/types.js'
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
  // P1 CSRF 修复：带 body 的请求强制 application/json——text/plain / form-encoded 属
  // CORS simple request，恶意网页可无预检跨站 POST（副作用照常生效）
  if (!allowsJsonBody(req)) return undefined
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
  budget_tokens?: unknown
}


export function validateLaunch(body: LaunchRouteBody): { ok: true; value: { name: string; goal: string; cwd: string; budgetUsd: number; budgetTokens?: number; slots: Array<{ id: string; vendor: Vendor; role: string; capabilities: string[]; model?: string; avatar?: string }>; plan?: unknown } } | { ok: false; error: string } {  if (typeof body.name !== 'string' || body.name.length === 0) return { ok: false, error: 'name is required' }
  if (typeof body.goal !== 'string' || body.goal.length === 0) return { ok: false, error: 'goal is required' }
  if (typeof body.cwd !== 'string' || body.cwd.length === 0) return { ok: false, error: 'cwd is required' }
  if (!Array.isArray(body.slots) || body.slots.length === 0) return { ok: false, error: 'slots must be a non-empty array' }
  const slots: Array<{ id: string; vendor: Vendor; role: string; capabilities: string[]; model?: string; avatar?: string }> = []
  for (const raw of body.slots) {
    const slot = raw as { id?: unknown; vendor?: unknown; role?: unknown; capabilities?: unknown; model?: unknown; avatar?: unknown }
    if (typeof slot.id !== 'string' || typeof slot.vendor !== 'string' || typeof slot.role !== 'string') {
      return { ok: false, error: 'each slot needs id/vendor/role' }
    }
    if (!['claude', 'codex', 'dsh', 'ark', 'opencode'].includes(slot.vendor)) return { ok: false, error: `unknown vendor: ${slot.vendor}` }
    slots.push({
      id: slot.id,
      vendor: slot.vendor as Vendor,
      role: slot.role,
      capabilities: Array.isArray(slot.capabilities) ? (slot.capabilities as string[]) : [],
      model: typeof slot.model === 'string' ? slot.model : undefined,
      avatar: typeof slot.avatar === 'string' && (AGENT_AVATARS as readonly string[]).includes(slot.avatar) ? slot.avatar : undefined,
    })
  }
  // 预算（P2 token 主计价）：缺省 $3 安全兜底；显式 0/负数 = 不限（事实无限）；
  // token 上限可选——设了则以 token 熔断为主闸
  const budgetUsd = typeof body.budget_usd === 'number' && body.budget_usd > 0 ? body.budget_usd
    : typeof body.budget_usd === 'number' ? UNLIMITED_BUDGET_USD
    : 3
  const budgetTokens = typeof body.budget_tokens === 'number' && body.budget_tokens > 0 ? body.budget_tokens : undefined
  return { ok: true, value: { name: body.name, goal: body.goal, cwd: body.cwd, budgetUsd, budgetTokens, slots, plan: body.plan } }
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
                budget_tokens: snapshot.mission.budget_tokens ?? null,
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
            depends_on: t.depends_on,
          })),
          slots: snapshot.slots.map((s) => ({
            id: s.id,
            role: s.role,
            vendor: s.vendor,
            status: s.status,
            ctx_usage_pct: s.ctx_usage_pct,
            avatar: s.avatar ?? null,
          })),
          pending_approvals: snapshot.pendingApprovals.map((a) => ({
            id: a.id,
            summary: a.patch.summary,
            worktree_path: a.patch.worktree_path,
          })),
          ledger: current.ledgerTail(),
          experiments: snapshot.experiments,
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
        // after_id 为精确游标（同毫秒事件不会被跳过）；缺省回退 ts 游标，旧客户端不受影响
        const afterId = (url.searchParams.get('after_id') ?? '').trim()
        const tail = current.eventsTail(after, afterId.length > 0 ? afterId : undefined)
        writeJson(res, 200, { events: tail.events, cursor: tail.cursor, has_more: tail.has_more })
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
      // 设置页「选择仓库目录」的数据源（P2 点选化）：只列目录名，只读，loopback-only。
      // 不依赖 mission runtime（无 mission 也要能先选路径）。
      kind: 'exact',
      path: '/api/dsh-pod/fs/browse',
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const raw = url.searchParams.get('path') ?? ''
        try {
          writeJson(res, 200, browseDirectories(raw))
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
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
          console.error('[dsh-pod] route handler failed:', error)
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
          console.error('[dsh-pod] route handler failed:', error)
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
        // W4「记住规则」：approve 可选是否生成同类免弹卡规则（默认 true）
        const rememberRule = body?.remember_rule !== false
        // apply_patch 单入口：合并成功才裁决 mission done；冲突保持 awaiting_approval（CR-05-3）
        const result = await current.approve(approvalId, 'canvas-ui', edited, rememberRule)
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
          console.error('[dsh-pod] route handler failed:', error)
          writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-pod/plan',
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
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        const body = await readJsonBody(req)
        const action = body?.action
        if (typeof action !== 'string') {
          writeJson(res, 422, { error: 'action is required (list | add | replan)' })
          return
        }
        try {
          if (action === 'list') {
            const st = current.status()
            writeJson(res, 200, {
              mission_status: st.mission?.status ?? null,
              planner: current.hasPlannerCapability(),
              replan_remaining: current.replanRemaining(),
              tasks: st.tasks.map((t) => ({ id: t.id, title: t.title, type: t.type, status: t.status, depends_on: t.depends_on })),
            })
            return
          }
          if (action === 'add') {
            const raw = body?.tasks
            if (!Array.isArray(raw) || raw.length === 0) {
              writeJson(res, 422, { error: 'tasks must be a non-empty array' })
              return
            }
            const tasks: PlanTaskInput[] = []
            for (const item of raw as Array<Record<string, unknown>>) {
              const t = item as { id?: unknown; title?: unknown; spec?: unknown; type?: unknown; skill_tags?: unknown; depends_on?: unknown }
              if (typeof t.id !== 'string' || typeof t.title !== 'string' || typeof t.spec !== 'string' || typeof t.type !== 'string') {
                writeJson(res, 422, { error: 'each task needs id/title/spec/type' })
                return
              }
              if (!['implement', 'review', 'test', 'doc', 'research'].includes(t.type)) {
                writeJson(res, 422, { error: `unknown task type: ${t.type}` })
                return
              }
              tasks.push({
                id: t.id, title: t.title, spec: t.spec,
                type: t.type as PlanTaskInput['type'],
                skill_tags: Array.isArray(t.skill_tags) ? (t.skill_tags as string[]) : [],
                depends_on: Array.isArray(t.depends_on) ? (t.depends_on as string[]) : [],
              })
            }
            const created = current.addPlanTasks(tasks)
            writeJson(res, 200, { added: created.map((t) => t.id) })
            return
          }
          if (action === 'replan') {
            const reason = typeof body?.reason === 'string' ? (body?.reason as string) : 'replan via http'
            writeJson(res, 200, current.requestReplan(reason))
            return
          }
          writeJson(res, 422, { error: `unknown action: ${action}` })
        } catch (error) {
          console.error('[dsh-pod] route handler failed:', error)
          writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      // 会话中心（P2）：mission 历史 = 会话列表；active/归档同构（store 唯一事实源）。
      kind: 'exact',
      path: '/api/dsh-pod/missions',
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
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        writeJson(res, 200, { missions: current.missionSummaries() })
      },
    },
    {
      // 历史会话回看：任意 mission 的归档快照（对话流/任务/槽位/审批/账本）。
      kind: 'exact',
      path: '/api/dsh-pod/missions/detail',
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
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = url.searchParams.get('id') ?? ''
        const archive = id.length > 0 ? current.missionArchive(id) : undefined
        if (archive === undefined) {
          writeJson(res, 404, { error: `mission not found: ${id}` })
          return
        }
        writeJson(res, 200, archive)
      },
    },
    {
      // 合并审批详情：完整审批记录 + 可读 diff（白名单根内）。
      kind: 'exact',
      path: '/api/dsh-pod/approvals/detail',
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
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = url.searchParams.get('id') ?? ''
        const detail = id.length > 0 ? current.approvalDetail(id) : undefined
        if (detail === undefined) {
          writeJson(res, 404, { error: `approval not found: ${id}` })
          return
        }
        writeJson(res, 200, detail)
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
          console.error('[dsh-pod] route handler failed:', error)
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
          console.error('[dsh-pod] route handler failed:', error)
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
        // DELETE：撤销已记住的规则（此前只有 GET/POST 两个分支，规则只增不减——
        // 「记住规则」或手工 addRule 生成的规则无法移除，只能直接改磁盘文件）
        if (req.method === 'DELETE') {
          const target = new URL(req.url ?? '/', 'http://localhost')
          const ruleId = (target.searchParams.get('id') ?? '').trim()
          if (ruleId.length === 0) {
            writeJson(res, 422, { error: 'id is required' })
            return
          }
          try {
            current.deleteRule(ruleId)
            writeJson(res, 200, { ok: true })
          } catch (error) {
            // store.deleteRule 对不存在的 id 抛 NotFoundError（幂等破坏要显式暴露）
            if (error instanceof NotFoundError) {
              writeJson(res, 404, { error: error.message })
              return
            }
            console.error('[dsh-pod] route handler failed:', error)
            writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
          }
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
          console.error('[dsh-pod] route handler failed:', error)
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
          console.error('[dsh-pod] route handler failed:', error)
          writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
}

/** 供路由与客户端共用的任务类型/供应商枚举（schema 校验引用）。 */
export type { TaskType, Vendor }
