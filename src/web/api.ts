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
  pending_approvals: Array<{ id: string; summary: string }>
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
