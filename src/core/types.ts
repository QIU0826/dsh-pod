/**
 * Pod 数据模型 —— 方案书 3.4 节的数据模型与 2.5/3.5 节交接契约。
 * 全部为纯类型与常量，禁止任何运行时副作用。
 */

export type Vendor = 'dsh' | 'claude' | 'codex'

/** 会话生命周期三档（方案书 3.2 节 / D2）。 */
export type SessionTier = 'transient' | 'per-mission' | 'auto-reset'

/** 员工状态灯（Canvas 左栏）。 */
export type SlotStatus =
  | 'idle'
  | 'working'
  | 'waiting_approval'
  | 'error'
  | 'stopped'
  | 'rate_limited'

/** review 是任务类型不是状态分支（D3）。 */
export type TaskType = 'implement' | 'review' | 'plan' | 'test' | 'doc' | 'research'

export type TaskStatus =
  | 'ready'
  | 'dispatched'
  | 'running'
  | 'done'
  | 'blocked'
  | 'escalated'

export type MissionStatus =
  | 'planning'
  | 'running'
  | 'awaiting_approval'
  | 'done'
  | 'paused'
  | 'aborted'

/**
 * 故障分类全集（方案书 3.4 节故障表 + CR-01-6 wall_clock + need_clarify 工作流分支）。
 * 只有计入 attempts 的故障才消耗重试次数：rate_limited / need_clarify 不计入。
 */
export type FaultKind =
  | 'crash'
  | 'idle_timeout'
  | 'wall_clock'
  | 'rate_limited'
  | 'auth_expired'
  | 'stream_broken'
  | 'silent_failure'
  | 'mismatch'
  | 'need_clarify'

/** 审批模式（2.6 节）：MVP 仅实现模式 1。 */
export type ApprovalMode = 1 | 2 | 3

/** 投递模式（2.5 节）：queue 默认 / memory。 */
export type HandoffMode = 'queue' | 'memory'

/**
 * 账本诚实化（D7 / CR-01-5）：token 来源必须如实标注；
 * unavailable 表示该后端不产出 usage 数据，UI 显式标注「无数据」，禁止编造。
 */
export type UsageSource = 'measured' | 'unavailable'

/** 编排来源：commander LLM 或手动模式（3.3 节）。 */
export type OrchestrationMode = 'commander' | 'manual'

export interface Mission {
  id: string
  name: string
  goal: string
  status: MissionStatus
  /** 美元预算（claude --max-budget-usd 双熔断对齐）。 */
  budget_usd: number
  /** token 预算上限（2.3 节⑤），可选：未设则仅美元熔断。 */
  budget_tokens?: number
  /** 实测 token 花费（权威列）。 */
  spent_tokens: number
  /** 等效美元估算（非实际支付，UI 必须标注）。 */
  spent_equiv_usd: number
  approval_mode: ApprovalMode
  cwd: string
  /** 默认每员工一个 worktree（MVP 策略）。 */
  worktree_policy: 'per-slot'
  orchestration_mode: OrchestrationMode
  /** commander watchdog 触发过 → manual（3.3 节）。 */
  commander_healthy: boolean
  /** 审批挂起截止（CR-01-7）：超过则自动 pause + 告警。 */
  approval_stale_at?: number
  created_at: number
  updated_at: number
}

export interface AgentSlot {
  id: string
  mission_id: string
  vendor: Vendor
  role: string
  capabilities: string[]
  model: string
  effort: 'low' | 'medium' | 'high'
  session_ref?: string
  session_tier: SessionTier
  status: SlotStatus
  tokens_in: number
  tokens_out: number
  /** 上下文占用估算（tokens_in+out / 窗口大小，档位 C 判定用）。 */
  ctx_usage_pct: number
  window_tokens: number
  worktree_path?: string
}

export interface Task {
  id: string
  mission_id: string
  title: string
  spec: string
  skill_tags: string[]
  owner_slot_id?: string
  type: TaskType
  depends_on: string[]
  status: TaskStatus
  attempts: number
  /** 重试不计入的 attempts 计数（429 / need_clarify），仅观察。 */
  soft_attempts: number
  fault?: FaultKind
  last_error?: string
  /** 429 指数退避后的最早重试时刻（epoch ms）。 */
  next_retry_at?: number
  commit_sha?: string
  /** 任务 commit 的父 commit（CR-01-3：并行任务串行合并后 diff_range 校验基准）。 */
  parent_sha?: string
  result_ref?: string
  /** 任务级墙钟上限（CR-01-6，默认 60 分钟）。 */
  max_wall_clock_ms: number
  started_at?: number
  dispatched_at?: number
  done_at?: number
  escalated_at?: number
  created_at: number
  updated_at: number
}

/** 交接消息四件套 + 第五项产物校验（2.5 节 / 附录 B）。 */
export interface HandoffPayload {
  intent: {
    brief: string
    constraints: string[]
    acceptance: string
  }
  artifacts: {
    spec: string
    context_files: string[]
    base_commit?: string
    diff_range?: string
  }
  state: {
    tried: string[]
    blockers: string[]
  }
  expected_output: string
  verify: string[]
}

export interface Handoff {
  id: string
  mission_id: string
  from_slot: string
  to_slot: string
  task_id: string
  payload: HandoffPayload
  mode: HandoffMode
  ts: number
}

export interface LedgerEntry {
  mission_id: string
  slot_id: string
  task_id?: string
  model: string
  ts: number
  tokens_in: number
  tokens_out: number
  /** 等效美元（估算）。 */
  equiv_usd: number
  /** 价目表版本号（D7：估算必须标注版本）。 */
  price_table_version: string
  usage_source: UsageSource
}

export interface ApprovalRequest {
  id: string
  mission_id: string
  /** 待合并的 patch 描述：worktree 路径 + commit 区间。 */
  patch: {
    slot_id: string
    worktree_path: string
    base_commit?: string
    head_commit?: string
    diff_path?: string
    summary: string
  }
  status: 'pending' | 'approved' | 'denied' | 'stale'
  created_at: number
  decided_at?: number
  decided_by?: string
  deny_reason?: string
}

/** MISSION_REPORT（附录 C schema，强制 JSON）。 */
export interface MissionReport {
  task_id: string
  task_type: TaskType
  status: 'done' | 'blocked' | 'need_clarify'
  summary: string
  files_changed: string[]
  commit_sha?: string
  diff_path?: string
  test_command?: string
  test_result: 'pass' | 'fail' | 'not_run'
  test_evidence?: string
  decisions: string[]
  blockers: string[]
  questions: string[]
  usage?: {
    tokens_in: number
    tokens_out: number
  }
}

/** Canvas 事件流（team 级事件，磁盘持久化，跨重启可见）。 */
export interface PodEvent {
  id: string
  mission_id: string
  ts: number
  kind: string
  slot_id?: string
  task_id?: string
  payload: Record<string, unknown>
}

/** 统一后端接口（3.2 节）。 */
export interface WorkerProgressEvent {
  slot_id: string
  task_id: string
  ts: number
  kind: 'text' | 'tool_call' | 'file_change' | 'test_output' | 'usage' | 'system'
  text?: string
  tool?: string
  file?: string
  tokens_in?: number
  tokens_out?: number
}

export type WorkerExit =
  | 'done'
  | 'failed'
  | 'killed'
  | 'timeout'
  | 'rate_limited'

export interface WorkerCompletion {
  exit: WorkerExit
  report?: MissionReport
  usage: { tokens_in: number; tokens_out: number; source: UsageSource }
  artifacts: string[]
  exit_code?: number
  signal?: string
}

export interface WorkerBackend {
  readonly vendor: Vendor
  detect(): Promise<{
    installed: boolean
    authed: boolean
    models: string[]
    version?: string
    session_tiers: SessionTier[]
    error?: string
  }>
  start(slot: AgentSlot, task: Task, worktree: string): Promise<WorkerHandle>
  kill(handle: WorkerHandle): Promise<void>
}

export interface WorkerHandle {
  pid?: number
  session_ref?: string
}

/** 默认档位（2.3 节⑤ / O7）：claude=per-mission 持久，codex=瞬时。 */
export const DEFAULT_SESSION_TIERS: Record<Vendor, SessionTier> = {
  claude: 'per-mission',
  codex: 'transient',
  dsh: 'transient',
}

/** 档位 C 自动重置阈值：上下文占用 70%（3.2 节）。 */
export const CTX_RESET_THRESHOLD_PCT = 70

/** 重试上限：attempts ≥ 3 → 转人工（3.4 节）。 */
export const MAX_TASK_ATTEMPTS = 3

/** 任务级墙钟默认上限（CR-01-6）。 */
export const DEFAULT_MAX_WALL_CLOCK_MS = 60 * 60 * 1000

/** 审批卡处理期限（CR-01-7）。 */
export const APPROVAL_STALE_MS = 7 * 24 * 60 * 60 * 1000

/** 429 指数退避参数（3.4 节故障表）。 */
export const RATE_LIMIT_BACKOFF_BASE_MS = 5_000
export const RATE_LIMIT_BACKOFF_MAX_MS = 10 * 60 * 1000

/** commander watchdog 默认静默阈值（3.3 节，默认 5 分钟）。 */
export const COMMANDER_WATCHDOG_MS = 5 * 60 * 1000

/** 任务空闲 watchdog 默认阈值（3.2 节，默认 15 分钟）。 */
export const TASK_IDLE_WATCHDOG_MS = 15 * 60 * 1000

/** 单 mission 并行任务数上限（3.8 节 fan-out 限流）。 */
export const MAX_PARALLEL_TASKS = 2

/** 单 mission 员工数上限（3.8 节）。 */
export const MAX_SLOTS = 8
