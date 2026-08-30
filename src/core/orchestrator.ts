/**
 * Commander 编排器 —— 方案书 3.3 节编排层 + W2 最小可演示链的引擎。
 *
 * 架构不变量落地（3.3 节四条）：
 *   1. LLM 提议、代码裁决：所有状态迁移经 TaskMachine/MissionMachine，编排器只做合法事件；
 *   2. 原始事件永不进 commander 上下文：进度只进磁盘与 Canvas（store events）；
 *   3. 审批/收集/合并只走代码入口：report/approve 全部经本模块与状态机，无 bash 旁路；
 *   4. 员工进程是沙箱边界：worktree 隔离 + 后端进程白名单（各后端参数组装已实现）。
 *
 * 质量门（DoD-5）：review 任务派发时排除被审任务的实现者槽位；无人可派 → 转人工。
 * 单路并行（D8）：MAX_PARALLEL_TASKS=2，拓扑就绪才派发。
 * CR-01-2：steer 指令排队，员工下次派单必带。
 * 预算熔断（2.7 节）：usage 超限 → 自动 pause + 告警事件。
 * watchdog 接线（3.3/3.4 节）：派发 arm 空闲计时，事件/完成刷新，超时 kill + idle_timeout。
 *
 * 全依赖注入（store/backends/worktree/clock/verify）：CLI 级与插件级共用同一引擎。
 */

import { ApprovalEngine } from './approvals.js'
import { routeTask } from './dispatcher.js'
import { emitWorkerProgress, resetReplyCursor } from './events.js'
import { ConcurrencyLimitError, InvalidTransitionError, NotFoundError, PodError } from './errors.js'
import { buildHandoff } from './handoff.js'
import { Ledger } from './ledger.js'
import { MissionMachine } from './mission.js'
import { PLAN_TASK_SKILL, REPLAN_LIMIT, buildPlannerSpec, extractPlanProposal, hasPlannerSlot, validatePlanProposal } from './planner.js'
import { estimateCtxUsage } from './session-tiers.js'
import type { PodStore } from './store.js'
import { classifyFault, TaskMachine, type TaskVerifyFn } from './task-machine.js'
import type {
  AgentSlot,
  ApprovalRequest,
  FaultKind,
  Handoff,
  Mission,
  MissionReport,
  SessionTier,
  Task,
  TaskType,
  Vendor,
  WorkerBackend,
  WorkerCompletion,
  WorkerHandle,
  WorkerProgressEvent,
} from './types.js'
import { UNLIMITED_BUDGET_USD,
  DEFAULT_MAX_WALL_CLOCK_MS,
  DEFAULT_SESSION_TIERS,
  MAX_PARALLEL_TASKS,
  MAX_SLOTS,
  SAFE_ENTITY_ID,
} from './types.js'
import { Watchdog, type FiredWatchdog } from './watchdog.js'

export interface SlotInput {
  id: string
  vendor: Vendor
  role: string
  capabilities: string[]
  /** 模型名；空串/缺省 = 走该 CLI 的默认模型（codex/ChatGPT 内置约定，CR-03-1）。 */
  model?: string
  /** 毕加索动物形象 id（P2 UI 展示；白名单外剔除）。 */
  avatar?: string
  session_tier?: SessionTier
  window_tokens?: number
}

export interface LaunchInput {
  name: string
  goal: string
  cwd: string
  budgetUsd: number
  budgetTokens?: number
  /**
   * 审批模式（2.6 节，默认 1）：模式 2/3 需对应 experiments 灰度开关开启，
   * 否则 launch 拒绝（Berd-E 灰度纪律，默认关、fail-closed）。
   */
  approvalMode?: 1 | 2 | 3
  /**
   * 并行执行上限（v0.2 并行强化）：同一轮派发的并发任务数，默认 2（MAX_PARALLEL_TASKS）。
   * clamp 到 [1, MAX_PARALLEL_CEILING]。提升并行不改质量门/状态机，只放宽 fan-out。
   */
  parallel?: number
  slots: SlotInput[]
}

export interface PlanTaskInput {
  id: string
  title: string
  spec: string
  type: TaskType
  skill_tags?: string[]
  depends_on?: string[]
}

export interface WorktreeManager {
  /** 为槽位确保 worktree 存在并返回路径（默认每员工一个，3.7 节）。 */
  ensure(repoRoot: string, slotId: string): Promise<string>
}

export type RunStatus = 'awaiting_approval' | 'needs_human' | 'waiting_backoff' | 'budget_exceeded' | 'aborted' | 'done' | 'awaiting_dispatch' | 'paused'

export interface RunSummary {
  status: RunStatus
  doneTasks: string[]
  escalatedTasks: string[]
  pendingApprovals: string[]
  reason?: string
}

export interface OrchestratorDeps {
  store: PodStore
  backends: Partial<Record<Vendor, WorkerBackend>>
  worktree: WorktreeManager
  clock?: () => number
  verify?: TaskVerifyFn
  maxParallel?: number
  /**
   * 灰度开关（Berd-E）：审批模式 2/3 是否放行。测试注入内存桩；
   * 插件层注入 ~/.dsh/pod/experiments.json 承载实例。缺省全关（保守）。
   */
  experiments?: ExperimentsLike
  /**
   * review 任务的 diff 内容提供者（审查者最小上下文的强化实现，CR-03）：
   * 宿主机侧读取 diff 并注入审查提示词，审查者无需仓库命令权限即可独立审查。
   * 未提供时保持指针式交接（审查者自行读取）。
   */
  diffProvider?: (task: Task) => Promise<string>
  /**
   * 规划提案落盘回调（P1 规划层，DoD-2 plan.md 唯一事实源的接线点）：
   * planner 任务完成且提案通过代码裁决后调用；pod-service 借此写 plan.md。
   * 回调抛错只记日志不阻断（plan.md 是回溯面，不是执行面）。
   */
  onPlanExpanded?: (missionId: string, plan: PlanTaskInput[], sourceTaskId: string) => void
}

/** 注入审查提示词的 diff 长度上限（超限截断并标注，防窗口爆炸）。 */
export const MAX_REVIEW_DIFF_CHARS = 120_000

/** 并行执行上限的硬顶（v0.2 并行强化，防 fan-out 失控；仍受 MAX_SLOTS 约束）。 */
export const MAX_PARALLEL_CEILING = 8

/** slot/task id 白名单（P1）：定义已移至 types.ts（orchestrator/planner 共享），此处 re-export 兼容旧引用。 */
export { SAFE_ENTITY_ID } from './types.js'

/** 灰度开关的极小结构化接口（避免硬依赖 Experiments 实现，测试可注入桩）。 */
export interface ExperimentsLike {
  isEnabled(key: string): boolean
}

/** 审批模式 → experiments 开关 key 映射（2.6 节 v2.2 / Berd-E）。 */
export const APPROVAL_MODE_EXPERIMENT_KEYS: Record<2 | 3, string> = {
  2: 'approval-mode-2',
  3: 'approval-mode-3',
}

interface WakeLatch {
  fired: boolean
  resolve?: () => void
}

/** 停摆兜底窗口：active 任务无落盘进展超过此时长 → 故障化重派。 */
const STALL_TIMEOUT_MS = 3 * 60_000

export class MissionOrchestrator {
  private readonly store: PodStore
  private readonly backends: Partial<Record<Vendor, WorkerBackend>>
  private readonly worktree: WorktreeManager
  private readonly clock: () => number
  private readonly approvals: ApprovalEngine
  private readonly ledger: Ledger
  private readonly missionMachine: MissionMachine
  private readonly taskMachine: TaskMachine
  private readonly watchdog: Watchdog
  /** 宿主层归属判定用（僵尸 mission 自愈：PodService 对比当前编排器归属）。 */
  readonly missionId: string
  private maxParallel: number
  private readonly diffProvider: ((task: Task) => Promise<string>) | undefined
  private readonly onPlanExpanded: ((missionId: string, plan: PlanTaskInput[], sourceTaskId: string) => void) | undefined
  private readonly experiments: ExperimentsLike
  private readonly handles = new Map<string, WorkerHandle>()
  private readonly queuedSteer = new Map<string, string[]>()
  private readonly wakeLatch: WakeLatch = { fired: false }
  private stopRequested = false
  /** 本次 stopRequested 的语义（summarize 据此区分 paused/budget_exceeded/aborted）。 */
  private stopReason: 'user' | 'budget' | 'abort' | undefined
  /** 在途驱动循环的 promise：run() 重入守卫（防双循环并发派发同一任务，审计 M13）。 */
  private currentRun: Promise<RunSummary> | undefined
  /** P1 规划层：plan 任务序号（P-1、P-2…）与已用重规划次数（REPLAN_LIMIT 门控）。 */
  private planSeq = 0
  private replansUsed = 0

  constructor(missionId: string, deps: OrchestratorDeps) {
    this.missionId = missionId
    this.store = deps.store
    this.backends = deps.backends
    this.worktree = deps.worktree
    this.clock = deps.clock ?? (() => Date.now())
    this.maxParallel = deps.maxParallel ?? MAX_PARALLEL_TASKS
    this.diffProvider = deps.diffProvider
    this.onPlanExpanded = deps.onPlanExpanded
    this.experiments = deps.experiments ?? { isEnabled: () => false }
    this.approvals = new ApprovalEngine(this.store, { clock: this.clock })
    this.ledger = new Ledger(this.store, { clock: this.clock })
    this.missionMachine = new MissionMachine(this.store, this.approvals, missionId, { clock: this.clock })
    this.taskMachine = new TaskMachine(this.store, { clock: this.clock, verify: deps.verify, missionId })
    this.watchdog = new Watchdog({ clock: this.clock })
  }

  // ── 组装阶段 ──────────────────────────────────────────────────────────

  /** 创建 mission + 名册（单 active mission / fan-out 上限，2.12/3.8 节）。 */
  launch(input: LaunchInput): Mission {
    // P1 路径逃逸防护（fail-fast，先于任何落盘）：slot id 拼进 worktree 路径
    // （join(cwd,'.pod-worktrees',slotId)），含 ../ 或分隔符的 id 可把 worktree 建到仓库外
    for (const slotInput of input.slots) {
      if (!SAFE_ENTITY_ID.test(slotInput.id)) {
        throw new PodError(
          `slot id rejected (allowed: letters/digits/._- , no path separators): ${slotInput.id}`,
          'INVALID_ID',
          { slotId: slotInput.id },
        )
      }
    }
    if (this.store.getActiveMission() !== undefined) {
      throw new ConcurrencyLimitError(1, 'another mission is active; finish or abort it first')
    }
    if (input.slots.length > MAX_SLOTS) {
      throw new ConcurrencyLimitError(MAX_SLOTS, `slot count ${input.slots.length}`)
    }
    // v0.2 并行强化：launch 级 `parallel` 覆盖注入式默认 maxParallel，clamp 到 [1, MAX_PARALLEL_CEILING]
    if (input.parallel !== undefined) {
      this.maxParallel = Math.max(1, Math.min(MAX_PARALLEL_CEILING, Math.floor(input.parallel)))
    }
    // 审批模式灰度门（Berd-E）：模式 2/3 需对应 experiments 开关开启；默认关，fail-closed。
    // 未开启却请求模式 2/3 → 拒绝 launch（不静默降级回 1，纪律明确）。
    const approvalMode: 1 | 2 | 3 = input.approvalMode ?? 1
    if (approvalMode !== 1) {
      const key = APPROVAL_MODE_EXPERIMENT_KEYS[approvalMode]
      if (!this.experiments.isEnabled(key)) {
        throw new PodError(
          `approval mode ${approvalMode} is gated behind experiments flag '${key}' (default off; enable in ~/.dsh/pod/experiments.json)`,
          'APPROVAL_MODE_DISABLED',
          { approvalMode, experimentKey: key },
        )
      }
    }
    const now = this.clock()
    const mission: Mission = {
      id: this.missionId,
      name: input.name,
      goal: input.goal,
      status: 'planning',
      // 0/负数 = 不限预算（与 HTTP 层 validateLaunch 同语义归一；0 真上限会锁死一切派发）
      budget_usd: input.budgetUsd > 0 ? input.budgetUsd : UNLIMITED_BUDGET_USD,
      budget_tokens: input.budgetTokens,
      spent_tokens: 0,
      spent_equiv_usd: 0,
      approval_mode: approvalMode,
      cwd: input.cwd,
      worktree_policy: 'per-slot',
      orchestration_mode: 'commander',
      commander_healthy: true,
      created_at: now,
      updated_at: now,
    }
    this.store.createMission(mission)
    for (const slotInput of input.slots) {
      // 槽位 id 全局唯一（2.12 节多 mission 数据模型）：按 mission 命名空间化，
      // 避免跨 mission 短 id（S-1/S-2）在 Store 全局表中冲突（CR-06-6）。
      const slotId = `${this.missionId}-${slotInput.id}`
      const slot: AgentSlot = {
        id: slotId,
        mission_id: this.missionId,
        vendor: slotInput.vendor,
        role: slotInput.role,
        capabilities: slotInput.capabilities,
        model: slotInput.model ?? '',
        avatar: slotInput.avatar,
        effort: 'medium',
        session_tier: slotInput.session_tier ?? DEFAULT_SESSION_TIERS[slotInput.vendor],
        status: 'idle',
        tokens_in: 0,
        tokens_out: 0,
        ctx_usage_pct: 0,
        window_tokens: slotInput.window_tokens ?? 200_000,
      }
      this.store.createSlot(slot)
    }
    this.store.appendEvent(this.missionId, {
      id: `ev-mission-created-${this.missionId}`,
      mission_id: this.missionId,
      ts: now,
      kind: 'mission_created',
      payload: { name: input.name, goal: input.goal, slots: input.slots.map((s) => s.id) },
    })
    return mission
  }

  /** 任务 DAG 落盘（拓扑就绪派发；环与悬空 review 目标拒绝，fail-closed）。 */
  createTasks(plan: PlanTaskInput[]): Task[] {
    const now = this.clock()
    for (const item of plan) {
      // P1：任务 id 同样走白名单（进事件 id / 提示词 / 派发 argv 上下文，纪律与 slot id 一致）
      if (!SAFE_ENTITY_ID.test(item.id)) {
        throw new PodError(
          `task id rejected (allowed: letters/digits/._- , no path separators): ${item.id}`,
          'INVALID_ID',
          { taskId: item.id },
        )
      }
    }
    const ids = new Set(plan.map((p) => p.id))
    for (const item of plan) {
      if (this.store.getTask(this.missionId, item.id) !== undefined) {
        throw new PodError(`task ${item.id} already exists`, 'DUPLICATE_TASK', { id: item.id })
      }
    }
    for (const item of plan) {
      for (const dep of item.depends_on ?? []) {
        if (!ids.has(dep) && this.store.getTask(this.missionId, dep) === undefined) {
          throw new PodError(`task ${item.id} depends on missing task ${dep}`, 'MISSING_DEPENDENCY', { id: item.id, dep })
        }
      }
    }
    // 环检测（DFS 三色）
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (id: string, stack: string[]): void => {
      if (visiting.has(id)) {
        throw new PodError(`dependency cycle: ${[...stack, id].join(' -> ')}`, 'TASK_CYCLE', { cycle: [...stack, id] })
      }
      if (visited.has(id)) return
      visiting.add(id)
      for (const dep of plan.find((p) => p.id === id)?.depends_on ?? []) {
        if (ids.has(dep)) visit(dep, [...stack, id])
      }
      visiting.delete(id)
      visited.add(id)
    }
    for (const item of plan) visit(item.id, [])

    const tasks: Task[] = []
    for (const item of plan) {
      const task: Task = {
        id: item.id,
        mission_id: this.missionId,
        title: item.title,
        spec: item.spec,
        skill_tags: item.skill_tags ?? [],
        type: item.type,
        depends_on: item.depends_on ?? [],
        status: 'ready',
        attempts: 0,
        soft_attempts: 0,
        max_wall_clock_ms: DEFAULT_MAX_WALL_CLOCK_MS,
        created_at: now,
        updated_at: now,
      }
      this.store.createTask(task)
      tasks.push(task)
    }
    return tasks
  }

  // ── 驱动循环 ──────────────────────────────────────────────────────────

  /**
   * 完整驱动：拓扑派发 → 等待完成 → 重试/转人工 → 质量门 → 审批卡。
   * 重入守卫：已有驱动循环在跑时返回在途 promise（并发 run() 会双循环抢派同一任务）。
   */
  run(): Promise<RunSummary> {
    if (this.currentRun !== undefined) return this.currentRun
    const run = this.driveLoop()
    this.currentRun = run
    const clear = (): void => {
      if (this.currentRun === run) this.currentRun = undefined
    }
    run.then(clear, clear)
    return run
  }

  /** 当前是否有驱动循环在跑（pod_status 的 runStatus 数据源）。 */
  driveActive(): boolean {
    return this.currentRun !== undefined
  }

  /**
   * 幂等重驱入口（P0 修复「resume/deny/派发门放行/退避到期后无人再驱动」的停摆裂缝）：
   * mission 处于可驱动状态且无在途循环时后台启动一轮；否则 no-op。
   * 驱动循环自身错误落事件，绝不炸调用方。
   */
  ensureDriving(): boolean {
    if (this.currentRun !== undefined) return true
    const mission = this.store.getMission(this.missionId)
    if (mission === undefined) return false
    if (mission.status !== 'running' && mission.status !== 'planning') return false
    void this.run().catch((error) => {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      this.store.appendEvent(this.missionId, {
        id: `ev-run-error-${this.clock()}`,
        mission_id: this.missionId,
        ts: this.clock(),
        kind: 'mission_run_error',
        payload: { error: message },
      })
    })
    return true
  }

  private async driveLoop(): Promise<RunSummary> {
    const mission = this.requireMission()
    if (mission.status === 'planning') this.missionMachine.start()
    else if (mission.status !== 'running') {
      throw new InvalidTransitionError(mission.status, 'run', 'mission must be planning or running')
    }
    this.stopRequested = false
    this.stopReason = undefined
    while (!this.stopRequested) {
      // v0.2 并行强化：每轮尽量填满 maxParallel 个就绪任务（双路+），而非单路派 1 个即等
      const dispatched = await this.dispatchBatch()
      // 循环继续条件：还有活跃任务等待完成，或刚完成/派发失败后仍有可派任务
      if (!dispatched && this.activeTasks().length === 0) break
      if (this.activeTasks().length > 0) {
        await this.waitForCompletion()
        this.tickWatchdogs()
      }
    }
    return this.summarize()
  }

  private requireMission(): Mission {
    const mission = this.store.getMission(this.missionId)
    if (mission === undefined) throw new PodError(`mission ${this.missionId} not found`, 'NOT_FOUND', { id: this.missionId })
    return mission
  }

  private activeTasks(): Task[] {
    return this.store.listTasks(this.missionId).filter((t) => t.status === 'dispatched' || t.status === 'running')
  }

  private readyTasks(): Task[] {
    const all = this.store.listTasks(this.missionId)
    const done = new Set(all.filter((t) => t.status === 'done').map((t) => t.id))
    const candidates = all.filter((t) => {
      if (t.status === 'ready') return true
      if (t.status === 'blocked') return this.taskMachine.shouldRetry(t, this.clock())
      return false
    })
    return candidates.filter((t) => t.depends_on.every((dep) => done.has(dep)))
  }

  /**
   * Ledger→路由权重（2.7 节 v0.2 起生效）：按槽位统计历史任务成功率。
   * rate：done / (done + blocked + escalated)。无相关任务/全异常 → 无数据（不参与排序，中性）。
   */
  private slotSuccessRates(): Record<string, number> {
    const rates: Record<string, number> = {}
    for (const slot of this.store.listSlots(this.missionId)) {
      const own = this.store.listTasks(this.missionId).filter((t) => t.owner_slot_id === slot.id)
      const done = own.filter((t) => t.status === 'done').length
      const fail = own.filter((t) => t.status === 'blocked' || t.status === 'escalated').length
      if (done + fail > 0) rates[slot.id] = done / (done + fail)
    }
    return rates
  }

  /**
   * v0.2 并行强化：同一轮内连派就绪任务直到填满 maxParallel（或无可派/被卡）。
   * 派发门（模式 2）卡住时 dispatchNext 返回 false → 提前停，等人工放行。
   */
  async dispatchBatch(): Promise<boolean> {
    let any = false
    while (this.activeTasks().length < this.maxParallel) {
      const d = await this.dispatchNext()
      if (!d) break
      any = true
    }
    return any
  }

  /** 派发一个就绪任务；无任务可派返回 false。 */
  async dispatchNext(): Promise<boolean> {
    if (this.activeTasks().length >= this.maxParallel) return false
    const ready = this.readyTasks()
    if (ready.length === 0) return false
    return this.dispatchTask(ready[0]!)
  }

  private async dispatchTask(task: Task): Promise<boolean> {
    const mission = this.requireMission()
    // 停摆守卫（P0 修复「暂停期间任务照常派发」）：stopRequested（用户暂停/预算/中止）
    // 或 mission 已离开可派发状态时，本批不再派新任务；在途任务完成仍走完成处理路径。
    // planning 放行：pod_dispatch/测试可在 run() 前直接派发（与修复前行为一致）
    if (this.stopRequested || (mission.status !== 'running' && mission.status !== 'planning')) return false
    // 429 恢复（3.4 节）：槽位因限流置 rate_limited；其任务退避期满后槽位回 idle 重新可路由
    const now = this.clock()
    for (const slot of this.store.listSlots(this.missionId)) {
      if (slot.status !== 'rate_limited') continue
      const pendingBackoff = this.store
        .listTasks(this.missionId)
        .some(
          (t) =>
            t.owner_slot_id === slot.id &&
            t.status === 'blocked' &&
            t.fault === 'rate_limited' &&
            (t.next_retry_at ?? 0) > now,
        )
      if (!pendingBackoff) this.store.updateSlot(slot.id, { status: 'idle' })
    }
    // 质量门（DoD-5）：review 不得派给被审任务的实现者
    let availableSlots = this.store.listSlots(this.missionId)
    if (task.type === 'review') {
      const targetOwners = new Set(
        task.depends_on
          .map((id) => this.store.getTask(this.missionId, id)?.owner_slot_id)
          .filter((s): s is string => s !== undefined),
      )
      availableSlots = availableSlots.filter((s) => !targetOwners.has(s.id))
    }
    const routed = routeTask(task, {
      slots: availableSlots,
      tasks: this.store.listTasks(this.missionId),
      // Ledger→路由权重（2.7 节 v0.2 起生效）：槽位历史成功率（完成任务占比），无数据中性不劣化
      slotSuccess: this.slotSuccessRates(),
    })
    if (routed.slotId === null) {
      // 无人可派（能力缺口 / 审查者唯一）→ 转人工，不消费 attempts
      this.taskMachine.escalate(task.id)
      this.store.appendEvent(this.missionId, {
        id: `ev-no-slot-${task.id}`,
        mission_id: this.missionId,
        ts: this.clock(),
        kind: 'task_escalated',
        task_id: task.id,
        payload: { reason: `no routable slot: ${routed.reason}` },
      })
      this.maybeAutoReplan(task.id)
      this.signalCompletion()
      return false
    }
    const slot = this.store.getSlot(routed.slotId)!
    const backend = this.backends[slot.vendor]
    if (backend === undefined) {
      throw new PodError(`no backend registered for vendor ${slot.vendor}`, 'BACKEND_MISSING', { vendor: slot.vendor })
    }

    // 派发前预算短路（AgentScope-F / DC-4）：剩余预算 < 任务预估成本 → 不派发 + 告警事件
    const remainingUsd = mission.budget_usd - mission.spent_equiv_usd
    const estimate = this.ledger.estimateTaskCostUsd(this.missionId, task.type, slot.model)
    if (remainingUsd < estimate) {
      this.store.appendEvent(this.missionId, {
        id: `ev-budget-short-${task.id}-${this.clock()}`,
        mission_id: this.missionId,
        ts: this.clock(),
        kind: 'budget_short_circuit',
        task_id: task.id,
        slot_id: slot.id,
        payload: {
          task_type: task.type,
          estimate_usd: Number(estimate.toFixed(4)),
          remaining_usd: Number(remainingUsd.toFixed(4)),
          budget_usd: mission.budget_usd,
          spent_equiv_usd: Number(mission.spent_equiv_usd.toFixed(4)),
        },
      })
      return false
    }

    // 模式 2（交接确认，灰度）：跨 agent 派活前弹卡（pod_dispatch 入口，2.6 节）。
    // task 维持 ready；approved 卡授权本次派发，pending 卡阻塞等待人工放行，denied 卡转人工。
    if (mission.approval_mode === 2) {
      const dispatchCards = this.store.listApprovals(this.missionId).filter((a) => a.kind === 'dispatch' && a.task_id === task.id)
      const approved = dispatchCards.some((a) => a.status === 'approved')
      const pending = dispatchCards.some((a) => a.status === 'pending')
      const denied = dispatchCards.some((a) => a.status === 'denied')
      if (denied && !approved) {
        this.taskMachine.escalate(task.id)
        this.store.appendEvent(this.missionId, {
          id: `ev-dispatch-denied-${task.id}`,
          mission_id: this.missionId,
          ts: this.clock(),
          kind: 'task_escalated',
          task_id: task.id,
          payload: { reason: 'dispatch gate denied by operator' },
        })
        this.signalCompletion()
        return false
      }
      if (!approved && !pending) {
        const card = this.approvals.requestDispatch(this.missionId, {
          slot_id: slot.id,
          worktree_path: slot.worktree_path ?? '',
          task_id: task.id,
          summary: `放行派发 ${task.id}（${task.title}）给 ${slot.id}？跨 agent 交接前确认。`,
        })
        this.store.appendEvent(this.missionId, {
          id: `ev-dispatch-gate-${task.id}-${this.clock()}`,
          mission_id: this.missionId,
          ts: this.clock(),
          kind: 'dispatch_awaiting_approval',
          task_id: task.id,
          slot_id: slot.id,
          payload: { approval_id: card.id },
        })
        return false
      }
      if (pending) return false
      // approved → 落入下方正常派发
    }

    // worktree 隔离（3.7 节：默认每员工一个）
    let worktreePath = slot.worktree_path
    if (worktreePath === undefined || worktreePath.length === 0) {
      worktreePath = await this.worktree.ensure(mission.cwd, slot.id)
      this.store.updateSlot(slot.id, { worktree_path: worktreePath })
    }

    // review 最小上下文（2.5 节）：只给 diff 指针 + 规格，无实现者叙事；
    // 有 diffProvider 时把 diff 内容直接注入（审查者无需仓库命令权限，CR-03）
    let spec = task.spec
    if (task.type === 'review') {
      const targets = task.depends_on.map((id) => this.store.getTask(this.missionId, id)).filter((t): t is Task => t !== undefined)
      const diffRanges = targets
        .map((t) => `${t.id}（${t.parent_sha ?? '?'}..${t.commit_sha ?? '?'}）`)
        .join('、')
      spec += `\n\n## 审查输入（最小上下文原则）\n审查对象：${diffRanges}\n仅审查该 diff + 规格 + 测试输出，刻意排除实现者推理叙事。\n规格：${targets.map((t) => `${t.id}: ${t.spec}`).join('；')}`
      // DoD-19 最小上下文：非写码任务（research/doc/plan）无 diff，注入依赖任务的 report 摘要
      const summaries = targets.map((t) => t.result_summary).filter((s): s is string => s !== undefined && s.length > 0)
      if (summaries.length > 0) {
        spec += `\n\n## 被审产物摘要（实现者 report.summary，宿主机注入）\n${targets.map((t) => `${t.id}: ${t.result_summary ?? ''}`).join('\n')}`
      }
      if (this.diffProvider !== undefined) {
        const diffText = await this.diffProvider(task)
        const truncated = diffText.length > MAX_REVIEW_DIFF_CHARS
        const bounded = truncated ? diffText.slice(0, MAX_REVIEW_DIFF_CHARS) : diffText
        spec += `\n\n## 被审 diff（宿主机注入，勿访问仓库）\n\`\`\`diff\n${bounded}\n\`\`\`${truncated ? '\n（diff 超长已截断；如需完整内容请以 need_clarify 说明）' : ''}`
      }
      // agent_relay：审查上下文注入是真实的 agent 间传信（实现者产物 → 审查者），
      // 落盘事件让前端以对话形式呈现（不做前端表面的假消息）
      const reviewFromSlot = targets.map((t) => t.owner_slot_id).find((x) => x !== undefined)
      if (reviewFromSlot !== undefined) {
        this.store.appendEvent(this.missionId, {
          id: `ev-relay-review-${task.id}-${this.clock()}`,
          mission_id: this.missionId,
          ts: this.clock(),
          kind: 'agent_relay',
          task_id: task.id,
          slot_id: reviewFromSlot,
          payload: {
            channel: 'review_input',
            to_slot: slot.id,
            note: `已注入被审任务的 diff 区间与产物摘要（${targets.map((t) => t.id).join('、')}），审查者无需访问仓库`,
          },
        })
      }
    }
    // CR-01-2：steer 排队指令，本次派单必带（运行中指令落盘，不打断进程）
    const queued = this.queuedSteer.get(slot.id) ?? []
    if (queued.length > 0) {
      spec += `\n\n## 排队指令（用户 steer）\n${queued.join('\n')}`
      this.queuedSteer.delete(slot.id)
    }

    const enriched: Task = { ...task, spec }
    this.taskMachine.dispatch(task.id, slot.id)
    this.taskMachine.start(task.id)
    // DoD-19：新派发 = 新 reply（重置聚合游标）
    resetReplyCursor(slot.id, task.id)
    this.watchdog.arm({
      key: `task-idle:${task.id}`,
      kind: 'task-idle',
      mission_id: this.missionId,
      task_id: task.id,
      deadline: this.clock() + this.watchdog.thresholdMs('task-idle'),
    })
    this.watchdog.arm({
      key: `task-wall-clock:${task.id}`,
      kind: 'task-wall-clock',
      mission_id: this.missionId,
      task_id: task.id,
      deadline: this.clock() + task.max_wall_clock_ms,
    })
    const handle = await backend.start(slot, enriched, worktreePath, {
      onProgress: (event) => this.handleProgress(slot, task, event),
      onExit: (completion) => {
        void this.handleCompletion(task.id, completion)
      },
    })
    this.handles.set(task.id, handle)
    return true
  }

  private handleProgress(slot: AgentSlot, task: Task, event: WorkerProgressEvent): void {
    this.watchdog.arm({
      key: `task-idle:${task.id}`,
      kind: 'task-idle',
      mission_id: this.missionId,
      task_id: task.id,
      deadline: this.clock() + this.watchdog.thresholdMs('task-idle'),
    })
    void slot
    // DoD-19：进度事件经 emitWorkerProgress 落 reply_id/seq（事件→消息态重建的数据基础）
    const podEvent = emitWorkerProgress(event, (e) => this.store.appendEvent(this.missionId, e), this.missionId)
    void podEvent
  }

  private async handleCompletion(taskId: string, completion: WorkerCompletion): Promise<void> {
    try {
      await this.processCompletion(taskId, completion)
    } catch (error) {
      // 内部错误绝不静默（error-handling 纪律）：落事件 + 任务故障化 + 唤醒驱动循环
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      this.store.appendEvent(this.missionId, {
        id: `ev-completion-error-${taskId}-${this.clock()}`,
        mission_id: this.missionId,
        ts: this.clock(),
        kind: 'completion_error',
        task_id: taskId,
        payload: { error: message },
      })
      const task = this.store.getTask(this.missionId, taskId)
      if (task !== undefined && (task.status === 'dispatched' || task.status === 'running')) {
        try {
          this.taskMachine.fail(taskId, { kind: 'crash', message: `internal error: ${message}` })
        } catch {
          // 状态已漂移：只留事件，不二次抛出
        }
      }
    } finally {
      // 完成即弃句柄：正常完成的任务此前从不清理，Map 无界增长（审计 M3）
      this.handles.delete(taskId)
      this.signalCompletion()
    }
  }

  private async processCompletion(taskId: string, completion: WorkerCompletion): Promise<void> {
    const task = this.store.getTask(this.missionId, taskId)
    if (task === undefined || task.owner_slot_id === undefined) {
      this.signalCompletion()
      return
    }
    this.watchdog.disarm(`task-idle:${taskId}`)
    this.watchdog.disarm(`task-wall-clock:${taskId}`)
    const slot = this.store.getSlot(task.owner_slot_id)
    if (slot !== undefined) {
      // 账本（2.7 节）：tokens 权威列 + equiv 估算；超限熔断自动 pause
      try {
        this.ledger.recordUsage(
          this.missionId,
          slot.id,
          taskId,
          slot.model,
          completion.usage.tokens_in,
          completion.usage.tokens_out,
          completion.usage.source,
        )
      } catch (error) {
        if (error instanceof PodError && error.code === 'BUDGET_EXCEEDED') {
          this.stopRequested = true
          this.stopReason = 'budget'
          this.missionMachine.pause()
          this.store.appendEvent(this.missionId, {
            id: `ev-budget-${taskId}`,
            mission_id: this.missionId,
            ts: this.clock(),
            kind: 'mission_paused_budget',
            task_id: taskId,
            payload: { error: error.message },
          })
        } else {
          throw error
        }
      }
      const tokensIn = slot.tokens_in + completion.usage.tokens_in
      const tokensOut = slot.tokens_out + completion.usage.tokens_out
      this.store.updateSlot(slot.id, {
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        ctx_usage_pct: estimateCtxUsage(tokensIn, tokensOut, slot.window_tokens),
      })
    }

    switch (completion.exit) {
      case 'done': {
        if (completion.report === undefined) {
          // 无报告即静默假成功候选（Verifier 层 fail-closed 的同源判定）
          this.taskMachine.fail(taskId, { kind: 'silent_failure', message: 'process exited 0 but produced no MISSION_REPORT' })
          break
        }
        if (task.type === 'plan') {
          // 规划任务（P1）：提案先经代码裁决，再报完成——顺序很关键：report() 会把任务
          // 迁到 done，之后再拒绝就无法走 fail/重试路径了
          const proposal = extractPlanProposal(completion.report)
          const validation =
            proposal !== undefined
              ? validatePlanProposal(proposal, {
                  slots: this.store.listSlots(this.missionId),
                  existingTaskIds: new Set(this.store.listTasks(this.missionId).map((t) => t.id)),
                })
              : undefined
          if (validation === undefined || !validation.ok) {
            const errors = validation === undefined ? ['report.plan missing or malformed'] : validation.errors
            this.taskMachine.fail(taskId, { kind: 'silent_failure', message: `plan proposal rejected: ${errors.join('; ').slice(0, 400)}` })
            this.store.appendEvent(this.missionId, {
              id: `ev-plan-rejected-${taskId}-${this.clock()}`,
              mission_id: this.missionId,
              ts: this.clock(),
              kind: 'plan_rejected',
              task_id: taskId,
              payload: { errors },
            })
            break
          }
          await this.taskMachine.report(taskId, completion.report)
          this.maybeEmitQuestion(task, completion.report)
          this.expandPlan(validation.plan, taskId, validation.assumptions, validation.goalRestatement)
          break
        }
        await this.taskMachine.report(taskId, completion.report)
        this.maybeEmitQuestion(task, completion.report)
        break
      }
      case 'rate_limited':
        this.taskMachine.fail(taskId, { kind: 'rate_limited', message: 'rate limited by upstream' })
        break
      case 'timeout':
        this.taskMachine.fail(taskId, { kind: 'wall_clock', message: 'task wall-clock exceeded' })
        break
      case 'failed': {
        const fault: FaultKind =
          completion.fault ?? classifyFault({ exit: 'failed', exitCode: completion.exit_code }) ?? 'crash'
        const detail = completion.error_detail !== undefined ? `: ${completion.error_detail}` : ''
        this.taskMachine.fail(taskId, { kind: fault, message: `worker failed (exit ${completion.exit_code ?? '?'})${detail}` })
        break
      }
      case 'killed':
        this.taskMachine.fail(taskId, { kind: 'crash', message: 'worker process killed' })
        break
    }
    this.maybeAutoReplan(taskId)
    this.signalCompletion()
  }

  private signalCompletion(): void {
    if (this.wakeLatch.resolve !== undefined) {
      const resolve = this.wakeLatch.resolve
      this.wakeLatch.resolve = undefined
      resolve()
    } else {
      this.wakeLatch.fired = true
    }
  }

  private waitForCompletion(): Promise<void> {
    if (this.wakeLatch.fired) {
      this.wakeLatch.fired = false
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.wakeLatch.resolve = resolve
    })
  }

  /** watchdog 巡检（插件层定时调用；CLI 演示链在循环内调用）。 */
  tickWatchdogs(firedOverride?: FiredWatchdog[]): void {
    const fired = firedOverride ?? this.watchdog.tick(this.clock())
    for (const item of fired) {
      if (item.task_id === undefined) continue
      const task = this.store.getTask(this.missionId, item.task_id)
      if (task === undefined) continue
      if (item.kind === 'task-wall-clock') {
        void this.killTask(item.task_id)
        if (task.status === 'dispatched' || task.status === 'running') {
          this.taskMachine.fail(item.task_id, { kind: 'wall_clock', message: 'watchdog: wall-clock exceeded' })
        }
      } else if (item.kind === 'task-idle') {
        void this.killTask(item.task_id)
        if (task.status === 'dispatched' || task.status === 'running') {
          this.taskMachine.fail(item.task_id, { kind: 'idle_timeout', message: 'watchdog: no stream events' })
        }
      }
      this.signalCompletion()
    }
  }

  /**
   * 宿主周期巡检（CR-05-6）：watchdog 触发 + 审批超期自动 pause（CR-01-7）。
   * 插件层以固定间隔调用；awaiting_approval 期间 watchdog 已由 Watchdog.pauseAll 语义挂起。
   */
  maintenanceTick(): { staleApprovals: string[]; watchdogFired: number } {
    const fired = this.watchdog.tick(this.clock())
    this.tickWatchdogs(fired)
    // 停摆兜底（存储级，不依赖内存 watchdog 状态——实证：驱动循环存在静默挂起的
    // 运行态）：active 任务超过 STALL_TIMEOUT_MS 无任何落盘进展 → 故障化（idle_timeout）
    // 并确保重驱。任何停摆最多一个巡检周期 + 超时窗口后自愈。
    // 真实后端的流式进度不更新 task.updated_at——「进展」必须把该任务最新事件 ts
    // 算进去，否则长任务的流式输出期间会被误杀。
    let lastEventTsByTask: Map<string, number> | undefined
    for (const task of this.activeTasks()) {
      if (lastEventTsByTask === undefined) {
        lastEventTsByTask = new Map()
        for (const e of this.store.listEvents(this.missionId)) {
          if (e.task_id === undefined) continue
          const prev = lastEventTsByTask.get(e.task_id)
          if (prev === undefined || e.ts > prev) lastEventTsByTask.set(e.task_id, e.ts)
        }
      }
      const lastProgress = Math.max(task.updated_at, lastEventTsByTask.get(task.id) ?? 0)
      if (this.clock() - lastProgress < STALL_TIMEOUT_MS) continue
      try {
        this.killTask(task.id)
      } catch { /* 句柄可能已死 */ }
      try {
        this.taskMachine.fail(task.id, { kind: 'idle_timeout', message: `stall guard: no progress for ${Math.round(STALL_TIMEOUT_MS / 60_000)}min` })
        this.store.appendEvent(this.missionId, {
          id: `ev-stall-${task.id}-${this.clock()}`,
          mission_id: this.missionId,
          ts: this.clock(),
          kind: 'task_blocked',
          task_id: task.id,
          payload: { fault: 'idle_timeout', guard: 'stall-timeout', attempts: task.attempts },
        })
      } catch {
        // 状态已漂移（恰好在兜底瞬间完成）：留事件即可
      }
      this.signalCompletion()
    }
    // 停摆补偿（P0）：mission 应在跑但驱动循环不在（退避到期/历史遗漏）且有活干 → 自动重驱。
    // 条件收紧到「有可派/在途任务」或「全部完成待收口」，避免 escalated 等终态每 tick 空转。
    if (this.currentRun === undefined) {
      const mission = this.store.getMission(this.missionId)
      if (mission !== undefined && mission.status === 'running') {
        const tasks = this.store.listTasks(this.missionId)
        const hasWork =
          this.readyTasks().length > 0 ||
          this.activeTasks().length > 0 ||
          (tasks.length > 0 && tasks.every((t) => t.status === 'done'))
        if (hasWork) this.ensureDriving()
      }
    }
    const stale = this.missionMachine.tickStaleApprovals()
    return { staleApprovals: stale.map((a) => a.id), watchdogFired: fired.length }
  }

  /**
   * 跨重启恢复（DoD-11 真正落地，P0 修复：此前 recover 是死代码，重启后任务永久卡死）：
   * 宿主重启后 dispatched/running 任务的 worker 进程已死——按 crash 故障化
   * （attempts 未满则 blocked 待重派，否则转人工），审批卡索引重建，落恢复事件。
   */
  recoverFromRestart(): { orphanedTasks: string[] } {
    const orphaned: string[] = []
    for (const task of this.store.listTasks(this.missionId)) {
      if (task.status !== 'dispatched' && task.status !== 'running') continue
      try {
        this.taskMachine.fail(task.id, { kind: 'crash', message: 'host restart: worker process lost' })
        orphaned.push(task.id)
      } catch {
        // 状态已漂移（如重启前完成事件已落盘）：留给完成路径裁决，不覆盖
      }
    }
    this.approvals.rebuildAfterRestart(this.missionId)
    this.store.appendEvent(this.missionId, {
      id: `ev-recovered-${this.clock()}`,
      mission_id: this.missionId,
      ts: this.clock(),
      kind: 'mission_recovered',
      payload: { orphaned_tasks: orphaned },
    })
    return { orphanedTasks: orphaned }
  }

  // ── 规划阶段（P1：goal → DAG 智能分解，AgentScope DAGPlanExecutor 借鉴）──────

  /** 阵型是否具备 planner 槽位（launch 分流：有 → 规划任务；无 → 调用方走默认链）。 */
  hasPlannerCapability(): boolean {
    return hasPlannerSlot(this.store.listSlots(this.missionId))
  }

  /** 剩余可用重规划次数（REPLAN_LIMIT 门控，pod_plan 工具暴露）。 */
  replanRemaining(): number {
    return Math.max(0, REPLAN_LIMIT - this.replansUsed)
  }

  /**
   * 创建规划任务（P-n，type 'plan'）：把 goal + 名册（重规划时附失败上下文）交给
   * planner 槽位分解。它就是一个普通任务——路由/watchdog/账本/重试全套走既有资产。
   */
  createPlannerTask(goal: string, replan?: { reason: string }): Task {
    const id = `P-${(this.planSeq += 1)}`
    const spec = buildPlannerSpec({
      goal,
      roster: this.store.listSlots(this.missionId).map((s) => ({ id: s.id, role: s.role, capabilities: s.capabilities })),
      replan:
        replan !== undefined
          ? { reason: replan.reason, failures: this.undoneTaskSummary() }
          : undefined,
    })
    const [task] = this.createTasks([
      { id, title: replan !== undefined ? `重规划：${replan.reason}` : '目标分解规划', spec, type: 'plan', skill_tags: [PLAN_TASK_SKILL] },
    ])
    this.store.appendEvent(this.missionId, {
      id: `ev-plan-${id}-${this.clock()}`,
      mission_id: this.missionId,
      ts: this.clock(),
      kind: replan !== undefined ? 'plan_replan_requested' : 'plan_delegation',
      task_id: id,
      payload: { reason: replan?.reason ?? null, replans_remaining: this.replanRemaining() },
    })
    return task!
  }

  /** 未完成任务摘要（重规划上下文的数据源）。 */
  private undoneTaskSummary(): Array<{ id: string; title: string; status: string; fault?: string; last_error?: string }> {
    return this.store
      .listTasks(this.missionId)
      .filter((t) => t.status !== 'done' && t.type !== 'plan')
      .map((t) => ({ id: t.id, title: t.title, status: t.status, fault: t.fault, last_error: t.last_error }))
  }

  /**
   * 有界重规划（自动 + 人工共用）：任务转人工时把失败现状喂回 planner 重新分解。
   * 三重门：REPLAN_LIMIT / planner 槽位在阵 / 预算余量覆盖一次规划成本。
   */
  requestReplan(reason: string): { requested: boolean; remaining: number; message: string } {
    if (this.replansUsed >= REPLAN_LIMIT) {
      return { requested: false, remaining: 0, message: `replan limit reached (${REPLAN_LIMIT}); escalate to human` }
    }
    if (!this.hasPlannerCapability()) {
      return { requested: false, remaining: this.replanRemaining(), message: 'no planner slot in roster (capabilities must include 规划)' }
    }
    const mission = this.requireMission()
    const plannerModel = this.store
      .listSlots(this.missionId)
      .find((s) => s.capabilities.includes(PLAN_TASK_SKILL) && (s.model ?? '').length > 0)?.model ?? ''
    const estimate = this.ledger.estimateTaskCostUsd(this.missionId, 'plan', plannerModel)
    if (mission.budget_usd - mission.spent_equiv_usd < estimate) {
      this.store.appendEvent(this.missionId, {
        id: `ev-plan-replan-skip-${this.clock()}`,
        mission_id: this.missionId,
        ts: this.clock(),
        kind: 'plan_replan_skipped',
        payload: { reason: 'budget', remaining_usd: Number((mission.budget_usd - mission.spent_equiv_usd).toFixed(4)), estimate_usd: Number(estimate.toFixed(4)) },
      })
      return { requested: false, remaining: this.replanRemaining(), message: 'insufficient budget for replan' }
    }
    this.replansUsed += 1
    this.createPlannerTask(mission.goal, { reason })
    this.ensureDriving()
    return { requested: true, remaining: this.replanRemaining(), message: `replan task created (${reason})` }
  }

  /**
   * 有界自动重规划钩子（P1，AgentScope plan executor 反馈环借鉴）：
   * 任务转人工（派发无人可派 / 完成处理失败耗尽）且阵型具备 planner → 重新分解。
   * 规划任务自身失败不触发（防自我递归）。
   */
  private maybeAutoReplan(taskId: string): void {
    const after = this.store.getTask(this.missionId, taskId)
    if (after === undefined || after.type === 'plan' || after.status !== 'escalated') return
    this.requestReplan(`任务 ${taskId} 转人工（fault=${after.fault ?? 'escalated'}）`)
  }

  /**
   * 对话式控制台的问题通道（P2）：报告带 questions（或 need_clarify/blocked 陈述）时
   * 落 task_question 事件——前端据此弹选项卡，人答后经 steer 回灌 + resolve 重派。
   */
  private maybeEmitQuestion(task: Task, report: import('./types.js').MissionReport): void {
    const questions = report.questions ?? []
    const hasBlockers = report.status !== 'done' && report.blockers !== undefined && report.blockers.length > 0
    if (questions.length === 0 && !hasBlockers) return
    this.store.appendEvent(this.missionId, {
      id: `ev-question-${task.id}-${this.clock()}`,
      mission_id: this.missionId,
      ts: this.clock(),
      kind: 'task_question',
      task_id: task.id,
      slot_id: task.owner_slot_id,
      payload: {
        questions,
        blockers: report.blockers ?? [],
        report_status: report.status,
        summary: report.summary,
      },
    })
  }

  /** 规划提案通过裁决后落盘：建任务 + 事件 + plan.md 回调。 */
  private expandPlan(plan: PlanTaskInput[], sourceTaskId: string, assumptions: string[], goalRestatement?: string): void {
    this.createTasks(plan)
    this.store.appendEvent(this.missionId, {
      id: `ev-plan-expanded-${sourceTaskId}-${this.clock()}`,
      mission_id: this.missionId,
      ts: this.clock(),
      kind: 'plan_expanded',
      task_id: sourceTaskId,
      payload: {
        tasks: plan.map((p) => ({ id: p.id, type: p.type, depends_on: p.depends_on })),
        assumptions,
        goal_restatement: goalRestatement ?? null,
      },
    })
    if (this.onPlanExpanded !== undefined) {
      try {
        this.onPlanExpanded(this.missionId, plan, sourceTaskId)
      } catch (error) {
        // plan.md 是回溯面不是执行面：落盘失败只记日志，不阻断任务图
        console.error('[dsh-pod] writePlanFile after expansion failed:', error)
      }
    }
  }

  async killTask(taskId: string): Promise<void> {
    const handle = this.handles.get(taskId)
    if (handle !== undefined) {
      const task = this.store.getTask(this.missionId, taskId)
      const backend = task?.owner_slot_id !== undefined ? this.backends[this.store.getSlot(task.owner_slot_id)?.vendor ?? 'dsh'] : undefined
      if (backend !== undefined) await backend.kill(handle)
      this.handles.delete(taskId)
    }
  }

  setWatchdogThreshold(kind: 'task-idle' | 'task-wall-clock', ms: number): void {
    this.watchdog.setThreshold(kind, ms)
  }

  /** CR-01-2：steer 指令排队（运行中不打断进程；员工下次派单必带）。短 id 自动映射到 mission 命名空间 id。 */
  steer(slotId: string, instruction: string): void {
    const fullId = this.resolveSlotId(slotId)
    const list = this.queuedSteer.get(fullId) ?? []
    list.push(instruction)
    this.queuedSteer.set(fullId, list)
    this.store.appendEvent(this.missionId, {
      id: `ev-steer-${fullId}-${this.clock()}`,
      mission_id: this.missionId,
      ts: this.clock(),
      kind: 'steer_queued',
      slot_id: fullId,
      payload: { instruction },
    })
  }

  /** 槽位 id 解析：完整 id 或短 id（mission 命名空间后缀，CR-06-6）。 */
  private resolveSlotId(slotId: string): string {
    const exact = this.store.getSlot(slotId)
    if (exact !== undefined) return slotId
    const matches = this.store.listSlots(this.missionId).filter((s) => s.id.endsWith(`-${slotId}`))
    return matches.length > 0 ? matches[0]!.id : slotId
  }

  // ── 审批闭环 ──────────────────────────────────────────────────────────

  approve(approvalId: string, by: string): void {
    this.missionMachine.approve(approvalId, by)
  }

  /** W5：仅裁决卡 approved（合并前确认，ApplyPatch 校验依赖此状态）。 */
  approveCard(approvalId: string, by: string, editedParams?: Record<string, string>, rememberRule = true): void {
    this.missionMachine.approveCard(approvalId, by, editedParams, rememberRule)
  }

  /**
   * 模式 2 派发确认门：批准一张 dispatch 卡 → 授权对应任务派发。
   * 卡裁决经 ApprovalEngine 持久化（审计同 merge 门）；任务维持 ready，
   * 由后续 run()/dispatchNext() 按 approved 卡放行实际派发（不直接启动 worker）。
   */
  approveDispatchGate(approvalId: string, by: string): ApprovalRequest {
    const approval = this.store.getApproval(approvalId)
    if (approval === undefined) throw new NotFoundError('approval', approvalId)
    if (approval.kind !== 'dispatch') {
      throw new PodError('approval is not a dispatch gate', 'NOT_DISPATCH_GATE', { approvalId, kind: approval.kind })
    }
    const decided = this.approvals.decide(approvalId, 'approved', by)
    // 放行后任务可派：自动重驱（P0 修复：此前 approve 后无人再驱动，等 pod_dispatch 手动触发）
    this.ensureDriving()
    return decided
  }

  /** 暂停 mission（方案书 113 行/W4：可暂停/恢复；仅 running/awaiting_approval 可暂停）。
   * 引擎同步停止派发（stopRequested）：状态字段与驱动行为不再分裂；在途任务自然完成。 */
  pause(): void {
    this.stopRequested = true
    this.stopReason = 'user'
    this.missionMachine.pause()
    // 唤醒可能在 waitForCompletion 上等待的驱动循环：在途完成仍独立处理，不依赖循环存活
    this.signalCompletion()
  }

  /** 恢复 mission（paused → running 或 awaiting_approval，取决于有无 pending 审批卡）；
   * 回到 running 时自动重驱——此前 resume 后无人再调 run()，mission 永久停摆（P0 修复）。 */
  resume(): void {
    this.missionMachine.resume()
    this.ensureDriving()
  }

  /** 模式 2 派发确认门：驳回一张 dispatch 卡（depends 任务转人工，不派发）。 */
  denyDispatchGate(approvalId: string, by: string, reason: string): ApprovalRequest {
    const approval = this.store.getApproval(approvalId)
    if (approval === undefined) throw new NotFoundError('approval', approvalId)
    if (approval.kind !== 'dispatch') {
      throw new PodError('approval is not a dispatch gate', 'NOT_DISPATCH_GATE', { approvalId, kind: approval.kind })
    }
    const decided = this.approvals.decide(approvalId, 'denied', by, reason)
    if (approval.task_id !== undefined) {
      const task = this.store.getTask(this.missionId, approval.task_id)
      if (task !== undefined && task.status === 'ready') {
        this.taskMachine.escalate(task.id)
        this.store.appendEvent(this.missionId, {
          id: `ev-dispatch-gate-denied-${task.id}-${this.clock()}`,
          mission_id: this.missionId,
          ts: this.clock(),
          kind: 'task_escalated',
          task_id: task.id,
          payload: { reason: `dispatch gate denied: ${reason}` },
        })
      }
    }
    return decided
  }

  /** W5：合并成功 → mission done。 */
  completeAfterMerge(approvalId: string, by: string): void {
    this.missionMachine.completeAfterMerge(approvalId, by)
  }

  /** W5：合并失败 → 卡回滚 pending（mission 保持 awaiting_approval）。 */
  rollbackApproval(approvalId: string): void {
    this.missionMachine.rollbackApproval(approvalId)
  }

  /**
   * 驳回 → 回到 running；AS-3（AgentScope-C）：deny 原因回灌 worker——
   * 以 steer 指令形式排队给该审批卡的 owner slot（复用 CR-01-2 排队机制），
   * 该员工下次派单必带，worker 上下文里能看到驳回原因。
   */
  deny(approvalId: string, by: string, reason: string): void {
    this.missionMachine.deny(approvalId, by, reason)
    const approval = this.store.getApproval(approvalId)
    if (approval !== undefined && approval.patch.slot_id.length > 0) {
      const feedback = `[审批驳回反馈] 你的实现被驳回（by ${by}）原因：${reason}。请据此修正后重新提交。`
      this.steer(approval.patch.slot_id, feedback)
    }
    // deny → mission 回 running：任务可重跑，自动重驱（P0 修复：此前无人再驱动）
    this.ensureDriving()
  }

  /** 中止 mission（终态；状态机裁决合法性）。中止后已派发的 worker 已无意义：
   * 全部树杀，防进程泄漏与预算继续燃烧（P0 修复：此前只切状态不杀进程）。 */
  abortMission(reason: string): void {
    this.stopRequested = true
    this.stopReason = 'abort'
    this.missionMachine.abort(reason)
    for (const taskId of [...this.handles.keys()]) {
      void this.killTask(taskId)
    }
    // 唤醒驱动循环：被杀 worker 的退出信号可能永不到达（如远程后端），循环不得悬挂
    this.signalCompletion()
  }

  /**
   * 转人工接管（3.4 节接管卡）：人工裁决 escalated 任务去向。
   *   outcome=done   → 以证据（commit_sha/parent_sha）完成该任务，后续依赖可继续
   *   outcome=blocked → 置回 blocked（保留 attempts），按重试规则可重新派发
   * 这是「转人工」的唯一恢复路径：LLM 无此权限，代码裁决 + 人工证据落盘（CR-06-8）。
   */
  humanResolve(
    taskId: string,
    resolution: { outcome: 'done' | 'blocked'; commit_sha?: string; parent_sha?: string; note?: string },
  ): void {
    const task = this.store.getTask(this.missionId, taskId)
    if (task === undefined) throw new NotFoundError('task', taskId)
    if (task.status !== 'escalated') {
      throw new InvalidTransitionError(task.status, 'human-resolved', 'only escalated tasks can be human-resolved')
    }
    const now = this.clock()
    if (resolution.outcome === 'done') {
      this.store.updateTask(this.missionId, taskId, {
        status: 'done',
        commit_sha: resolution.commit_sha,
        parent_sha: resolution.parent_sha,
        done_at: now,
        fault: undefined,
        last_error: undefined,
      })
    } else {
      this.store.updateTask(this.missionId, taskId, {
        status: 'blocked',
        fault: undefined,
        last_error: resolution.note ?? 'human takeover: retry',
        next_retry_at: now,
      })
    }
    this.store.appendEvent(this.missionId, {
      id: `ev-human-resolve-${taskId}-${now}`,
      mission_id: this.missionId,
      ts: now,
      kind: 'task_human_resolved',
      task_id: taskId,
      payload: { outcome: resolution.outcome, note: resolution.note ?? null, commit_sha: resolution.commit_sha ?? null },
    })
    this.signalCompletion()
  }

  /**
   * v0.2 任务中途换人正式化（4.3 / 2.5 交接协议）：
   * 把任务所有权从旧槽位转到目标槽位 → kill 旧进程 → 生成交接四件套落盘（buildHandoff）→
   * 事件 task_reassigned 审计 → 任务置回 ready，由 dispatchBatch 重派到新槽位。
   * done 已终态拒绝；目标槽位不可用（error/stopped/rate_limited/waiting_approval）拒绝。
   */
  async reassignTask(taskId: string, toSlotId: string, reason: string): Promise<Handoff> {
    const task = this.store.getTask(this.missionId, taskId)
    if (task === undefined) throw new NotFoundError('task', taskId)
    if (task.mission_id !== this.missionId) throw new PodError('task not in this mission', 'MISSION_MISMATCH', { id: taskId })
    if (task.status === 'done') {
      throw new PodError('cannot reassign a done task', 'TASK_TERMINAL', { status: 'done' })
    }
    const to = this.store.getSlot(toSlotId)
    if (to === undefined) throw new NotFoundError('slot', toSlotId)
    if (to.mission_id !== this.missionId) throw new PodError('slot not in this mission', 'MISSION_MISMATCH', { id: toSlotId })
    if (to.status === 'error' || to.status === 'stopped' || to.status === 'rate_limited' || to.status === 'waiting_approval') {
      throw new PodError(`target slot unavailable (${to.status})`, 'SLOT_UNAVAILABLE', { status: to.status })
    }
    const from = task.owner_slot_id !== undefined ? this.store.getSlot(task.owner_slot_id) : undefined
    if (task.status === 'dispatched' || task.status === 'running') {
      await this.killTask(taskId)
    }
    if (from !== undefined) this.store.updateSlot(from.id, { status: 'idle' })
    const handoff = buildHandoff(this.store, {
      from_slot: from?.id ?? 'unknown',
      to_slot: to.id,
      task_id: task.id,
      mode: 'queue',
      payload: {
        intent: { brief: `任务 ${task.id} 中途换人：${reason}`, constraints: [], acceptance: task.spec },
        artifacts: {
          spec: task.spec,
          context_files: [],
          base_commit: task.parent_sha,
          diff_range: task.parent_sha !== undefined && task.commit_sha !== undefined ? `${task.parent_sha}..${task.commit_sha}` : undefined,
        },
        state: { tried: [], blockers: [reason] },
        expected_output: task.spec,
        verify: ['commit_exists', 'report_fields_complete'],
      },
    })
    this.store.updateTask(this.missionId, taskId, {
      owner_slot_id: to.id,
      status: 'ready',
      fault: undefined,
      last_error: undefined,
      started_at: undefined,
      dispatched_at: undefined,
    })
    this.store.appendEvent(this.missionId, {
      id: `ev-reassign-${taskId}-${this.clock()}`,
      mission_id: this.missionId,
      ts: this.clock(),
      kind: 'task_reassigned',
      task_id: task.id,
      slot_id: to.id,
      payload: { from: from?.id ?? null, to: to.id, reason, handoff_id: handoff.id },
    })
    // 注意：此处不立即重驱——换人是人工动作，调用方常在重派前后做断言/补充操作；
    // 且 dispatchTask 的 routeTask 不认 owner 偏好，立刻重派会无视换人指定重新路由。
    // 停摆兜底由 maintenanceTick 补偿（mission running + ready 任务 → 自动重驱，≤30s）。
    return handoff
  }

  /** 由 done 实现任务汇总审批 patch（合并执行属 W5 apply_patch；此处仅生成待批卡）。 */
  buildApprovalRequest(): ApprovalRequest {
    // 合并单元 = 有 commit 的产物任务：plan（无 commit）/纯叙事产物不构成合并对象
    // （实证：planner 会话里 P-1 被误选为 primary，base/head 缺失 → 审批页无 diff 可审）
    const implementTasks = this.store
      .listTasks(this.missionId)
      .filter((t) => t.type !== 'review' && t.status === 'done' && t.commit_sha !== undefined)
    if (implementTasks.length === 0) {
      throw new PodError('no implement tasks to approve', 'NO_PATCH', { mission: this.missionId })
    }
    const primary = implementTasks[0]!
    const slot = primary.owner_slot_id !== undefined ? this.store.getSlot(primary.owner_slot_id) : undefined
    return this.approvals.request(this.missionId, {
      slot_id: primary.owner_slot_id ?? 'unknown',
      worktree_path: slot?.worktree_path ?? '',
      base_commit: primary.parent_sha,
      head_commit: primary.commit_sha,
      summary: implementTasks.map((t) => `${t.id} ${t.title} @ ${t.commit_sha ?? '?'}`).join('；'),
    })
  }

  private summarize(): RunSummary {
    const tasks = this.store.listTasks(this.missionId)
    const done = tasks.filter((t) => t.status === 'done').map((t) => t.id)
    const escalated = tasks.filter((t) => t.status === 'escalated').map((t) => t.id)
    const mission = this.requireMission()
    // 中止/暂停的如实上报：此前 abort 后掉进 needs_human（guard 抛错被吞），语义误导（审计 M5）
    if (mission.status === 'aborted') {
      return { status: 'aborted', doneTasks: done, escalatedTasks: escalated, pendingApprovals: [] }
    }
    if (mission.status === 'paused') {
      return {
        status: this.stopReason === 'budget' ? 'budget_exceeded' : 'paused',
        doneTasks: done,
        escalatedTasks: escalated,
        pendingApprovals: [],
      }
    }
    if (escalated.length > 0) {
      return { status: 'needs_human', doneTasks: done, escalatedTasks: escalated, pendingApprovals: [] }
    }
    const waitingBackoff = tasks.filter(
      (t) => t.status === 'blocked' && (t.next_retry_at ?? 0) > this.clock(),
    )
    if (waitingBackoff.length > 0) {
      return { status: 'waiting_backoff', doneTasks: done, escalatedTasks: escalated, pendingApprovals: [] }
    }
    // 模式 2（交接确认，灰度）：有待批的派发确认卡 → 等待人工放行，先不推进质量门。
    const pendingDispatch = this.approvals
      .pendingFor(this.missionId)
      .filter((a) => a.kind === 'dispatch')
    if (pendingDispatch.length > 0) {
      return {
        status: 'awaiting_dispatch',
        doneTasks: done,
        escalatedTasks: escalated,
        pendingApprovals: pendingDispatch.map((a) => a.id),
      }
    }
    // 模式 3（全自动，灰度）：质量门通过后无审批卡，mission 直通 done。
    if (this.requireMission().approval_mode === 3) {
      try {
        this.missionMachine.autoComplete()
      } catch (error) {
        return {
          status: 'needs_human',
          doneTasks: done,
          escalatedTasks: escalated,
          pendingApprovals: [],
          reason: error instanceof Error ? error.message : String(error),
        }
      }
      return { status: 'done', doneTasks: done, escalatedTasks: escalated, pendingApprovals: [] }
    }
    try {
      this.missionMachine.tasksCompleted()
    } catch (error) {
      return {
        status: 'needs_human',
        doneTasks: done,
        escalatedTasks: escalated,
        pendingApprovals: [],
        reason: error instanceof Error ? error.message : String(error),
      }
    }
    const approval = this.buildApprovalRequest()
    return {
      status: 'awaiting_approval',
      doneTasks: done,
      escalatedTasks: escalated,
      pendingApprovals: [approval.id],
    }
  }

  /** pod_status 数据源：mission/任务/员工/审批/账本快照（结构化，无原始对话）。 */
  status(): {
    mission: Mission
    tasks: Task[]
    slots: AgentSlot[]
    pendingApprovals: ApprovalRequest[]
    ledger: ReturnType<Ledger['summary']>
  } {
    return {
      mission: this.requireMission(),
      tasks: this.store.listTasks(this.missionId),
      slots: this.store.listSlots(this.missionId),
      pendingApprovals: this.approvals.pendingFor(this.missionId),
      ledger: this.ledger.summary(this.missionId),
    }
  }
}

/** 报告类型引用（避免未使用告警的显式导出）。 */
export type { MissionReport }
