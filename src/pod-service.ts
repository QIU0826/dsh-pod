/**
 * PodService —— 插件层的 mission 生命周期管理（pod_* 工具的宿主逻辑）。
 * 封装编排器：真实后端（claude/codex）、真实 worktree、真实 diff 注入与 Verifier；
 * 工具层只做薄壳调用，状态机裁决一切迁移（3.3 节不变量 1）。
 *
 * MVP 单 active mission（2.12 节）：同一时刻一个编排器实例；
 * run() 后台驱动（进度落盘，工具随时查询）。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { ApprovalEngine } from './core/approvals.js'
import { ApplyPatch, execGitRunner, type ApplyResult } from './core/apply-patch.js'
import { BackendsLock } from './core/backends-lock.js'
import { Experiments } from './core/experiments.js'
import { MemoryStore, type ReflectionResult } from './core/memory.js'
import { PodError } from './core/errors.js'
import { Ledger } from './core/ledger.js'
import { MissionOrchestrator, type LaunchInput, type PlanTaskInput, type RunSummary } from './core/orchestrator.js'
import { execGitClient, verifyTaskArtifacts } from './core/verifier.js'
import type { PodStore } from './core/store.js'
import { ClaudeHeadlessBackend } from './workers/claude-headless.js'
import { CodexHeadlessBackend, codexBinaryCandidates } from './workers/codex-headless.js'
import { repairPath } from './workers/preflight.js'
import type { ApprovalRequest, ApprovalRule, AgentSlot, Handoff, MemoryRecord, MemoryRelation, Mission, Task, Vendor, WorkerBackend } from './core/types.js'

/** 记忆后台 reflection 节流间隔（2.8.1：MT 周期内不频繁跑 pass）。 */
export const REFLECTION_INTERVAL_MS = 60_000

export interface PodServiceOptions {
  store: PodStore
  /** 默认数据根（~/.dsh/pod）。 */
  dataDir?: string
  /** 记忆实例（v0.2 SQLite：与 store 共享 pod.db；缺省按 dataDir 自建 memory.json）。 */
  memory?: MemoryStore
  backends?: Partial<Record<Vendor, WorkerBackend>>
  clock?: () => number
}

/** commander 会话启动器（插件层注入：ctx.agents.create + agentCtx 作用域注册，CR-05-2）。 */
export type CommanderLauncher = (goal: string, cwd: string, agentPreset?: string) => Promise<{ sessionId: string }>

export class PodService {
  private readonly store: PodStore
  private readonly clock: () => number
  private readonly backends: Partial<Record<Vendor, WorkerBackend>>
  private readonly dataDir: string
  private orchestrator: MissionOrchestrator | undefined
  private running: Promise<RunSummary> | undefined
  /** 记忆 reflection 节流（2.8.1：MT 周期内不频繁跑后台 pass）。 */
  private lastReflectionAt = 0
  private commanderLauncher: CommanderLauncher | undefined
  private readonly experiments: Experiments
  private readonly memory: MemoryStore

  constructor(options: PodServiceOptions) {
    this.store = options.store
    this.clock = options.clock ?? (() => Date.now())
    this.dataDir = options.dataDir ?? join(homedir(), '.dsh', 'pod')
    // 灰度开关（Berd-E）：~/.dsh/pod/experiments.json，默认关、fail-closed；cheap load
    this.experiments = new Experiments({ filePath: join(this.dataDir, 'experiments.json') })
    this.experiments.load()
    // 长期记忆子系统（2.8.1）：优先注入共享实例（SQLite 引擎时与 store 同 pod.db）；
    // 缺省按 ~/.dsh/pod/memory.json（JSON 回退）自建，主动策展 + 图谱 + reflection
    this.memory = options.memory ?? new MemoryStore({ filePath: join(this.dataDir, 'memory.json'), clock: this.clock })
    this.memory.open()
    // Windows 专项：宿主 PATH 可能被外部程序改写（CR-03-7），worker spawn 前修复
    repairPath()
    this.backends = options.backends ?? {
      claude: new ClaudeHeadlessBackend({
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      }),
      codex: new CodexHeadlessBackend({
        binary: codexBinaryCandidates('win32').find((c) => existsSync(c)) ?? 'codex',
      }),
    }
  }

  /** 插件层注入 commander 会话启动器（pod_launch 后自动创建 mission 编排会话，3.3 节）。 */
  setCommanderLauncher(launcher: CommanderLauncher | undefined): void {
    this.commanderLauncher = launcher
  }

  get activeMissionId(): string | undefined {
    return this.store.getActiveMission()?.id
  }

  /** 启动 mission：创建编排器（含真实 worktree/diff/verifier）并后台驱动。 */
  launch(input: Omit<LaunchInput, 'slots'> & { slots: LaunchInput['slots']; plan?: PlanTaskInput[] }): Mission {
    // DoD-15：后端版本锁定（Berd-A）——mismatch 拒绝 launch；首次运行自动 pin
    this.enforceBackendLock()
    const missionId = `M-${this.clock()}-${Math.floor(Math.random() * 1e6)}`
    const orchestrator = this.makeOrchestrator(missionId)
    const mission = orchestrator.launch(input)
    // plan 缺省时自动生成「实现 + 独立 review」默认链（质量门默认开，CR-06-5）：
    // 表单/工具未给任务 DAG 也能跑出完整链，而非空 mission 静默转人工
    const plan = input.plan !== undefined && input.plan.length > 0 ? input.plan : defaultPlan(input.goal)
    orchestrator.createTasks(plan)
    // DoD-2：plan.md 落盘（唯一事实源，charter planner.md 契约）——mission 数据目录下持久化，
    // 跨重启可回溯；Canvas 任务列表即该 plan 的可视化
    this.writePlanFile(missionId, goalTitle(input.goal), plan)
    this.orchestrator = orchestrator
    this.running = orchestrator.run().catch((error) => {
      this.store.appendEvent(missionId, {
        id: `ev-run-error-${this.clock()}`,
        mission_id: missionId,
        ts: this.clock(),
        kind: 'mission_run_error',
        payload: { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
      })
      return { status: 'aborted' as const, doneTasks: [], escalatedTasks: [], pendingApprovals: [], reason: String(error) }
    })
    // 3.3 节：mission 独立会话承载 commander（编排逻辑）；创建失败仅落事件，不阻断 mission
    if (this.commanderLauncher !== undefined) {
      this.commanderLauncher(input.goal, input.cwd).catch((error) => {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        // 宿主日志定位（CR-06-7）：事件仅缓冲，日志才是持久诊断面
        console.error('[dsh-pod] commander session creation failed:', message)
        this.store.appendEvent(missionId, {
          id: `ev-commander-error-${this.clock()}`,
          mission_id: missionId,
          ts: this.clock(),
          kind: 'commander_creation_error',
          payload: { error: message },
        })
      })
    }
    return mission
  }

  /**
   * DoD-15 后端版本锁定（Berd-A）：launch 前对照 ~/.dsh/pod/backends.lock.json。
   *   ok/unlocked（首次）→ 放行并 pin；mismatch → 拒绝 launch（CLI 版本漂移 = R1）。
   *   POD_*_BIN 覆盖 → override 绕过（显式逃生门）。
   *   测试注入空 backends（{}）时跳过（无真实 CLI 可锁，避免 shell 探测拖慢单测）。
   */
  private enforceBackendLock(): void {
    if (Object.keys(this.backends).length === 0) return
    const lock = new BackendsLock({ filePath: join(this.dataDir, 'backends.lock.json') })
    const snapshot = this.detectBackendVersions()
    const check = lock.check(snapshot, this.binOverrides())
    if (check.status === 'mismatch') {
      throw new PodError(`backend version lock mismatch: ${check.details ?? ''} (run pin or set POD_*_BIN)`, 'BACKEND_LOCK_MISMATCH')
    }
    if (check.status === 'ok' || check.status === 'unlocked' || check.status === 'override') {
      // 覆盖/解锁也重新 pin（锁定当前实况，下次 check 有基线）
      lock.pin(snapshot)
    }
  }

  /** 探测 claude/codex 版本快照（preflight 语义：已装才记版本；进程级缓存避免每次 launch 重探）。 */
  private cachedBackendVersions: Record<string, { installed: boolean; version?: string; bin: string }> | undefined
  private detectBackendVersions(): Record<string, { installed: boolean; version?: string; bin: string }> {
    if (this.cachedBackendVersions !== undefined) return this.cachedBackendVersions
    const result: Record<string, { installed: boolean; version?: string; bin: string }> = {
      claude: { installed: false, bin: 'claude' },
      codex: { installed: false, bin: 'codex' },
    }
    try {
      const claude = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true, shell: true })
      result.claude = { installed: true, version: claude.trim().split('\n')[0] ?? '', bin: 'claude' }
    } catch {
      /* 未装/探测失败 → 如实 recorded installed=false */
    }
    try {
      const codexBin = codexBinaryCandidates('win32').find((c) => existsSync(c)) ?? 'codex'
      const codex = execFileSync(codexBin, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true, shell: true })
      result.codex = { installed: true, version: codex.trim().split('\n')[0] ?? '', bin: codexBin }
    } catch {
      /* 未装 → 如实 recorded */
    }
    this.cachedBackendVersions = result
    return result
  }

  /** POD_*_BIN 显式覆盖（Berd-A：POD_CLAUDE_BIN / POD_CODEX_BIN）。 */
  private binOverrides(): Record<string, string> {
    const overrides: Record<string, string> = {}
    if (process.env.POD_CLAUDE_BIN !== undefined && process.env.POD_CLAUDE_BIN.length > 0) overrides.claude = process.env.POD_CLAUDE_BIN
    if (process.env.POD_CODEX_BIN !== undefined && process.env.POD_CODEX_BIN.length > 0) overrides.codex = process.env.POD_CODEX_BIN
    return overrides
  }

  /** DoD-2：plan.md 落盘（mission 数据目录，唯一事实源）。序列化任务 DAG，可读且可回溯。 */
  private writePlanFile(missionId: string, title: string, plan: PlanTaskInput[]): void {    try {
      const dir = join(this.dataDir, 'missions', missionId)
      mkdirSync(dir, { recursive: true })
      const lines: string[] = [
        `# Mission Plan: ${title}`,
        '',
        `> mission: ${missionId}`,
        `> 生成时间: ${new Date(this.clock()).toISOString()}`,
        '> 本文件由 Pod 自动生成（plan.md 唯一事实源，DoD-2）；Canvas 任务列表即其可视化。',
        '',
      ]
      for (const task of plan) {
        lines.push(`## ${task.id} · ${task.title}`)
        lines.push(`- type: ${task.type}`)
        if (task.skill_tags !== undefined && task.skill_tags.length > 0) lines.push(`- skill_tags: ${task.skill_tags.join(', ')}`)
        if (task.depends_on !== undefined && task.depends_on.length > 0) lines.push(`- depends_on: ${task.depends_on.join(', ')}`)
        lines.push(`- spec: ${task.spec}`)
        lines.push('')
      }
      writeFileSync(join(dir, 'plan.md'), lines.join('\n'), 'utf8')
    } catch (error) {
      // plan.md 落盘失败不阻断 launch：仅记事件（Canvas 任务列表仍在，DoD-2 的主链路不依赖文件）
      this.store.appendEvent(missionId, {
        id: `ev-plan-write-error-${this.clock()}`,
        mission_id: missionId,
        ts: this.clock(),
        kind: 'plan_write_error',
        payload: { error: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  /** 宿主周期巡检：watchdog + 审批超期（CR-05-6）。 */
  maintenanceTick(): { staleApprovals: string[]; watchdogFired: number } {
    // 记忆后台 reflection（2.8.1：任务空闲/周期时合并重复、补 supports、剪枝过时）；
    // 节流避免每 tick 都跑（默认 60s）。任务完成/空闲时由插件在空闲时段触发。
    const now = this.clock()
    if (now - this.lastReflectionAt >= REFLECTION_INTERVAL_MS) {
      this.lastReflectionAt = now
      this.memory.runReflection()
    }
    if (this.orchestrator === undefined) return { staleApprovals: [], watchdogFired: 0 }
    return this.orchestrator.maintenanceTick()
  }

  /** 转人工接管 + 恢复驱动（3.4 节）：人工裁决 escalated 任务后重新驱动 DAG。 */
  humanResolveAndResume(
    taskId: string,
    resolution: { outcome: 'done' | 'blocked'; commit_sha?: string; parent_sha?: string; note?: string },
  ): Promise<RunSummary> {
    const orch = this.requireOrchestrator()
    orch.humanResolve(taskId, resolution)
    const missionId = this.store.getActiveMission()?.id ?? ''
    // 重新驱动：完成/重试后继续派发依赖链
    this.running = orch.run().catch((error) => {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      this.store.appendEvent(missionId, {
        id: `ev-resume-error-${Date.now()}`,
        mission_id: missionId,
        ts: Date.now(),
        kind: 'mission_run_error',
        payload: { error: message },
      })
      return { status: 'aborted' as const, doneTasks: [], escalatedTasks: [], pendingApprovals: [], reason: message }
    })
    return this.running
  }

  private makeOrchestrator(missionId: string): MissionOrchestrator {
    return new MissionOrchestrator(missionId, {
      store: this.store,
      backends: this.backends,
      worktree: {
        async ensure(repoRoot: string, slotId: string) {
          const path = join(repoRoot, '.pod-worktrees', slotId)
          if (!existsSync(path)) {
            execFileSync('git', ['-C', repoRoot, 'worktree', 'add', path, '-b', `pod-${slotId}`], { stdio: 'pipe' })
          }
          return path
        },
      },
      verify: async (task, report) => {
        const slot = this.store.getSlot(task.owner_slot_id ?? '')
        const repoDir = slot?.worktree_path ?? ''
        return verifyTaskArtifacts({ git: execGitClient(), repoDir }, task, report)
      },
      experiments: this.experiments,
      diffProvider: async (task) => {
        const parts: string[] = []
        for (const targetId of task.depends_on) {
          const target = this.store.getTask(targetId)
          if (target === undefined) continue
          const slot = target.owner_slot_id !== undefined ? this.store.getSlot(target.owner_slot_id) : undefined
          const repoDir = slot?.worktree_path ?? ''
          if (target.parent_sha !== undefined && target.commit_sha !== undefined && repoDir.length > 0) {
            const stdout = execFileSync('git', ['-C', repoDir, 'diff', target.parent_sha, target.commit_sha], {
              encoding: 'utf8',
              maxBuffer: 64 * 1024 * 1024,
            })
            parts.push(`# ${targetId}（${target.parent_sha.slice(0, 8)}..${target.commit_sha.slice(0, 8)}）\n${stdout}`)
          }
        }
        return parts.join('\n\n') || '（无 diff 内容）'
      },
      clock: this.clock,
    })
  }

  private requireOrchestrator(): MissionOrchestrator {
    if (this.orchestrator === undefined) {
      // 跨重启恢复：磁盘有 active mission 时按 mission id 重建编排器
      const active = this.store.getActiveMission()
      if (active !== undefined) {
        this.orchestrator = this.makeOrchestrator(active.id)
        return this.orchestrator
      }
      throw new Error('no active mission; launch one with pod_launch first')
    }
    return this.orchestrator
  }

  status(): {
    mission?: Mission
    tasks: Task[]
    slots: AgentSlot[]
    pendingApprovals: ApprovalRequest[]
    runStatus?: string
    /** Berd-E 灰度开关（Canvas UI 据此显隐拓扑动画/自由画布，默认关、fail-closed）。 */
    experiments: { topology_animation: boolean }
  } {
    const active = this.store.getActiveMission()
    if (active === undefined) return { tasks: [], slots: [], pendingApprovals: [], experiments: { topology_animation: this.experiments.isEnabled('topology-animation') } }
    const orch = this.requireOrchestrator()
    const snapshot = orch.status()
    return {
      mission: snapshot.mission,
      tasks: snapshot.tasks,
      slots: snapshot.slots,
      pendingApprovals: snapshot.pendingApprovals,
      runStatus: this.running !== undefined ? 'running' : 'idle',
      experiments: { topology_animation: this.experiments.isEnabled('topology-animation') },
    }
  }

  /** DoD-17（AS-4）：Canvas 资产读取白名单根集合 = mission cwd + 各员工 worktree 路径。 */
  worktreeRoots(): string[] {
    const active = this.store.getActiveMission()
    if (active === undefined) return []
    const roots = [active.cwd]
    for (const slot of this.store.listSlots(active.id)) {
      if (slot.worktree_path !== undefined && slot.worktree_path.length > 0) roots.push(slot.worktree_path)
    }
    return [...new Set(roots)]
  }

  /** 全量事件（SSE replay 用：无上限，新订阅者先收 buffered history 再收 live）。 */
  eventsAfter(afterTs: number): Array<{ id: string; ts: number; kind: string; task_id?: string; slot_id?: string; payload: Record<string, unknown> }> {
    const missions = this.store.listMissions().filter((m) => m.status !== 'done' && m.status !== 'aborted')
    const events = missions.flatMap((m) => this.store.listEvents(m.id))
    return events
      .filter((e) => e.ts > afterTs)
      .sort((a, b) => a.ts - b.ts)
      .map((e) => ({
        id: e.id,
        ts: e.ts,
        kind: e.kind,
        task_id: e.task_id,
        slot_id: e.slot_id,
        payload: e.payload,
      }))
  }

  /** Canvas 事件流尾部（after=ts 游标；客户端按 id 去重）。 */
  eventsTail(afterTs: number): Array<{ id: string; ts: number; kind: string; task_id?: string; slot_id?: string; payload: Record<string, unknown> }> {
    const missions = this.store.listMissions().filter((m) => m.status !== 'done' && m.status !== 'aborted')
    const events = missions.flatMap((m) => this.store.listEvents(m.id))
    return events
      .filter((e) => e.ts > afterTs)
      .sort((a, b) => a.ts - b.ts)
      .slice(-200)
      .map((e) => ({
        id: e.id,
        ts: e.ts,
        kind: e.kind,
        task_id: e.task_id,
        slot_id: e.slot_id,
        payload: e.payload,
      }))
  }

  /** 账本双列尾部（W5：tokens 实测权威列 + equiv_usd 标注估算）。 */
  ledgerTail(): {
    total_tokens: number
    total_equiv_usd: number
    entries: Array<{ model: string; tokens_in: number; tokens_out: number; equiv_usd: number; price_known: boolean; usage_source: string }>
  } {
    const active = this.store.getActiveMission()
    if (active === undefined) return { total_tokens: 0, total_equiv_usd: 0, entries: [] }
    const summary = new Ledger(this.store).summary(active.id)
    return {
      total_tokens: summary.total_tokens,
      total_equiv_usd: Number(summary.total_equiv_usd.toFixed(6)),
      entries: summary.entries.map((e) => ({
        model: e.model,
        tokens_in: e.tokens_in,
        tokens_out: e.tokens_out,
        equiv_usd: e.equiv_usd,
        price_known: e.price_known,
        usage_source: e.usage_source,
      })),
    }
  }

  /**
   * v0.2 任务中途换人正式化（4.3）：把任务所有权转到目标槽位（kill 旧进程 + 交接四件套落盘 + 事件审计）。
   * 换人后任务置 ready，由接下来 run()/dispatchNext() 重派到新槽位。
   */
  reassign(taskId: string, toSlotId: string, reason: string): Promise<Handoff> {
    return this.requireOrchestrator().reassignTask(taskId, toSlotId, reason)
  }

  /** 手动模式（3.3 节）：UI/工具直连状态机接口，绕开 LLM 编排。 */
  dispatchNext(): Promise<boolean> {
    return this.requireOrchestrator().dispatchNext()
  }

  steer(slotId: string, instruction: string): void {
    this.requireOrchestrator().steer(slotId, instruction)
  }

  approve(approvalId: string, by: string, editedParams?: Record<string, string>): Promise<ApplyResult> {
    const orch = this.requireOrchestrator()
    const approval = this.store.getApproval(approvalId)
    if (approval === undefined) {
      return Promise.resolve({ ok: false, conflict: false, message: `approval not found: ${approvalId}` })
    }
    // apply_patch 单入口（3.3 节不变量 3）：合并前必须已批准。
    // 先裁决卡 approved（mission 仍 awaiting_approval），ApplyPatch 校验通过后执行 merge；
    // 合并成功才 mission done；失败回滚卡 pending（可重试或驳回）。
    // AS-3（AgentScope-C）：批准可携带人工编辑参数（如 merge_note），审计留痕。
    orch.approveCard(approvalId, by, editedParams)
    const applyPatch = new ApplyPatch({ store: this.store, git: execGitRunner() })
    return applyPatch.apply(approval.mission_id, approval).then((result) => {
      if (result.ok) {
        orch.completeAfterMerge(approvalId, by)
      } else {
        orch.rollbackApproval(approvalId)
      }
      return result
    })
  }

  deny(approvalId: string, by: string, reason: string): void {
    this.requireOrchestrator().deny(approvalId, by, reason)
  }

  /** 模式 2 派发确认门：人工批准放行 → 授权对应任务派发（灰度）。 */
  approveDispatchGate(approvalId: string, by: string): void {
    this.requireOrchestrator().approveDispatchGate(approvalId, by)
  }

  /** 模式 2 派发确认门：驳回（对应任务转人工，不派发）。 */
  denyDispatchGate(approvalId: string, by: string, reason: string): void {
    this.requireOrchestrator().denyDispatchGate(approvalId, by, reason)
  }

  /** 审批卡读面（pod_approve 判断 merge vs dispatch 门用）。 */
  getApproval(approvalId: string): ApprovalRequest | undefined {
    return this.store.getApproval(approvalId)
  }

  // ── 审批规则层（AgentScope-A/B：查询 + suggested-rules 落 Store）──

  listRules(): ApprovalRule[] {
    return this.store.listRules()
  }

  /** 「记住此规则」：审批卡裁决时携带建议规则（DoD-18：同类调用免重复审批）。 */
  addRule(input: { tool: string; pattern?: string; decision: 'allow' | 'deny' | 'ask'; scope?: 'mission' | 'global'; source?: string }): ApprovalRule {
    const rule: ApprovalRule = {
      id: `R-${this.clock()}-${Math.floor(Math.random() * 1e6)}`,
      tool: input.tool,
      pattern: input.pattern,
      decision: input.decision,
      scope: input.scope ?? 'global',
      source: input.source ?? 'user-suggested',
      ts: this.clock(),
    }
    this.store.createRule(rule)
    return rule
  }

  deleteRule(ruleId: string): void {
    this.store.deleteRule(ruleId)
  }

  // ── 记忆子系统（2.8.1：员工主动策展的「知识层」，pod_mem_* 工具宿主）──

  memoryWrite(input: { owner_slot_id: string; type?: 'lesson' | 'pattern' | 'decision' | 'fact' | 'episode'; importance?: number; tags?: string[]; content_ref?: string; live_ref?: string }): MemoryRecord {
    return this.memory.write(input)
  }

  memoryQuery(q: Parameters<MemoryStore['query']>[0]): MemoryRecord[] {
    return this.memory.query(q)
  }

  memoryCorrect(id: string, patch: { type?: MemoryRecord['type']; importance?: number; tags?: string[]; content_ref?: string; live_ref?: string }, by?: string): MemoryRecord {
    return this.memory.correct(id, patch, by)
  }

  memoryAddEdge(fromRecord: string, toRecord: string, relation: MemoryRelation): { id: string } {
    return this.memory.addEdge(fromRecord, toRecord, relation)
  }

  memoryReflection(): ReflectionResult {
    return this.memory.runReflection()
  }

  abort(reason: string): void {
    this.requireOrchestrator().abortMission(reason)
  }

  waitRun(): Promise<RunSummary> | undefined {
    return this.running
  }
}

/** 默认任务 DAG：T-1 实现（goal 即规格）+ T-2 独立 review（审查者≠实现者，质量门）。 */
export function defaultPlan(goal: string): PlanTaskInput[] {
  const title = goal.length > 40 ? `${goal.slice(0, 40)}…` : goal
  return [
    {
      id: 'T-1',
      title,
      spec: goal,
      type: 'implement',
      skill_tags: ['编码'],
    },
    {
      id: 'T-2',
      title: '独立 review T-1',
      spec: '按最小上下文审查 T-1：规格落实、越界改动、commit 纪律（只依据注入 diff，无实现者叙事）。',
      type: 'review',
      skill_tags: ['审查'],
      depends_on: ['T-1'],
    },
  ]
}

/** 默认数据根（插件与 CLI 共用）。 */
export function defaultPodDataDir(): string {
  return join(homedir(), '.dsh', 'pod')
}

/** goal 截断为标题（与 defaultPlan 同规则，plan.md 头行用）。 */
function goalTitle(goal: string): string {
  return goal.length > 40 ? `${goal.slice(0, 40)}…` : goal
}

export function ensureDataDir(): string {
  const dir = defaultPodDataDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 供工具层使用的审批引擎（跨重启重建审批卡的读面）。 */
export function approvalsFor(store: PodStore): ApprovalEngine {
  return new ApprovalEngine(store)
}
