/**
 * Demo 后端（--demo 模式）：脚本化 WorkerBackend，零 LLM 成本跑通全链路。
 *
 * 行为契约（确定性，供端到端验证与产品演示）：
 *   - plan 任务 → 提案 2 实现 + 1 审查的 DAG（走真实 planner 裁决/expand 管线）；
 *   - 首个实现任务 → 先 need_clarify 提两个问题（走真实 task_question → 人工答复
 *     steer → resolve → 重派链路）；人工答复后（spec 含「排队指令」标记）才真干活；
 *   - 干活 = 在槽位 worktree 里写文件 + 真实 git commit（走真实 Verifier/审批/合并）；
 *   - review 任务 → 通过（带一条建议）。
 * 不模拟任何跳过：所有状态迁移都经由引擎真实代码路径。
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentSlot,
  Task,
  Vendor,
  WorkerBackend,
  WorkerCompletion,
  WorkerHandle,
  WorkerProgressEvent,
  WorkerProtocol,
} from '../core/types.js'

const DEMO_PROTOCOL: WorkerProtocol = {
  family: 'native',
  version: 'demo-scripted-1',
  capabilities: { kill: false, session_persist: false, structured_output: true, usage_audit: true },
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function git(worktree: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-C', worktree, '-c', 'user.name=pod-demo', '-c', 'user.email=pod-demo@local', ...args],
    { encoding: 'utf8', timeout: 15_000 },
  ).trim()
}

export class DemoBackend implements WorkerBackend {
  readonly vendor: Vendor
  readonly protocol: WorkerProtocol = DEMO_PROTOCOL
  private runCount = 0
  private askedQuestion = false

  constructor(vendor: Vendor) {
    this.vendor = vendor
  }

  detect(): Promise<{ installed: boolean; authed: boolean; models: string[]; version?: string; session_tiers: Array<'transient' | 'per-mission'>; error?: string }> {
    return Promise.resolve({
      installed: true,
      authed: true,
      models: ['demo-scripted'],
      version: '1.0.0',
      session_tiers: ['transient'],
    })
  }

  async start(
    slot: AgentSlot,
    task: Task,
    worktree: string,
    callbacks?: {
      onProgress?(event: WorkerProgressEvent): void
      onExit?(completion: WorkerCompletion): void
    },
  ): Promise<WorkerHandle> {
    void slot
    this.runCount += 1
    const emit = (text: string): void => {
      callbacks?.onProgress?.({
        slot_id: slot.id, task_id: task.id, ts: Date.now(), kind: 'text', text,
      })
    }
    const finish = (completion: WorkerCompletion): void => {
      callbacks?.onExit?.(completion)
    }
    const usage = { tokens_in: 900 + this.runCount * 130, tokens_out: 420 + this.runCount * 60, source: 'unavailable' as const }

    // 异步脚本：进度流 → 完成报告（不阻塞 dispatchTask）
    void (async () => {
      try {
        if (task.type === 'plan') {
          emit(`解析目标：${task.spec.slice(0, 80)}…`)
          await sleep(500)
          emit('正在分解为任务 DAG（2 个实现 + 1 个独立审查）…')
          await sleep(600)
          finish({
            exit: 'done',
            usage,
            artifacts: [],
            report: {
              task_id: task.id,
              task_type: 'plan',
              status: 'done',
              summary: '目标已分解为 3 个任务：安装章节与环境要求并行实现，独立审查收口。',
              files_changed: [],
              test_result: 'not_run',
              decisions: ['按「实现并行 + 审查串行收口」组织 DAG'],
              blockers: [],
              questions: [],
              plan: [
                { id: 'T-1', title: '实现 README 安装章节', spec: '在 README.md 增加「安装」章节：npm install / npm run build / 验证命令。', type: 'implement', skill_tags: ['编码'], depends_on: [] },
                { id: 'T-2', title: '补充环境要求说明', spec: '在 README.md 安装章节内补充 Node.js 与系统要求说明。', type: 'implement', skill_tags: ['编码'], depends_on: [] },
                { id: 'T-3', title: '独立审查安装文档', spec: '审查 README 安装章节的完整性与可执行性，给出结论。', type: 'review', skill_tags: ['审查'], depends_on: ['T-1', 'T-2'] },
              ],
            },
          })
          return
        }

        if (task.type === 'review') {
          emit('阅读被审 diff 与规格…')
          await sleep(700)
          emit('审查结论：安装命令清晰，建议补充 Node.js 版本要求。')
          await sleep(400)
          finish({
            exit: 'done',
            usage,
            artifacts: [],
            report: {
              task_id: task.id,
              task_type: 'review',
              status: 'done',
              summary: '审查通过：安装命令清晰可执行，建议补充 Node.js 版本要求（非阻塞）。',
              files_changed: [],
              test_result: 'not_run',
              decisions: ['通过合并'],
              blockers: [],
              questions: [],
            },
          })
          return
        }

        // 实现/测试/文档类：首次先提问（need_clarify → 人工答复 → 重派才干活）
        if (!task.spec.includes('排队指令') && !this.askedQuestion) {
          this.askedQuestion = true
          emit(`开始实现「${task.title}」…有一个前置问题需要确认。`)
          await sleep(600)
          finish({
            exit: 'done',
            usage,
            artifacts: [],
            report: {
              task_id: task.id,
              task_type: task.type,
              status: 'need_clarify',
              summary: '实现前需要澄清文档覆盖范围。',
              files_changed: [],
              test_result: 'not_run',
              decisions: [],
              blockers: [],
              questions: ['安装说明是否需要包含 Windows 环境的步骤？', '是否需要标注 Node.js 最低版本？'],
            },
          })
          return
        }

        emit(`按人工答复继续实现「${task.title}」：写入文件并提交。`)
        await sleep(600)
        const target = join(worktree, task.type === 'test' ? `NOTES-${task.id}.test.md` : 'README.md')
        if (!existsSync(target)) writeFileSync(target, `# Demo Repo\n\n目标：${task.mission_id}\n`, 'utf8')
        appendFileSync(target, `\n\n## ${task.title}（${task.id}）\n\n- npm install dsh-pod\n- npm run build\n- Node.js >= 20（含 Windows 说明）\n`, 'utf8')
        const outDir = join(worktree, 'out')
        mkdirSync(outDir, { recursive: true })
        writeFileSync(join(outDir, `${task.id}.log`), `[demo] ${task.id} self-check passed (1/1)\n`, 'utf8')
        git(worktree, ['add', '-A'])
        git(worktree, ['commit', '-m', `[demo] ${task.id} ${task.title}`])
        const head = git(worktree, ['rev-parse', 'HEAD'])
        emit(`已提交 ${head.slice(0, 8)}，自检通过（1/1）。`)
        await sleep(400)
        finish({
          exit: 'done',
          usage,
          artifacts: [target],
          report: {
            task_id: task.id,
            task_type: task.type,
            status: 'done',
            summary: `完成「${task.title}」：更新 README 并通过自检。`,
            files_changed: [task.type === 'test' ? `NOTES-${task.id}.test.md` : 'README.md'],
            commit_sha: head,
            diff_path: undefined,
            test_command: 'npm run demo-check',
            test_result: 'pass',
            test_evidence: `自检 1/1 通过（输出路径 out/${task.id}.log）`,
            decisions: ['包含 Windows 说明', '标注 Node.js >= 20'],
            blockers: [],
            questions: [],
          },
        })
      } catch (error) {
        finish({
          exit: 'failed',
          fault: 'crash',
          usage,
          artifacts: [],
          exit_code: 1,
          report: undefined,
        })
        void error
      }
    })()

    return {}
  }

  kill(): Promise<void> {
    return Promise.resolve()
  }
}
