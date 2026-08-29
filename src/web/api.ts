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
  /** 最近错误（blocked/escalated 时的故障描述）。 */
  last_error?: string | null
}

export interface StatusSlot {
  id: string
  role: string
  vendor: string
  status: string
  ctx_usage_pct: number
  /** 毕加索动物形象 id（可空 = 未设置）。 */
  avatar?: string | null
  /** 账本与档位展示（服务端 AgentSlot 全量字段中 UI 用到的子集）。 */
  model?: string
  tokens_in?: number
  tokens_out?: number
  capabilities?: string[]
  worktree_path?: string
}

/** 账本条目（status.ledger.entries；P0 修复前 UI 误把 ledger 当数组——黑屏根因）。 */
export interface LedgerEntry {
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
}

export interface StatusResponse {
  mission: {
    id: string
    status: string
    goal: string
    spent_tokens: number
    spent_equiv_usd: number
    budget_usd: number
    budget_tokens?: number | null
    name?: string
  } | null
  tasks: StatusTask[]
  slots: StatusSlot[]
  pending_approvals: Array<{ id: string; summary: string; worktree_path: string }>
  experiments: { topology_animation: boolean; canvas_third_column: boolean }
  ledger: { total_tokens: number; total_equiv_usd: number; entries: LedgerEntry[] }
  runStatus?: string
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

/** 目录点选器数据（设置页选仓库路径）：服务端只列目录名。 */
export interface BrowseResponse {
  path: string
  parent: string | null
  entries: string[]
  roots: string[] | null
  home: string
}

export async function fetchBrowse(path: string): Promise<BrowseResponse> {
  return readJson<BrowseResponse>(
    await fetch(`/api/dsh-pod/fs/browse?path=${encodeURIComponent(path)}`, { cache: 'no-store' }),
  )
}

/** 会话摘要（会话列表行）。 */
export interface MissionSummary {
  id: string
  name: string
  goal: string
  status: string
  budget_usd: number
  budget_tokens: number | null
  spent_tokens: number
  spent_equiv_usd: number
  created_at: number
  updated_at: number
  task_total: number
  task_done: number
  tokens_in: number
  tokens_out: number
  slots: Array<{ id: string; role: string; vendor: string; avatar: string | null }>
  last_event: { kind: string; ts: number; task_id?: string } | null
  active: boolean
}

export async function fetchMissions(): Promise<MissionSummary[]> {
  const body = await readJson<{ missions: MissionSummary[] }>(
    await fetch('/api/dsh-pod/missions', { cache: 'no-store' }),
  )
  return body.missions
}

/** 历史会话归档快照（对话流/任务/槽位/审批/账本回看）。 */
export interface MissionArchive {
  mission: { id: string; name: string; goal: string; status: string; budget_usd: number; budget_tokens?: number | null; spent_tokens: number; spent_equiv_usd: number; created_at: number }
  tasks: StatusTask[]
  slots: StatusSlot[]
  approvals: Array<{ id: string; status: string; decided_at: number | null; task_id: string | null; summary: string; worktree_path: string; kind: string }>
  ledger: { total_tokens: number; total_equiv_usd: number; entries: Array<{ model: string; tokens_in: number; tokens_out: number; equiv_usd: number; ts: number }> }
  events: PodEvent[]
}

export async function fetchMissionArchive(missionId: string): Promise<MissionArchive> {
  return readJson<MissionArchive>(
    await fetch(`/api/dsh-pod/missions/detail?id=${encodeURIComponent(missionId)}`, { cache: 'no-store' }),
  )
}

/** 审批详情（合并审批页）。 */
export interface ApprovalDetail {
  id: string
  mission_id: string
  kind: string
  task_id: string | null
  status: string
  decided_at: number | null
  summary: string
  worktree_path: string
  base_commit: string | null
  head_commit: string | null
  diff: string | null
}

export async function fetchApprovalDetail(approvalId: string): Promise<ApprovalDetail> {
  return readJson<ApprovalDetail>(
    await fetch(`/api/dsh-pod/approvals/detail?id=${encodeURIComponent(approvalId)}`, { cache: 'no-store' }),
  )
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

/** 人工裁决转人工任务（对话式问题卡的「继续」路径）：blocked = 带答案重派。 */
export function postResolve(taskId: string, outcome: 'done' | 'blocked', note?: string): Promise<{ ok: boolean; message?: string }> {
  return postJson('/api/dsh-pod/resolve', { task_id: taskId, outcome, note })
}
