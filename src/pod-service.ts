/**
 * PodService —— 插件层的 mission 生命周期管理（pod_* 工具的宿主逻辑）。
 * 封装编排器：真实后端（claude/codex）、真实 worktree、真实 diff 注入与 Verifier；
 * 工具层只做薄壳调用，状态机裁决一切迁移（3.3 节不变量 1）。
 *
 * MVP 单 active mission（2.12 节）：同一时刻一个编排器实例；
 * run() 后台驱动（进度落盘，工具随时查询）。
 */

import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { ApprovalEngine } from './core/approvals.js'
import { ApplyPatch, execGitRunner, type ApplyResult } from './core/apply-patch.js'
import { BackendsLock } from './core/backends-lock.js'
import { Experiments } from './core/experiments.js'
import { MemoryStore, type ReflectionResult } from './core/memory.js'
import { PodError, NotFoundError } from './core/errors.js'
import { Ledger } from './core/ledger.js'
import { Notifier } from './core/notifier.js'
import { MissionOrchestrator, type LaunchInput, type PlanTaskInput, type RunSummary } from './core/orchestrator.js'
import { execGitClient, verifyTaskArtifacts } from './core/verifier.js'
import type { PodStore } from './core/store.js'
import { ClaudeHeadlessBackend } from './workers/claude-headless.js'
import { CodexHeadlessBackend, codexBinaryCandidates } from './workers/codex-headless.js'
import { ArkBackend } from './workers/ark-headless.js'
import { envCredentialPresent, repairPath } from './workers/preflight.js'
import { CronScheduler, type CronJob } from './core/cron.js'
import type { ChannelTarget } from './core/channel.js'
import type { ApprovalRequest, ApprovalRule, AgentSlot, Handoff, LedgerEntry, MemoryRecord, MemoryRelation, Mission, PodEvent, Task, Vendor, WorkerBackend } from './core/types.js'

/**
 * 火山方舟后端装配（Berd-G 新 adapter）：从环境 ARK_API_KEY 或 ~/.claude/settings.json 的
 * ANTHROPIC_AUTH_TOKEN 读取 agent plan key；无 key 时不注册（返回空对象）。
 */
function arkBackendFromSettings(): Partial<Record<Vendor, WorkerBackend>> {
  const key = process.env.ARK_API_KEY ?? readArkKeyFromClaudeSettings()
  if (key === undefined || key.length === 0) return {}
  return { ark: new ArkBackend({ apiKey: key }) }
}

/** 读 settings.json 的 ARK_API_KEY 字段（不读 ANTHROPIC_AUTH_TOKEN，那是 DeepSeek claude 的 key）。 */
function readArkKeyFromClaudeSettings(): string | undefined {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json')
    if (!existsSync(settingsPath)) return undefined
    const raw = execFileSync(process.execPath, ['-e', `const s=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(s.ARK_API_KEY||''))`, settingsPath], { encoding: 'utf8' })
    return raw.length > 0 ? raw : undefined
  } catch {
    return undefined
  }
}

/** 记忆后台 reflection 节流间隔（2.8.1：MT 周期内不频繁跑 pass）。 */
export const REFLECTION_INTERVAL_MS = 60_000

/**
 * HTTP 轮询路径单批事件上限（/api/dsh-pod/events）。
 * 超限只表示「本批取完还有」，配合 has_more + cursor 续读，不丢事件。
 */
export const EVENT_TAIL_LIMIT = 200

/**
 * missionArchive 事件尾部的字节预算（历史会话回看端点，按需调用非轮询）。
 * 此前 `slice(-500)` 条数有界但字节无界——task_context 等 payload 单条可达 8KB，
 * 极端 500 条 ≈ 4MB/次。这里把「最近的事件」的累计序列化字节压进预算内。
 */
export const MISSION_ARCHIVE_EVENTS_MAX_BYTES = 256 * 1024

/**
 * 按字节截断事件流尾部：从最近的事件往前累加序列化字节，超预算即停。
 * 始终保留最近一条（即使单条事件自身就超预算），避免返回空。
 * 返回按时间正序（oldest → newest），与 `slice(-N)` 语义对齐。
 */
export function capEventsByBytes<T>(events: T[], maxBytes: number): T[] {
  const kept: T[] = []
  let bytes = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(JSON.stringify(events[i]), 'utf8')
    // 最近一条无条件保留；其后的事件若会让累计字节超预算则停止
    if (kept.length > 0 && bytes + size > maxBytes) break
    kept.push(events[i]!)
    bytes += size
  }
  return kept.reverse()
}

/** 事件流对客户端暴露的形状（只留客户端需要的字段，抹掉内部字段）。 */
export interface EventTailItem {
  id: string
  ts: number
  kind: string
  task_id?: string
  slot_id?: string
  payload: Record<string, unknown>
}

export interface PodServiceOptions {
  store: PodStore
  /** 默认数据根（~/.dsh/pod）。 */
  dataDir?: string
  /** 记忆实例（v0.2 SQLite：与 store 共享 pod.db；缺省按 dataDir 自建 memory.json）。 */
  memory?: MemoryStore
  backends?: Partial<Record<Vendor, WorkerBackend>>
  clock?: () => number
  /** CR-01-10 桌面通知送达回调（宿主注入；缺省仅日志）。 */
  notify?: (n: { kind: string; mission_id: string; title: string; detail: string }) => void
  /**
   * 演示模式（standalone --demo）：backends 为脚本化 DemoBackend——agent 不执行
   * 真实任务，只按固定剧本走管线。UI 必须显著标注，避免误以为 agent 在真干活。
   */
  demo?: boolean
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
  /** CR-01-10 桌面通知游标：上次已扫描的事件 ts（增量扫描防重复送达）。 */
  private lastNotifiedTs = 0
  private readonly notifier: Notifier
  private commanderLauncher: CommanderLauncher | undefined
  private readonly experiments: Experiments
  private readonly memory: MemoryStore
  /** CR-34：Cron 定时触发（AgentScope-J）——命令复用 pod_* 工具面（审批门不绕过）。 */
  private cron: CronScheduler
  private readonly cronJobsFile: string
  private cronMtimeMs = -1

  private readonly demo: boolean

  constructor(options: PodServiceOptions) {
    this.demo = options.demo ?? false
    this.store = options.store
    this.clock = options.clock ?? (() => Date.now())
    this.dataDir = options.dataDir ?? join(homedir(), '.dsh', 'pod')
    // 灰度开关（Berd-E）：~/.dsh/pod/experiments.json，默认关、fail-closed；cheap load。
    // 方案书 942 行「默认关、dev 构建默认开」：非 production 时注入 UI 类灰度默认开
    // （拓扑/第三栏），审批模式 2/3 保持保守关（涉及行为变更，须显式开启）。
    const devDefaults =
      (process.env.NODE_ENV ?? 'development') !== 'production'
        ? { 'topology-animation': true, 'canvas-third-column': true }
        : undefined
    this.experiments = new Experiments({ filePath: join(this.dataDir, 'experiments.json'), defaults: devDefaults })
    this.experiments.load()
    // 长期记忆子系统（2.8.1）：优先注入共享实例（SQLite 引擎时与 store 同 pod.db）；
    // 缺省按 ~/.dsh/pod/memory.json（JSON 回退）自建，主动策展 + 图谱 + reflection
    this.memory = options.memory ?? new MemoryStore({ filePath: join(this.dataDir, 'memory.json'), clock: this.clock })
    this.memory.open()
    // CR-01-10：桌面通知（注入 send，缺省宿主日志 console.warn）
    this.notifier = new Notifier({
      clock: this.clock,
      send: (n) => { options.notify?.(n); console.warn('[dsh-pod] notify:', n.title, '-', n.detail) },
    })
    // Windows 专项：宿主 PATH 可能被外部程序改写（CR-03-7），worker spawn 前修复
    repairPath()
    this.backends = options.backends ?? {
      claude: new ClaudeHeadlessBackend({
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        // 员工侧 MCP 接线（2026-09-03）：worker-mcp.json 由 standalone listen 后写出
        // （文件存在 = 灰度开）；claude start 时文件存在才注入 --mcp-config + mem 工具白名单。
        mcpConfigPath: join(this.dataDir, 'worker-mcp.json'),
      }),
      codex: new CodexHeadlessBackend({
        binary: codexBinaryCandidates('win32').find((c) => existsSync(c)) ?? 'codex',
      }),
      ...arkBackendFromSettings(),
    }
    // CR-34：Cron 定时触发（AgentScope-J）——target 适配自身 pod_* 工具面（同一套，审批门不绕过）；
    // jobs 从 <dataDir>/cron.json 加载，缺省无 job = 默认关（Berd-H 显式启用纪律）。
    this.cron = new CronScheduler({ clock: this.clock })
    this.cron.setTarget(this.channelTarget())
    this.cronJobsFile = join(this.dataDir, 'cron.json')
    this.reloadCronJobs()
  }

  /**
   * ChannelTarget 适配：Cron/外部 IM 通道与 pod_* 工具面共用同一套动作（审批走同一 approve 门）。
   * `source` 是审批/拒绝记录里的操作者标签（'cron' 定时触发 / 'channel' 外部 IM 通道），
   * 用于审计溯源（谁放行的这次合并）。
   */
  channelTarget(source: string = 'cron'): ChannelTarget {
    return {
      status: () => {
        const s = this.status()
        return { mission: s.mission ?? null, pendingApprovalIds: s.pendingApprovals.map((a) => a.id) }
      },
      launch: (input) => {
        const m = this.launch({
          name: input.name,
          goal: input.goal,
          cwd: input.cwd,
          budgetUsd: input.budgetUsd ?? 3,
          slots: input.slots ?? [],
        })
        return { mission_id: m.id, status: m.status }
      },
      approve: async (id, note) => {
        const r = await this.approve(id, source, note === undefined ? undefined : { merge_note: note })
        return r.ok ? { ok: true } : { ok: false, message: r.message }
      },
      deny: (id, reason) => this.deny(id, source, reason),
      steer: (slotId, instruction) => this.steer(slotId, instruction),
      pause: () => this.pauseMission(),
      resume: () => this.resumeMission(),
      abort: (reason) => this.abort(reason),
    }
  }

  /** cron.json 热加载：mtime 变化才重读（外部编辑文件即生效，无需重启；文件缺失 = 无 job）。 */
  private reloadCronJobs(): void {
    let mtime = 0
    try {
      mtime = existsSync(this.cronJobsFile) ? statSync(this.cronJobsFile).mtimeMs : 0
    } catch {
      mtime = 0
    }
    if (mtime === this.cronMtimeMs) return
    let jobs: CronJob[] = []
    if (existsSync(this.cronJobsFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.cronJobsFile, 'utf8')) as { jobs?: CronJob[] }
        for (const job of parsed.jobs ?? []) {
          if (typeof job?.id === 'string' && typeof job?.intervalMs === 'number' && job.intervalMs > 0 && job.command !== undefined) {
            jobs.push({ id: job.id, intervalMs: job.intervalMs, command: job.command, enabled: job.enabled ?? false, label: job.label })
          }
        }
      } catch (error) {
        // cron.json 损坏/非法：保持上一份 jobs（旧实例不重建），记日志；mtime 已更新不重试刷屏
        console.error('[dsh-pod] cron.json parse failed (keeping previous jobs):', error instanceof Error ? error.message : error)
        this.cronMtimeMs = mtime
        return
      }
    }
    this.cronMtimeMs = mtime
    this.cron = new CronScheduler({ clock: this.clock })
    this.cron.setTarget(this.channelTarget())
    for (const job of jobs) this.cron.register(job)
  }

  /** pod_cron_list 工具面（只读）：当前 jobs + 最近触发历史；顺带热加载 cron.json。 */
  cronList(): { jobs: CronJob[]; recent: ReturnType<CronScheduler['historyTail']> } {
    this.reloadCronJobs()
    return { jobs: this.cron.list(), recent: this.cron.historyTail(10) }
  }

  /** cron 编辑（Web 第三批）：校验 + 写回 cron.json + 热加载。lastFiredAt 是运行时节流状态，不入配置。 */
  cronSave(jobs: unknown): { ok: boolean; message: string } {
    if (!Array.isArray(jobs)) return { ok: false, message: 'jobs must be an array' }
    const clean: CronJob[] = []
    for (const raw of jobs as Array<Record<string, unknown>>) {
      if (raw === null || typeof raw !== 'object') return { ok: false, message: 'job must be an object' }
      if (typeof raw.id !== 'string' || typeof raw.intervalMs !== 'number' || typeof raw.enabled !== 'boolean') {
        return { ok: false, message: 'each job needs id (string) / intervalMs (ms number) / enabled (boolean)' }
      }
      const command = raw.command as { kind?: unknown } | undefined
      if (command === null || typeof command !== 'object' || typeof command.kind !== 'string') {
        return { ok: false, message: 'job needs command.kind (status|launch|approve|deny|steer|pause|resume|abort)' }
      }
      // kind 枚举校验（审计修复）：拼错的 kind 此前被落盘+热加载成「永不生效」的静默哑 job
      if (!['status', 'launch', 'approve', 'deny', 'steer', 'pause', 'resume', 'abort'].includes(command.kind)) {
        return { ok: false, message: `unknown command.kind: ${command.kind}（可用：status|launch|approve|deny|steer|pause|resume|abort）` }
      }
      clean.push({
        id: raw.id,
        intervalMs: Math.max(1_000, Math.floor(raw.intervalMs)),
        command: raw.command as CronJob['command'],
        enabled: raw.enabled,
        label: typeof raw.label === 'string' && raw.label.length > 0 ? raw.label : undefined,
      })
    }
    mkdirSync(this.dataDir, { recursive: true })
    // 运行时节流状态快照（审计 P2 #14）：reloadCronJobs 重建调度器会丢 lastFiredAt，
    // `?? 0` 使全部 enabled job 立即到期——保存配置（哪怕只改了 label）= 立即全量触发。
    const firedBefore = new Map<string, number>()
    for (const job of this.cron.list()) {
      if (job.lastFiredAt !== undefined) firedBefore.set(job.id, job.lastFiredAt)
    }
    writeFileSync(this.cronJobsFile, JSON.stringify({ jobs: clean }, null, 2), 'utf8')
    this.reloadCronJobs()
    for (const job of this.cron.list()) {
      const keep = firedBefore.get(job.id)
      if (keep !== undefined) job.lastFiredAt = keep
    }
    return { ok: true, message: `已写入 ${clean.length} 条定时任务（cron.json + 热加载，触发节流状态已保留）` }
  }


  /** 插件层注入 commander 会话启动器（pod_launch 后自动创建 mission 编排会话，3.3 节）。 */
  setCommanderLauncher(launcher: CommanderLauncher | undefined): void {
    this.commanderLauncher = launcher
  }

  get activeMissionId(): string | undefined {
    return this.store.getActiveMission()?.id
  }

  /** 启动 mission：创建编排器（含真实 worktree/diff/verifier）并后台驱动。 */
  /** 最近一次 run 崩溃（mission 已落终态，但用户必须看到原因——事件流已过滤掉终态会话）。 */
  private lastRunError: { missionId: string; message: string; ts: number } | undefined

  launch(input: Omit<LaunchInput, 'slots'> & { slots: LaunchInput['slots']; plan?: PlanTaskInput[] }): Mission {
    // DoD-15：后端版本锁定（Berd-A）——mismatch 拒绝 launch；首次运行自动 pin
    this.enforceBackendLock()
    // cwd 预检（用户实证：选了非 git 目录 → run 异步崩溃，UI 只见「卡住」）：
    // 同步给出明确 422，而不是让 mission 创建后 3 秒静默死掉
    if (!existsSync(input.cwd)) {
      throw new PodError(`目标目录不存在: ${input.cwd}`, 'CWD_NOT_FOUND')
    }
    try {
      const inside = execFileSync('git', ['-C', input.cwd, 'rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (inside !== 'true') throw new Error('not inside work tree')
    } catch {
      throw new PodError(
        `目标目录不是 git 仓库: ${input.cwd}（在该目录执行 git init，或选择已有的 git 仓库）`,
        'CWD_NOT_GIT_REPO',
      )
    }
    // 空仓守卫（用户实证闭环）：`git worktree add` 要求仓库至少有一个 commit——
    // 刚 git init 的空仓会过上面检查却在派发时半路失败；发射前给出一句话可执行的指引
    try {
      execFileSync('git', ['-C', input.cwd, 'rev-parse', '--verify', 'HEAD'], {
        encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      throw new PodError(
        `目标目录是空 git 仓库（没有任何提交）: ${input.cwd}（在该目录执行一次提交，例如 git commit --allow-empty -m init，或选择已有提交的仓库）`,
        'CWD_GIT_EMPTY_REPO',
      )
    }
    const missionId = `M-${this.clock()}-${Math.floor(Math.random() * 1e6)}`
    const orchestrator = this.makeOrchestrator(missionId)
    const mission = orchestrator.launch(input)
    // 任务 DAG 三级分流（P1 规划层）：
    //   1. 显式 plan → 原样落盘（既有行为）；
    //   2. 阵型含 planner 槽位 → goal 交给规划任务智能分解（提案经代码裁决后 expand，
    //      plan.md 在落盘时经 onPlanExpanded 写入）；
    //   3. 无 planner → 默认「实现 + 独立 review」两步链（CR-06-5 质量门默认开）。
    // 原子性（P0 实证：planning 僵尸）：分流阶段任何异常 → mission 必须转 aborted，
    // 否则落盘的 planning mission 无人驱动、且永久占用单活跃锁（后续 launch 全 409）。
    try {
      if (input.plan !== undefined && input.plan.length > 0) {
        orchestrator.createTasks(input.plan)
        this.writePlanFile(missionId, goalTitle(input.goal), input.plan)
      } else if (orchestrator.hasPlannerCapability()) {
        orchestrator.createPlannerTask(input.goal)
      } else {
        const plan = defaultPlan(input.goal)
        orchestrator.createTasks(plan)
        this.writePlanFile(missionId, goalTitle(input.goal), plan)
      }
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      console.error('[dsh-pod] launch dispatch failed (mission aborted):', message)
      this.store.appendEvent(missionId, {
        id: `ev-launch-error-${this.clock()}`,
        mission_id: missionId,
        ts: this.clock(),
        kind: 'mission_run_error',
        payload: { error: `launch dispatch failed: ${message}` },
      })
      this.store.updateMission(missionId, { status: 'aborted', updated_at: this.clock() })
      throw error
    }
    this.orchestrator = orchestrator
    this.running = this.trackRun(orchestrator, orchestrator.run().catch((error) => {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      console.error('[dsh-pod] mission run crashed:', message)
      this.lastRunError = { missionId, message, ts: this.clock() }
      this.store.appendEvent(missionId, {
        id: `ev-run-error-${this.clock()}`,
        mission_id: missionId,
        ts: this.clock(),
        kind: 'mission_run_error',
        payload: { error: message },
      })
      // P0：run 崩溃必须落到终态——否则 planning/running 僵尸永久占用单活跃锁
      const stuck = this.store.getMission(missionId)
      if (stuck !== undefined && stuck.status !== 'done' && stuck.status !== 'aborted') {
        try {
          orchestrator.abortMission(`run crashed: ${message.slice(0, 200)}`)
        } catch {
          this.store.updateMission(missionId, { status: 'aborted', updated_at: this.clock() })
        }
      }
      return { status: 'aborted' as const, doneTasks: [], escalatedTasks: [], pendingApprovals: [], reason: String(error) }
    }))
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
  private writePlanFile(missionId: string, title: string, plan: PlanTaskInput[], sourceTaskId?: string): void {    try {
      const dir = join(this.dataDir, 'missions', missionId)
      mkdirSync(dir, { recursive: true })
      const lines: string[] = [
        `# Mission Plan: ${title}`,
        '',
        `> mission: ${missionId}`,
        `> 生成时间: ${new Date(this.clock()).toISOString()}`,
        sourceTaskId !== undefined
          ? "> 来源：planner 提案已通过代码裁决（规划任务 ${sourceTaskId}）。"
          : '> 本文件由 Pod 自动生成（plan.md 唯一事实源，DoD-2）；Canvas 任务列表即其可视化。',
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
  maintenanceTick(): { staleApprovals: string[]; watchdogFired: number; notified?: number } {
    // 记忆后台 reflection（2.8.1：任务空闲/周期时合并重复、补 supports、剪枝过时）；
    // 节流避免每 tick 都跑（默认 60s）。任务完成/空闲时由插件在空闲时段触发。
    const now = this.clock()
    if (now - this.lastReflectionAt >= REFLECTION_INTERVAL_MS) {
      this.lastReflectionAt = now
      this.memory.runReflection()
    }
    // CR-34：Cron 定时触发（与 watchdog 同一节拍，宿主 setInterval 30s 驱动）。
    // 放在 early return 之前：无 orchestrator 时 cron 的 launch 也能创建 mission。
    // fire-and-forget（tick 内 launch 可能耗时），错误进 cron 历史不炸宿主。
    try {
      this.reloadCronJobs()
      void this.cron.tick(now).catch((error) => {
        console.error('[dsh-pod] cron tick failed:', error)
      })
    } catch (error) {
      console.error('[dsh-pod] cron tick failed:', error)
    }
    // P0 僵尸自愈：store 里的活跃 mission 不属于当前编排器（launch 分流中途抛错、
    // 或历史版本留下的 planning 僵尸）→ 落终态，释放单活跃锁（否则 launch 永远 409）
    const activeMission = this.store.getActiveMission()
    if (activeMission !== undefined) {
      const owned = this.orchestrator !== undefined && this.orchestrator.missionId === activeMission.id
      if (!owned) {
        console.error(`[dsh-pod] zombie mission detected (no orchestrator owns it): ${activeMission.id} ${activeMission.status} -> aborted`)
        this.store.appendEvent(activeMission.id, {
          id: `ev-zombie-${this.clock()}`,
          mission_id: activeMission.id,
          ts: this.clock(),
          kind: 'mission_run_error',
          payload: { error: `zombie mission reclaimed: ${activeMission.status} without a live orchestrator` },
        })
        this.store.updateMission(activeMission.id, { status: 'aborted', updated_at: this.clock() })
      }
    }
    if (this.orchestrator === undefined) return { staleApprovals: [], watchdogFired: 0 }
    const result = this.orchestrator.maintenanceTick()
    // CR-01-10：扫描新增「需人工动作」事件 → 桌面通知（增量游标 + kind/mission 去重）
    const missions = this.store.listMissions()
    const newEvents = missions.flatMap((m) =>
      this.store.listEvents(m.id).filter((e) => e.ts > this.lastNotifiedTs),
    )
    let notified = 0
    if (newEvents.length > 0) {
      this.lastNotifiedTs = Math.max(...newEvents.map((e) => e.ts))
      notified = this.notifier.scanEvents(newEvents)
    }
    return { staleApprovals: result.staleApprovals, watchdogFired: result.watchdogFired, notified }
  }

  /** 工具调用审计（AgentScope-E middleware 钩子）：落一条 pod_tool_called 事件（有 active mission 时）。 */
  recordToolAudit(entry: { tool: string; ok: boolean; ms: number; error?: string }): void {
    const missionId = this.store.getActiveMission()?.id
    if (missionId === undefined) return
    this.store.appendEvent(missionId, {
      id: `ev-tool-${this.clock()}-${Math.floor(Math.random() * 1e6)}`,
      mission_id: missionId,
      ts: this.clock(),
      kind: 'pod_tool_called',
      payload: { tool: entry.tool, ok: entry.ok, ms: entry.ms, error: entry.error },
    })
  }

  /** 暂停当前 mission（W4：运行中可暂停，状态磁盘化）。 */
  pauseMission(): void {
    this.requireOrchestrator().pause()
  }

  /** 恢复当前 mission（paused → 继续；取决于审批卡是否 pending）。 */
  resumeMission(): void {
    this.requireOrchestrator().resume()
  }

  /** 任务级暂停（任务生命周期 InProgress→Paused）：终止在途进程但不消费 attempts。 */
  async pauseTask(taskId: string): Promise<void> {
    await this.requireOrchestrator().pauseTask(taskId)
  }

  /** 任务级恢复（Paused→ready→重新协商派发，可能换 agent）。 */
  resumeTask(taskId: string): void {
    this.requireOrchestrator().resumeTask(taskId)
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
    this.running = this.trackRun(orch, orch.run().catch((error) => {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      this.store.appendEvent(missionId, {
        id: `ev-resume-error-${Date.now()}`,
        mission_id: missionId,
        ts: Date.now(),
        kind: 'mission_run_error',
        payload: { error: message },
      })
      return { status: 'aborted' as const, doneTasks: [], escalatedTasks: [], pendingApprovals: [], reason: message }
    }))
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
      // N2 记忆运行时注入：派发时按槽位/团队拉相关记录（有界、指针式），worker 无需 pod_mem_* 工具
      memoryQuery: (q) => this.memory.query(q as Parameters<MemoryStore['query']>[0]),
      // P1 feedback 环 v2（experiments 'feedback-consult' 灰度）：语义类拒绝时真咨询
      // 最匹配槽位的 claude worker 执行侧约束。有界（10s 超时），失败回落 v1 名册反馈。
      consult: (prompt) => this.consultClaude(prompt),
      diffProvider: async (task) => {
        const parts: string[] = []
        for (const targetId of task.depends_on) {
          const target = this.store.getTask(task.mission_id, targetId)
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
      // 协商期 env 凭据兜底：`claude auth status` 对 env-token 中转（ANTHROPIC_BASE_URL
      // + token）可能如实报未登录但实际可用——env 有该 vendor 凭据时不以「CLI 未登录」谢绝
      credentialHint: (vendor) => envCredentialPresent(vendor),
      // P1 规划层：planner 提案落盘时同步写 plan.md（DoD-2 唯一事实源，跨重启可回溯）
      onPlanExpanded: (missionId, plan, sourceTaskId) => {
        const mission = this.store.getMission(missionId)
        this.writePlanFile(missionId, goalTitle(mission?.goal ?? ''), plan, sourceTaskId)
      },
    })
  }

  /**
   * feedback v2 的 claude 咨询实现（组装层，core 不直接 spawn）：
   * 一次性 headless 调用（--print，max-turns 4 + 禁工具——咨询是纯语言回答，工具调用
   * 会烧 turns 导致 "Reached max turns" 退出，实测 2026-09-01），60s 超时（实测 ~32s，
   * 留余量）；失败返回 ok:false（编排器回落 v1）。
   * 凭据/模型走 claude CLI 自身登录态（与 worker 同一信任面），不注入 env。
   */
  private async consultClaude(prompt: string): Promise<{ ok: boolean; text: string }> {
    return new Promise((resolve) => {
      const child = spawn('claude', ['--print', '--max-turns', '4', '--allowedTools', 'none'], {
        cwd: this.dataDir,
        shell: process.platform === 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM') } catch { /* 已退出 */ }
        resolve({ ok: false, text: '' })
      }, 60_000)
      child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8') })
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
      child.on('error', () => { clearTimeout(timer); resolve({ ok: false, text: '' }) })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          console.error('[dsh-pod] consult failed (exit ' + code + '): ' + stderr.trim().slice(0, 200))
          resolve({ ok: false, text: '' })
          return
        }
        resolve({ ok: true, text: stdout.trim() })
      })
      child.stdin.write(prompt)
      child.stdin.end()
    })
  }

  /**
   * run 收口跟踪（审计 P1 #3）：驱动循环结束后，mission 已终态 → 释放编排器引用。
   * 此前 orchestrator 只在 launch/recover 赋值、从不置空，done/aborted 会话在
   * 本进程生命周期内 deleteMission 恒 409（「先中止再删」的中止并不释放它）。
   */
  private trackRun(orch: MissionOrchestrator, run: Promise<RunSummary>): Promise<RunSummary> {
    void run
      .then(() => this.releaseFinishedOrchestrator(orch))
      .catch(() => this.releaseFinishedOrchestrator(orch))
    return run
  }

  private releaseFinishedOrchestrator(orch: MissionOrchestrator): void {
    if (this.orchestrator !== orch) return
    const mission = this.store.getMission(orch.missionId)
    if (mission === undefined || mission.status === 'done' || mission.status === 'aborted') {
      this.orchestrator = undefined
      this.running = undefined
    }
  }

  /** mission 是否仍存在（a2a-push watcher 的删除作废判定）。 */
  missionExists(missionId: string): boolean {
    return this.store.getMission(missionId) !== undefined
  }

  private requireOrchestrator(): MissionOrchestrator {
    if (this.orchestrator === undefined) {
      // 跨重启恢复（DoD-11，P0 修复：此前只重建对象——孤儿任务永久卡 dispatched/running）：
      // 1) 磁盘有 active mission 时按 mission id 重建编排器；
      // 2) dispatched/running 任务的 worker 进程已随宿主死亡 → 按 crash 故障化（可重试则待重派）；
      // 3) mission 处于可驱动状态时立即重驱（不等 maintenanceTick）。
      const active = this.store.getActiveMission()
      if (active !== undefined) {
        const orch = this.makeOrchestrator(active.id)
        this.orchestrator = orch
        try {
          orch.recoverFromRestart()
          orch.ensureDriving()
        } catch (error) {
          console.error('[dsh-pod] restart recovery failed:', error)
        }
        return orch
      }
      throw new Error('no active mission; launch one with pod_launch first')
    }
    return this.orchestrator
  }

  /** 演示模式（--demo）：agent 为脚本演员，UI 据此展示显著标识。 */
  isDemo(): boolean {
    return this.demo
  }

  status(): {
    mission?: Mission
    tasks: Task[]
    slots: AgentSlot[]
    pendingApprovals: ApprovalRequest[]
    runStatus?: string
    demo?: boolean
    /** 无活跃会话时，最近一次 run 崩溃的原因（5 分钟内；终态会话事件已从流中过滤）。 */
    last_error?: string
    /** Berd-E 灰度开关（Canvas UI 据此显隐拓扑动画/自由画布/第三栏，默认关、fail-closed）。 */
    experiments: { topology_animation: boolean; canvas_third_column: boolean }
  } {
    const active = this.store.getActiveMission()
    if (active === undefined) {
      const fresh = this.lastRunError !== undefined && this.clock() - this.lastRunError.ts < 5 * 60_000
        ? this.lastRunError
        : undefined
      return { tasks: [], slots: [], pendingApprovals: [], demo: this.demo, last_error: fresh?.message, experiments: { topology_animation: this.experiments.isEnabled('topology-animation'), canvas_third_column: this.experiments.isEnabled('canvas-third-column') } }
    }
    const orch = this.requireOrchestrator()
    const snapshot = orch.status()
    return {
      mission: snapshot.mission,
      tasks: snapshot.tasks,
      slots: snapshot.slots,
      pendingApprovals: snapshot.pendingApprovals,
      demo: this.demo,
      // 驱动在途判定：此前看 this.running（resolve 后仍非 undefined，永远显示 running）
      runStatus: orch.driveActive() ? 'running' : 'idle',
      experiments: { topology_animation: this.experiments.isEnabled('topology-animation'), canvas_third_column: this.experiments.isEnabled('canvas-third-column') },
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

  /** 终态 mission 的事件在事件面继续可见的宽限期：让轮询方/SSE/push 有时间取走终态事件。 */
  static readonly EVENTS_TERMINAL_GRACE_MS = 10 * 60 * 1000

  /**
   * 单 mission 事件读取（A2A SSE / push watcher 专用）：不做「活跃 mission」过滤——
   * mission 完成路径在同一同步块内先翻终态再落 mission_done（mission.ts），
   * 任何轮询方都不可能观察到「mission 活跃且终态事件可读」的中间态；
   * 活跃过滤会把 mission_done/mission_aborted 永久挡在门外（终态帧永不可达）。
   */
  missionEventsAfter(
    missionId: string,
    afterTs: number,
    afterId?: string,
  ): Array<{ id: string; ts: number; kind: string; mission_id?: string; task_id?: string; slot_id?: string; payload: Record<string, unknown> }> {
    const sorted = this.store.listEvents(missionId).sort((a, b) => a.ts - b.ts)
    const firstAfterTs = sorted.findIndex((e) => e.ts > afterTs)
    let start = firstAfterTs === -1 ? sorted.length : firstAfterTs
    if (afterId !== undefined && afterId.length > 0) {
      const idx = sorted.findIndex((e) => e.id === afterId)
      start = idx === -1 ? start : idx + 1
    }
    return sorted.slice(start).map((e) => ({
      id: e.id, ts: e.ts, kind: e.kind, mission_id: e.mission_id, task_id: e.task_id, slot_id: e.slot_id, payload: e.payload,
    }))
  }

  /** 事件面可见的 mission 集：活跃 + 终态宽限期内（终态事件可被取走，之后滚出）。 */
  private eventsVisibleMissions(): Mission[] {
    const now = this.clock()
    return this.store.listMissions().filter((m) => {
      if (m.status !== 'done' && m.status !== 'aborted') return true
      return now - m.updated_at < PodService.EVENTS_TERMINAL_GRACE_MS
    })
  }

  /**
   * SSE 增量取数（events/stream 数据源）。游标语义与 eventsTail 对齐：
   * 优先 afterId（事件 id 精确定位，同毫秒事件不丢）；缺省/失效回退 ts 严格比较。
   * （审计 P1 修复：此前 SSE 与轮询只有后者修了同毫秒丢事件，此处是漏掉的对称路径。）
   */
  eventsAfter(afterTs: number, afterId?: string): Array<{ id: string; ts: number; kind: string; mission_id?: string; task_id?: string; slot_id?: string; payload: Record<string, unknown> }> {
    const missions = this.eventsVisibleMissions()
    // Array.sort 自 ES2019 稳定：同 ts 事件保持落盘顺序，id 定位才可靠
    const sorted = missions.flatMap((m) => this.store.listEvents(m.id)).sort((a, b) => a.ts - b.ts)
    const firstAfterTs = sorted.findIndex((e) => e.ts > afterTs)
    let start = firstAfterTs === -1 ? sorted.length : firstAfterTs
    if (afterId !== undefined && afterId.length > 0) {
      const idx = sorted.findIndex((e) => e.id === afterId)
      start = idx === -1 ? start : idx + 1
    }
    return sorted.slice(start).map((e) => ({
      id: e.id,
      ts: e.ts,
      kind: e.kind,
      // 归属字段（P2-3 push notification 用）：eventsAfter 是「全部活跃 mission」的混流，
      // 订阅方按 mission 过滤必需此字段。增量字段：SSE/轮询客户端按 id 去重，不受影响。
      mission_id: e.mission_id,
      task_id: e.task_id,
      slot_id: e.slot_id,
      payload: e.payload,
    }))
  }

  /**
   * Canvas 事件流尾部（HTTP 轮询路径；SSE 走 eventsAfter，无上限）。
   *
   * 游标语义：优先用 afterId（事件 id，按排序后的位置截断，精确）。
   * 纯 ts 游标用 `ts > after` 严格比较，同一毫秒内产生的多个事件会被整批跳过——
   * 客户端游标推进到该 ts 后，这些事件永远不会再被返回。
   *
   * 窗口语义：增量超过 EVENT_TAIL_LIMIT 时返回**最早**的一批并置 has_more，
   * 客户端按 cursor 续读。此前取的是最后一批（slice(-200)），超限部分会被客户端
   * 已推进的游标永久跳过——高吞吐流式输出时表现为对话流丢内容。
   */
  eventsTail(afterTs: number, afterId?: string): { events: EventTailItem[]; cursor: string; has_more: boolean } {
    const missions = this.eventsVisibleMissions()
    // Array.sort 自 ES2019 稳定：同 ts 事件保持落盘顺序，afterId 定位才可靠
    const sorted = missions.flatMap((m) => this.store.listEvents(m.id)).sort((a, b) => a.ts - b.ts)
    const firstAfterTs = (): number => {
      const idx = sorted.findIndex((e) => e.ts > afterTs)
      return idx === -1 ? sorted.length : idx
    }
    let start = firstAfterTs()
    if (afterId !== undefined && afterId.length > 0) {
      const idx = sorted.findIndex((e) => e.id === afterId)
      // afterId 失效（会话结束/事件不在窗口内）时回退 ts 语义，不静默返回空
      start = idx === -1 ? firstAfterTs() : idx + 1
    }
    const window = sorted.slice(start, start + EVENT_TAIL_LIMIT)
    return {
      events: window.map((e) => ({
        id: e.id,
        ts: e.ts,
        kind: e.kind,
        task_id: e.task_id,
        slot_id: e.slot_id,
        payload: e.payload,
      })),
      cursor: window.length > 0 ? window[window.length - 1]!.id : (afterId ?? ''),
      has_more: start + window.length < sorted.length,
    }
  }

  /**
   * 账本双列尾部（W5：tokens 实测权威列 + equiv_usd 标注估算）。
   *
   * entries 必须是完整 `LedgerEntry`（含 slot_id/task_id/ts/price_table_version）——
   * 这是 `api.ts` 的 `StatusResponse.ledger.entries` 契约。此前这里多做了一次
   * 字段瘦身，返回对象缺 4 个声明中的字段（类型声明比实现宽，前端取 slot_id 会拿到
   * undefined）。
   */
  ledgerTail(): {
    total_tokens: number
    total_equiv_usd: number
    entries: LedgerEntry[]
    by_stage: Record<string, { tokens: number; equiv_usd: number; entries: number }>
    by_attempt: Record<string, { tokens: number; equiv_usd: number; entries: number }>
  } {
    const active = this.store.getActiveMission()
    if (active === undefined) return { total_tokens: 0, total_equiv_usd: 0, entries: [], by_stage: {}, by_attempt: {} }
    const summary = new Ledger(this.store).summary(active.id)
    return {
      total_tokens: summary.total_tokens,
      total_equiv_usd: Number(summary.total_equiv_usd.toFixed(6)),
      entries: summary.entries,
      by_stage: summary.byStage,
      by_attempt: summary.byAttempt,
    }
  }

  // ── 会话中心（P2）：mission 历史 = 会话；store 是唯一事实源，active/归档同构 ──

  /** 会话列表：全部 mission 摘要（状态/预算/任务/token/最新事件/槽位），按创建时间倒序。 */
  missionSummaries(): Array<{
    id: string
    name: string
    goal: string
    status: Mission['status']
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
  }> {
    return this.store
      .listMissions()
      .sort((a, b) => b.created_at - a.created_at)
      .map((m) => {
        const tasks = this.store.listTasks(m.id)
        const events = this.store.listEvents(m.id)
        const entries = this.store.listLedger(m.id)
        const tokensIn = entries.reduce((sum, e) => sum + e.tokens_in, 0)
        const tokensOut = entries.reduce((sum, e) => sum + e.tokens_out, 0)
        const last = events.length > 0 ? events[events.length - 1] : undefined
        return {
          id: m.id,
          name: m.name,
          goal: m.goal,
          status: m.status,
          budget_usd: m.budget_usd,
          budget_tokens: m.budget_tokens ?? null,
          spent_tokens: m.spent_tokens,
          spent_equiv_usd: m.spent_equiv_usd,
          created_at: m.created_at,
          updated_at: m.updated_at,
          task_total: tasks.length,
          task_done: tasks.filter((t) => t.status === 'done').length,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          slots: this.store.listSlots(m.id).map((s) => ({ id: s.id, role: s.role, vendor: s.vendor, avatar: s.avatar ?? null })),
          last_event: last !== undefined ? { kind: last.kind, ts: last.ts, task_id: last.task_id } : null,
          active: m.status !== 'done' && m.status !== 'aborted',
        }
      })
  }

  /** 单个 mission 归档快照（历史会话回看：对话流/任务/槽位/审批/账本）。 */
  missionArchive(missionId: string): {
    mission: { id: string; name: string; goal: string; status: Mission['status']; budget_usd: number; budget_tokens: number | null; spent_tokens: number; spent_equiv_usd: number; created_at: number }
    tasks: Array<{ id: string; title: string; type: string; status: string; fault: string | null; attempts: number; owner: string | null; commit: string | null; depends_on: string[]; spec: string }>
    slots: Array<{ id: string; role: string; vendor: string; status: string; ctx_usage_pct: number; avatar: string | null }>
    approvals: Array<{ id: string; status: string; decided_at: number | null; task_id: string | null; summary: string; worktree_path: string; kind: string }>
    ledger: { total_tokens: number; total_equiv_usd: number; entries: Array<{ model: string; tokens_in: number; tokens_out: number; equiv_usd: number; ts: number }>; by_stage: Record<string, { tokens: number; equiv_usd: number; entries: number }>; by_attempt: Record<string, { tokens: number; equiv_usd: number; entries: number }> }
    events: PodEvent[]
  } | undefined {
    const mission = this.store.getMission(missionId)
    if (mission === undefined) return undefined
    const entries = this.store.listLedger(missionId)
    const totalTokens = entries.reduce((sum, e) => sum + e.tokens_in + e.tokens_out, 0)
    const totalUsd = entries.reduce((sum, e) => sum + e.equiv_usd, 0)
    const summary = new Ledger(this.store).summary(missionId)
    return {
      mission: {
        id: mission.id, name: mission.name, goal: mission.goal, status: mission.status,
        budget_usd: mission.budget_usd, budget_tokens: mission.budget_tokens ?? null, spent_tokens: mission.spent_tokens,
        spent_equiv_usd: mission.spent_equiv_usd, created_at: mission.created_at,
      },
      tasks: this.store.listTasks(missionId).map((t) => ({
        id: t.id, title: t.title, type: t.type, status: t.status, fault: t.fault ?? null,
        attempts: t.attempts, owner: t.owner_slot_id ?? null, commit: t.commit_sha?.slice(0, 8) ?? null, depends_on: t.depends_on,
        spec: t.spec.slice(0, 4_000),
      })),
      slots: this.store.listSlots(missionId).map((s) => ({ id: s.id, role: s.role, vendor: s.vendor, status: s.status, ctx_usage_pct: s.ctx_usage_pct, avatar: s.avatar ?? null })),
      approvals: this.store.listApprovals(missionId).map((a) => ({
        id: a.id, status: a.status, decided_at: a.decided_at ?? null, task_id: a.task_id ?? null,
        summary: a.patch.summary, worktree_path: a.patch.worktree_path, kind: a.kind ?? 'merge',
      })),
      ledger: {
        total_tokens: totalTokens,
        total_equiv_usd: Number(totalUsd.toFixed(6)),
        entries: entries.slice(-50).map((e) => ({ model: e.model, tokens_in: e.tokens_in, tokens_out: e.tokens_out, equiv_usd: e.equiv_usd, ts: e.ts })),
        by_stage: summary.byStage,
        by_attempt: summary.byAttempt,
      },
      events: capEventsByBytes(this.store.listEvents(missionId), MISSION_ARCHIVE_EVENTS_MAX_BYTES),
    }
  }

  /**
   * 删除历史会话（仅终态）。级联清空 mission 归属数据 + 数据目录（plan.md 等）
   * + best-effort worktree 移除。活跃/非终态会话拒绝（在途状态删除会留僵尸；
   * 先 abort 再删）。memory 知识层不受影响（跨会话沉淀，2.8.1）。
   */
  deleteMission(missionId: string): { ok: true; removed: { missions: number; slots: number; tasks: number; handoffs: number; ledger: number; events: number } } {
    const mission = this.store.getMission(missionId)
    if (mission === undefined) throw new NotFoundError('mission', missionId)
    if (mission.status !== 'done' && mission.status !== 'aborted') {
      throw new PodError(`会话仍在运行（${mission.status}），请先中止再删除`, 'MISSION_ACTIVE')
    }
    // 编排器只在驱动未收口时挡删（run 仍在途）；mission 已终态即释放（见 releaseFinishedOrchestrator），
    // 此前「终态后 orchestrator 引用永不置空」导致本进程内 done/aborted 会话永远 409 删不掉
    if (this.orchestrator !== undefined && this.orchestrator.missionId === missionId && this.running !== undefined) {
      throw new PodError('当前编排器正在驱动该会话，无法删除', 'MISSION_ACTIVE')
    }
    if (this.orchestrator !== undefined && this.orchestrator.missionId === missionId) {
      this.orchestrator = undefined
    }
    const slots = this.store.listSlots(missionId)
    const removed = {
      missions: 1,
      slots: slots.length,
      tasks: this.store.listTasks(missionId).length,
      handoffs: this.store.listHandoffs(missionId).length,
      ledger: this.store.listLedger(missionId).length,
      events: this.store.listEvents(missionId).length,
    }
    // best-effort：先移除 worktree（真实 git 数据 + .git/worktrees 元数据），失败不阻断 store 删除
    for (const slot of slots) this.removeWorktree(slot.worktree_path)
    this.store.deleteMission(missionId)
    this.removeMissionDir(missionId)
    return { ok: true, removed }
  }

  /** 重命名会话（历史会话回看时的可读名）。 */
  renameMission(missionId: string, name: string): { ok: true } {
    if (this.store.getMission(missionId) === undefined) throw new NotFoundError('mission', missionId)
    const trimmed = name.trim()
    if (trimmed.length === 0) throw new PodError('会话名不能为空', 'INVALID_NAME')
    this.store.updateMission(missionId, { name: trimmed })
    return { ok: true }
  }

  /** best-effort：`git worktree remove --force` 移除 worktree（git 校验真伪，非 worktree 不动）。 */
  private removeWorktree(path: string | undefined): void {
    if (path === undefined || path.length === 0 || !existsSync(path)) return
    try {
      execFileSync('git', ['worktree', 'remove', '--force', path], { stdio: 'pipe', timeout: 30_000, windowsHide: true })
    } catch (error) {
      console.error(`[dsh-pod] worktree remove failed (left in place): ${path}`, error instanceof Error ? error.message : error)
    }
  }

  /** 清理 mission 数据目录（~/.dsh/pod/missions/<id>：plan.md 等派生文件）。 */
  private removeMissionDir(missionId: string): void {
    const dir = join(this.dataDir, 'missions', missionId)
    if (!existsSync(dir)) return
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      console.error(`[dsh-pod] mission dir remove failed (left in place): ${dir}`, error instanceof Error ? error.message : error)
    }
  }

  /** 审批详情（合并审批页）：完整记录 + 可读 diff 文本（白名单根内、64KB 上限）。 */
  approvalDetail(approvalId: string): {
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
  } | undefined {
    const approval = this.store.getApproval(approvalId)
    if (approval === undefined) return undefined
    let diff: string | null = null
    const diffPath = approval.patch.diff_path
    if (diffPath !== undefined && diffPath.length > 0) {
      try {
        const realDiff = realpathSync(diffPath)
        const realRoot = this.missionRoots(approval.mission_id)
          .map((r) => realpathSync(r))
          .find((r) => realDiff === r || realDiff.startsWith(r + sep))
        if (realRoot !== undefined && statSync(realDiff).isFile() && statSync(realDiff).size <= 64 * 1024) {
          diff = readFileSync(realDiff, 'utf8')
        }
      } catch { /* diff 不可读（worktree 已清理等）→ 详情页降级为仅摘要 */ }
    }
    // 无落盘 diff 时，从 worktree 现算 base..head（真实 git 数据，非存储字段）；
    // worktree 必须仍在该 mission 的白名单根内（防记录被篡改后任意目录执行 git）
    if (diff === null && approval.patch.worktree_path.length > 0) {
      const { base_commit, head_commit } = approval.patch
      if (base_commit !== undefined && head_commit !== undefined) {
        try {
          const realWorktree = realpathSync(approval.patch.worktree_path)
          const inRoots = this.missionRoots(approval.mission_id)
            .map((r) => realpathSync(r))
            .some((r) => realWorktree === r || realWorktree.startsWith(r + sep))
          if (inRoots && existsSync(realWorktree)) {
            const out = execFileSync('git', ['-C', realWorktree, 'diff', `${base_commit}..${head_commit}`], {
              encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024,
            })
            diff = out.length > 64 * 1024 ? `${out.slice(0, 64 * 1024)}\n…（已截断）` : out
          }
        } catch { /* commits 已被 GC / worktree 清理 → 降级为仅摘要 */ }
      }
    }
    return {
      id: approval.id,
      mission_id: approval.mission_id,
      kind: approval.kind ?? 'merge',
      task_id: approval.task_id ?? null,
      status: approval.status,
      decided_at: approval.decided_at ?? null,
      summary: approval.patch.summary,
      worktree_path: approval.patch.worktree_path,
      base_commit: approval.patch.base_commit ?? null,
      head_commit: approval.patch.head_commit ?? null,
      diff,
    }
  }

  /** 指定 mission 的资产白名单根（cwd + 各槽位 worktree）。 */
  private missionRoots(missionId: string): string[] {
    const mission = this.store.getMission(missionId)
    if (mission === undefined) return []
    const roots = [mission.cwd]
    for (const slot of this.store.listSlots(missionId)) {
      if (slot.worktree_path !== undefined && slot.worktree_path.length > 0) roots.push(slot.worktree_path)
    }
    return [...new Set(roots)]
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

  // ── P1 规划层工具面（pod_plan：list / add / replan）─────────────────────

  /** 运行中追加任务节点（走 createTasks 同一裁决：id 白名单/重复/环，fail-closed）。 */
  addPlanTasks(tasks: PlanTaskInput[]): Task[] {
    return this.requireOrchestrator().createTasks(tasks)
  }

  /** 有界重规划：把失败现状喂回 planner 重新分解（REPLAN_LIMIT + 预算门控）。 */
  requestReplan(reason: string): { requested: boolean; remaining: number; message: string } {
    return this.requireOrchestrator().requestReplan(reason)
  }

  replanRemaining(): number {
    return this.requireOrchestrator().replanRemaining()
  }

  /** 当前阵型是否含 planner 槽位（pod_plan 提示与 UI 提示用）。 */
  hasPlannerCapability(): boolean {
    return this.requireOrchestrator().hasPlannerCapability()
  }

  steer(slotId: string, instruction: string): void {
    this.requireOrchestrator().steer(slotId, instruction)
  }

  approve(approvalId: string, by: string, editedParams?: Record<string, string>, rememberRule = true): Promise<ApplyResult> {
    const orch = this.requireOrchestrator()
    const approval = this.store.getApproval(approvalId)
    if (approval === undefined) {
      return Promise.resolve({ ok: false, conflict: false, message: `approval not found: ${approvalId}` })
    }
    // apply_patch 单入口（3.3 节不变量 3）：合并前必须已批准。
    // 先裁决卡 approved（mission 仍 awaiting_approval），ApplyPatch 校验通过后执行 merge；
    // 合并成功才 mission done；失败回滚卡 pending（可重试或驳回）。
    // AS-3（AgentScope-C）：批准可携带人工编辑参数（如 merge_note），审计留痕。
    // W4「记住规则」：rememberRule=false 时批准不生成同类免弹卡规则。
    orch.approveCard(approvalId, by, editedParams, rememberRule)
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
