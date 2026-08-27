/**
 * 浏览器半 API 客户端（W3/W4）——同源 fetch（dsh-ssh 实证路径，不做私有传输假设）。
 */

export interface StatusTask {
  id: string
  title: string
  type: string
  status: string
  fault: string | null
  attempts: number
  owner: string | null
  commit: string | null
  /** v0.2 拓扑动画：任务 DAG 依赖（Canvas 拓扑图布局用）。 */
  depends_on: string[]
}

export interface StatusSlot {
  id: string
  role: string
  vendor: string
  status: string
  ctx_usage_pct: number
}

export interface StatusResponse {
  mission: {
    id: string
    status: string
    goal: string
    spent_tokens: number
    spent_equiv_usd: number
    budget_usd: number
  } | null
  tasks: StatusTask[]
  slots: StatusSlot[]
  pending_approvals: Array<{ id: string; summary: string; worktree_path: string }>
  experiments: { topology_animation: boolean; canvas_third_column: boolean }
  ledger: Array<{
    slot_id: string
    task_id: string | null
    model: string
    ts: number
    tokens_in: number
    tokens_out: number
    equiv_usd: number
    price_known: boolean
    price_table_version: string
    usage_source: string
  }>
  message: string
}

export interface PodEvent {
  id: string
  ts: number
  kind: string
  task_id?: string
  slot_id?: string
  payload: Record<string, unknown>
}

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`HTTP ${response.status}: invalid JSON response`)
  }
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `HTTP ${response.status}`
    throw new Error(message)
  }
  return body as T
}

export async function fetchStatus(): Promise<StatusResponse> {
  return readJson<StatusResponse>(await fetch('/api/dsh-pod/status', { cache: 'no-store' }))
}

export async function fetchEvents(afterTs: number): Promise<PodEvent[]> {
  const response = await fetch(`/api/dsh-pod/events?after=${afterTs}`, { cache: 'no-store' })
  const body = await readJson<{ events: PodEvent[] }>(response)
  return body.events
}

export interface LaunchPayload {
  name: string
  goal: string
  cwd: string
  budget_usd: number
  /** token 预算上限（可选，方案书 2.3 节⑤）。 */
  budget_tokens?: number
  slots: Array<{ id: string; vendor: string; role: string; capabilities: string[]; model?: string }>
}

export async function postLaunch(payload: LaunchPayload): Promise<{ mission_id: string; status: string }> {
  return readJson<{ mission_id: string; status: string }>(
    await fetch('/api/dsh-pod/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

async function postJson<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  return readJson<T>(
    await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

/** steer 指令排队（员工下次派单必带，CR-01-2）。 */
export function postSteer(slotId: string, instruction: string): Promise<{ ok: boolean }> {
  return postJson('/api/dsh-pod/steer', { slot_id: slotId, instruction })
}

/** 审批卡 approve（apply_patch 单入口合并；冲突返回 409）。edited = AS-3 人工编辑参数；rememberRule = W4 记住规则（默认 true）。 */
export function postApprove(approvalId: string, edited?: Record<string, string>, rememberRule = true): Promise<{ ok: boolean; message?: string }> {
  return postJson('/api/dsh-pod/approve', { approval_id: approvalId, edited, remember_rule: rememberRule })
}

/** 审批卡 deny（带原因落盘）。 */
export function postDeny(approvalId: string, reason: string): Promise<{ ok: boolean }> {
  return postJson('/api/dsh-pod/deny', { approval_id: approvalId, reason })
}

/** 手动模式：直连状态机派单一次（3.3 节）。 */
export function postDispatch(): Promise<{ dispatched: boolean }> {
  return postJson('/api/dsh-pod/dispatch', {})
}

/** 终止当前 mission。 */
export function postAbort(reason: string): Promise<{ ok: boolean }> {
  return postJson('/api/dsh-pod/abort', { reason })
}
