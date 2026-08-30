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
  ledger: {
    total_tokens: number
    total_equiv_usd: number
    entries: LedgerEntry[]
    /** 按任务类型（执行阶段）归因：plan/implement/review/…；无任务归属归入 unknown。 */
    by_stage?: Record<string, { tokens: number; equiv_usd: number; entries: number }>
  }
  runStatus?: string
  /** 演示模式（--demo）：agent 为脚本演员，不执行真实任务。 */
  demo?: boolean
  /** 无活跃会话时，最近一次会话崩溃的原因（终态会话事件已从流中过滤，靠此字段直达用户）。 */
  last_error?: string
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

/** 事件分页（服务端按最早一批返回；has_more 表示还有下一批，按 cursor 续读）。 */
export interface EventsPage {
  events: PodEvent[]
  /** 下一批的精确游标（最后一条事件的 id）；本批为空时回显上传入的游标。 */
  cursor: string
  has_more: boolean
}

/**
 * 事件尾部。afterId 为精确游标（同毫秒事件不会被跳过）；
 * 首次调用传空串，回退到 ts 语义取全量。
 */
export async function fetchEvents(afterId: string, afterTs = 0): Promise<EventsPage> {
  const params = new URLSearchParams()
  if (afterId.length > 0) params.set('after_id', afterId)
  else params.set('after', String(afterTs))
  const response = await fetch(`/api/dsh-pod/events?${params.toString()}`, { cache: 'no-store' })
  return readJson<EventsPage>(response)
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
  tasks: Array<StatusTask & { spec?: string }>
  slots: StatusSlot[]
  approvals: Array<{ id: string; status: string; decided_at: number | null; task_id: string | null; summary: string; worktree_path: string; kind: string }>
  ledger: {
    total_tokens: number
    total_equiv_usd: number
    entries: Array<{ model: string; tokens_in: number; tokens_out: number; equiv_usd: number; ts: number }>
    by_stage?: Record<string, { tokens: number; equiv_usd: number; entries: number }>
  }
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
  /** 并行执行上限（1-8）。 */
  parallel?: number
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

/**
 * 任务换人：kill 旧进程 + 交接四件套落盘 + 事件审计，任务置 ready 由调度重派。
 * reason 必填（进交接 intent 与事件审计），后端拒绝空值。
 */
export function postReassign(taskId: string, toSlotId: string, reason: string): Promise<{ ok: boolean; handoff_id: string }> {
  return postJson('/api/dsh-pod/reassign', { task_id: taskId, to_slot_id: toSlotId, reason })
}

/** 终止当前 mission。 */
export function postAbort(reason: string): Promise<{ ok: boolean }> {
  return postJson('/api/dsh-pod/abort', { reason })
}

/** 暂停当前 mission（paused 落盘，可恢复；非法状态由后端回 409）。 */
export function postPause(): Promise<{ ok: boolean; paused: boolean }> {
  return postJson('/api/dsh-pod/pause', {})
}

/** 恢复已暂停的 mission（去向由 pending 审批卡决定：running 或 awaiting_approval）。 */
export function postResume(): Promise<{ ok: boolean; resumed: boolean }> {
  return postJson('/api/dsh-pod/resume', {})
}

/** 人工裁决转人工任务（对话式问题卡的「继续」路径）：blocked = 带答案重派。 */
export function postResolve(taskId: string, outcome: 'done' | 'blocked', note?: string): Promise<{ ok: boolean; message?: string }> {
  return postJson('/api/dsh-pod/resolve', { task_id: taskId, outcome, note })
}

/** 任务级暂停（InProgress→Paused）：终止在途进程，不消费 attempts。 */
export function postTaskPause(taskId: string): Promise<{ ok: boolean; task_id: string; status: string }> {
  return postJson('/api/dsh-pod/task/pause', { task_id: taskId })
}

/** 任务级恢复（Paused→ready→重新协商派发，可能换 agent）。 */
export function postTaskResume(taskId: string): Promise<{ ok: boolean; task_id: string; status: string }> {
  return postJson('/api/dsh-pod/task/resume', { task_id: taskId })
}

/** 审批规则（AgentScope-A/B：命中优先的裁决规则 + 「记住规则」沉淀）。 */
export interface ApprovalRuleView {
  id: string
  tool: string
  pattern?: string
  decision: 'allow' | 'deny' | 'ask'
  scope: 'mission' | 'global'
  source?: string
  ts: number
}

async function deleteJson<T>(path: string): Promise<T> {
  return readJson<T>(await fetch(path, { method: 'DELETE' }))
}

export async function fetchRules(): Promise<{ rules: ApprovalRuleView[] }> {
  return readJson<{ rules: ApprovalRuleView[] }>(await fetch('/api/dsh-pod/rules', { cache: 'no-store' }))
}

/** 「记住此规则」：此后同类调用免重复审批。 */
export function postRule(input: {
  tool: string
  pattern?: string
  decision: 'allow' | 'deny' | 'ask'
  scope?: 'mission' | 'global'
}): Promise<{ ok: boolean; rule: ApprovalRuleView }> {
  return postJson('/api/dsh-pod/rules', { ...input })
}

/** 撤销规则——误建的规则（含自动记住的）此前只能手工改磁盘文件。 */
export function deleteRule(ruleId: string): Promise<{ ok: boolean }> {
  return deleteJson<{ ok: boolean }>('/api/dsh-pod/rules?id=' + encodeURIComponent(ruleId))
}

/* ── 长期记忆（2.8.1 知识层）：HTTP 面此前缺失，只有 pod_mem_* 工具能给 LLM 用 ── */

export type MemoryType = 'lesson' | 'pattern' | 'decision' | 'fact' | 'episode'
export type MemoryRelation = 'supports' | 'contradicts' | 'derived-from'

export interface MemoryRecordView {
  id: string
  owner_slot_id: string
  type: MemoryType
  importance: number
  tags: string[]
  content_ref: string
  live_ref?: string
  ts: number
}

export interface MemoryQueryInput {
  owner?: string
  type?: MemoryType
  tags?: string[]
  importance_min?: number
  relates_to?: string
  relation?: MemoryRelation
  limit?: number
}

export async function fetchMemories(q: MemoryQueryInput = {}): Promise<{ records: MemoryRecordView[] }> {
  const params = new URLSearchParams()
  if (q.owner !== undefined) params.set('owner', q.owner)
  if (q.type !== undefined) params.set('type', q.type)
  if (q.tags !== undefined && q.tags.length > 0) params.set('tags', q.tags.join(','))
  if (q.importance_min !== undefined) params.set('importance_min', String(q.importance_min))
  if (q.relates_to !== undefined) params.set('relates_to', q.relates_to)
  if (q.relation !== undefined) params.set('relation', q.relation)
  if (q.limit !== undefined) params.set('limit', String(q.limit))
  const suffix = params.toString()
  const url = suffix.length > 0 ? `/api/dsh-pod/memory?${suffix}` : '/api/dsh-pod/memory'
  return readJson<{ records: MemoryRecordView[] }>(await fetch(url, { cache: 'no-store' }))
}

export function postMemory(input: {
  owner_slot_id: string
  type?: MemoryType
  importance?: number
  tags?: string[]
  content_ref?: string
  live_ref?: string
}): Promise<{ ok: boolean; record: MemoryRecordView }> {
  return postJson('/api/dsh-pod/memory', input)
}

/**
 * 纠正记忆（保留变更历史，可审计）。
 * 注意 MemoryStore 没有删除记录的接口——记录只能纠正，不能撤销。
 */
export function postMemoryCorrect(
  id: string,
  patch: { type?: MemoryType; importance?: number; tags?: string[]; content_ref?: string; live_ref?: string },
): Promise<{ ok: boolean; record: MemoryRecordView }> {
  return postJson('/api/dsh-pod/memory/correct', { id, ...patch })
}

/* ── 定时任务：HTTP 面此前缺失，只能靠 pod_cron_list 工具看 ── */

export interface CronJobView {
  id: string
  /** 触发周期（ms）。 */
  intervalMs: number
  /** 默认关（外部入口显式启用才开放）。 */
  enabled: boolean
  label?: string
  lastFiredAt?: number
  command: { kind: string; goal?: string; instruction?: string; [key: string]: unknown }
}

export interface CronFireView {
  job_id: string
  fired: boolean
  reason: string
  reply_text?: string
  reply_ok?: boolean
  ts: number
}

export async function fetchCron(): Promise<{ jobs: CronJobView[]; recent: CronFireView[] }> {
  return readJson<{ jobs: CronJobView[]; recent: CronFireView[] }>(await fetch('/api/dsh-pod/cron', { cache: 'no-store' }))
}
