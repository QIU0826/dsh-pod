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
import { existsSync, mkdirSync } from 'node:fs'
import { ApprovalEngine } from './core/approvals.js'
import { ApplyPatch, execGitRunner, type ApplyResult } from './core/apply-patch.js'
import { MissionOrchestrator, type LaunchInput, type PlanTaskInput, type RunSummary } from './core/orchestrator.js'
import { execGitClient, verifyTaskArtifacts } from './core/verifier.js'
import type { JsonStore } from './core/store.js'
import { ClaudeHeadlessBackend } from './workers/claude-headless.js'
import { CodexHeadlessBackend, codexBinaryCandidates } from './workers/codex-headless.js'
import { repairPath } from './workers/preflight.js'
import type { ApprovalRequest, Mission, Task, Vendor, WorkerBackend } from './core/types.js'

export interface PodServiceOptions {
  store: JsonStore
  /** 默认数据根（~/.dsh/pod）。 */
  dataDir?: string
  backends?: Partial<Record<Vendor, WorkerBackend>>
  clock?: () => number
}

/** commander 会话启动器（插件层注入：ctx.agents.create + agentCtx 作用域注册，CR-05-2）。 */
export type CommanderLauncher = (goal: string, cwd: string, agentPreset?: string) => Promise<{ sessionId: string }>

export class PodService {
  private readonly store: JsonStore
  private readonly clock: () => number
  private readonly backends: Partial<Record<Vendor, WorkerBackend>>
  private orchestrator: MissionOrchestrator | undefined
  private running: Promise<RunSummary> | undefined
  private commanderLauncher: CommanderLauncher | undefined

  constructor(options: PodServiceOptions) {
    this.store = options.store
    this.clock = options.clock ?? (() => Date.now())
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
    const missionId = `M-${this.clock()}-${Math.floor(Math.random() * 1e6)}`
    const orchestrator = this.makeOrchestrator(missionId)
    const mission = orchestrator.launch(input)
    if (input.plan !== undefined && input.plan.length > 0) {
      orchestrator.createTasks(input.plan)
    }
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
        this.store.appendEvent(missionId, {
          id: `ev-commander-error-${this.clock()}`,
          mission_id: missionId,
          ts: this.clock(),
          kind: 'commander_creation_error',
          payload: { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
        })
      })
    }
    return mission
  }

  /** 宿主周期巡检：watchdog + 审批超期（CR-05-6）。 */
  maintenanceTick(): { staleApprovals: string[]; watchdogFired: number } {
    if (this.orchestrator === undefined) return { staleApprovals: [], watchdogFired: 0 }
    return this.orchestrator.maintenanceTick()
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
    pendingApprovals: ApprovalRequest[]
    runStatus?: string
  } {
    const active = this.store.getActiveMission()
    if (active === undefined) return { tasks: [], pendingApprovals: [] }
    const orch = this.requireOrchestrator()
    const snapshot = orch.status()
    return {
      mission: snapshot.mission,
      tasks: snapshot.tasks,
      pendingApprovals: snapshot.pendingApprovals,
      runStatus: this.running !== undefined ? 'running' : 'idle',
    }
  }

  /** 手动模式（3.3 节）：UI/工具直连状态机接口，绕开 LLM 编排。 */
  dispatchNext(): Promise<boolean> {
    return this.requireOrchestrator().dispatchNext()
  }

  steer(slotId: string, instruction: string): void {
    this.requireOrchestrator().steer(slotId, instruction)
  }

  approve(approvalId: string, by: string): Promise<ApplyResult> {
    const orch = this.requireOrchestrator()
    const approval = this.store.getApproval(approvalId)
    if (approval === undefined) {
      return Promise.resolve({ ok: false, conflict: false, message: `approval not found: ${approvalId}` })
    }
    // apply_patch 单入口（3.3 节不变量 3）：合并成功才裁决 mission done；冲突保持 awaiting_approval
    const applyPatch = new ApplyPatch({ store: this.store, git: execGitRunner() })
    return applyPatch.apply(approval.mission_id, approval).then((result) => {
      if (result.ok) orch.approve(approvalId, by)
      return result
    })
  }

  deny(approvalId: string, by: string, reason: string): void {
    this.requireOrchestrator().deny(approvalId, by, reason)
  }

  abort(reason: string): void {
    this.requireOrchestrator().abortMission(reason)
  }

  waitRun(): Promise<RunSummary> | undefined {
    return this.running
  }
}

/** 默认数据根（插件与 CLI 共用）。 */
export function defaultPodDataDir(): string {
  return join(homedir(), '.dsh', 'pod')
}

export function ensureDataDir(): string {
  const dir = defaultPodDataDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 供工具层使用的审批引擎（跨重启重建审批卡的读面）。 */
export function approvalsFor(store: JsonStore): ApprovalEngine {
  return new ApprovalEngine(store)
}
