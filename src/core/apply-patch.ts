/**
 * ApplyPatch —— 方案书 3.7 节合并协调器（W5 切片）。
 *
 * apply_patch 单入口：审批通过后把员工 worktree 的分支串行合并回主树；
 *   合并前校验审批卡已 approved（ApprovalConflictError）；
 *   串行化：模块内 promise 链锁，锁竞争按 CR 重试保护（防 commit 丢失，R11）；
 *   冲突：git merge --abort，主树保持干净，冲突详情随结果返回（UI 弹卡附 diff）；
 *   失败永不破坏主树：任何异常路径先 abort 再上报。
 *
 * Windows 专项：execFile 直接跑 git（.exe，无 .cmd 包装问题）；路径含空格用数组参数。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ApprovalConflictError, NotFoundError } from './errors.js'
import type { PodStore } from './store.js'
import type { ApprovalRequest } from './types.js'

const execFileAsync = promisify(execFile)

export interface GitRunner {
  run(args: string[], options: { cwd: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>
}

/** 真实 git runner（沿用 preflight 的容错语义：非零退出返回而非抛出）。 */
export function execGitRunner(): GitRunner {
  return {
    async run(args, options) {
      try {
        const { stdout, stderr } = await execFileAsync('git', args, {
          cwd: options.cwd,
          timeout: options.timeoutMs ?? 60_000,
          windowsHide: true,
          maxBuffer: 32 * 1024 * 1024,
        })
        return { code: 0, stdout: String(stdout), stderr: String(stderr) }
      } catch (error) {
        const e = error as { code?: number | string; stdout?: string; stderr?: string }
        return {
          code: typeof e.code === 'number' ? e.code : 127,
          stdout: String(e.stdout ?? ''),
          stderr: String(e.stderr ?? ''),
        }
      }
    },
  }
}

export type ApplyResult =
  | { ok: true; mergeCommit: string }
  | { ok: false; conflict: boolean; message: string }

export interface ApplyPatchOptions {
  store: PodStore
  git: GitRunner
  /** 锁重试次数（并发 merge 串行化等待）。 */
  lockAttempts?: number
  lockBackoffMs?: number
  clock?: () => number
  sleep?: (ms: number) => Promise<void>
}

export class ApplyPatch {
  private readonly store: PodStore
  private readonly git: GitRunner
  private readonly lockAttempts: number
  private readonly lockBackoffMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private mergeQueue: Promise<unknown> = Promise.resolve()

  constructor(options: ApplyPatchOptions) {
    this.store = options.store
    this.git = options.git
    this.lockAttempts = options.lockAttempts ?? 5
    this.lockBackoffMs = options.lockBackoffMs ?? 1_000
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * apply_patch 单入口（3.3 节不变量 3：合并只走本入口）。
   * 串行队列保证同一时刻至多一个 merge 在跑（R11 锁竞争对策）。
   */
  apply(missionId: string, approval: ApprovalRequest): Promise<ApplyResult> {
    const run = this.mergeQueue.then(() => this.applyLocked(missionId, approval))
    // 队列吞错：单次失败不阻塞后续（失败已通过结果返回）
    this.mergeQueue = run.catch(() => undefined)
    return run
  }

  private async applyLocked(missionId: string, approval: ApprovalRequest): Promise<ApplyResult> {
    const stored = this.store.getApproval(approval.id)
    if (stored === undefined) throw new NotFoundError('approval', approval.id)
    if (stored.status !== 'approved') {
      throw new ApprovalConflictError(approval.id, 'approved', stored.status)
    }
    const mission = this.store.getMission(missionId)
    if (mission === undefined) throw new NotFoundError('mission', missionId)
    const worktreePath = stored.patch.worktree_path

    let lastFailure = ''
    for (let attempt = 0; attempt < this.lockAttempts; attempt++) {
      if (attempt > 0) await this.sleep(this.lockBackoffMs * attempt)
      const lock = await this.git.run(['rev-parse', '--git-dir'], { cwd: mission.cwd })
      if (lock.code !== 0) {
        lastFailure = `main tree not accessible: ${lock.stderr}`
        continue
      }
      if (worktreePath.length === 0) {
        return { ok: false, conflict: false, message: 'approval patch has no worktree path' }
      }
      // 分支有效性：worktree 的 HEAD 即其分支
      const branchCheck = await this.git.run(['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: mission.cwd })
      if (branchCheck.code !== 0) {
        return { ok: false, conflict: false, message: `worktree not accessible: ${branchCheck.stderr}` }
      }
      const merge = await this.git.run(['merge', '--no-ff', branchCheck.stdout.trim(), '-m', `pod: merge ${stored.patch.slot_id} (approval ${approval.id})`], {
        cwd: mission.cwd,
      })
      if (merge.code === 0) {
        const head = await this.git.run(['rev-parse', 'HEAD'], { cwd: mission.cwd })
        this.store.appendEvent(missionId, {
          id: `ev-merge-${approval.id}`,
          mission_id: missionId,
          ts: Date.now(),
          kind: 'merge_completed',
          payload: { approval_id: approval.id, branch: branchCheck.stdout.trim(), merge_commit: head.stdout.trim() },
        })
        return { ok: true, mergeCommit: head.stdout.trim() }
      }
      // 失败：先 abort 保护主树，再分类
      await this.git.run(['merge', '--abort'], { cwd: mission.cwd })
      const conflict = /conflict/i.test(merge.stderr) || /conflict/i.test(merge.stdout)
      if (!conflict) {
        lastFailure = merge.stderr || merge.stdout || 'merge failed'
        continue
      }
      this.store.appendEvent(missionId, {
        id: `ev-merge-conflict-${approval.id}`,
        mission_id: missionId,
        ts: Date.now(),
        kind: 'merge_conflict',
        payload: { approval_id: approval.id, message: (merge.stderr || merge.stdout).slice(0, 500) },
      })
      return { ok: false, conflict: true, message: (merge.stderr || merge.stdout).slice(0, 500) }
    }
    return { ok: false, conflict: false, message: lastFailure || 'merge lock acquisition failed after retries' }
  }
}
