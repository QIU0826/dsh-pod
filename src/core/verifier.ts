/**
 * Verifier 产物校验层 —— 方案书 3.4/3.5 节，防「静默假成功」（fail-plausible）。
 *
 * 收方不信任叙事，只验证可检查物（附录 F-25/F-28）：
 *   - 报告字段齐全（附录 C schema）
 *   - commit 存在 + parent 可解析（CR-01-3：并行任务串行合并后的校验基准）
 *   - 变更文件在 worktree 白名单内（3.8 节三道防线之一）
 *   - 测试日志存在（test_result != not_run 时）
 *   - 叙事与产物一致（mismatch 判定 → 转人工）
 *
 * 安全立场：不把校验完全寄托在 prompt 约束上，任何一道防线单独都不可信。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { promisify } from 'node:util'
import { validateMissionReport } from './report-schema.js'
import type { TaskVerifyResult } from './task-machine.js'
import type { MissionReport, Task } from './types.js'

const execFileAsync = promisify(execFile)

export interface GitClient {
  commitExists(repoDir: string, sha: string): Promise<boolean>
  parentOf(repoDir: string, sha: string): Promise<string | undefined>
}

/** 真实 git 客户端（git 2.30+，preflight 已保证可用）。 */
export function execGitClient(): GitClient {
  return {
    async commitExists(repoDir, sha) {
      try {
        await execFileAsync('git', ['rev-parse', '--verify', `${sha}^{commit}`], {
          cwd: repoDir,
          timeout: 5000,
          windowsHide: true,
        })
        return true
      } catch {
        return false
      }
    },
    async parentOf(repoDir, sha) {
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', `${sha}^`], {
          cwd: repoDir,
          timeout: 5000,
          windowsHide: true,
        })
        return stdout.trim() || undefined
      } catch {
        return undefined
      }
    },
  }
}

/**
 * 路径白名单：只允许白名单根（worktree 根）之内的相对路径。
 * 语法层拒绝 ..、绝对路径、盘符路径（Windows 专项）；
 * 解析层纵深防御：join+normalize 后必须仍在根内（防拼接绕过）。
 */
export function makePathWhitelist(worktreeRoot: string): (relPath: string) => boolean {
  const rootResolved = normalize(worktreeRoot)
  return (relPath: string): boolean => {
    if (relPath.includes('..')) return false
    if (relPath.startsWith('/') || relPath.startsWith('\\')) return false
    if (/^[a-zA-Z]:/.test(relPath)) return false
    if (relPath.length === 0) return false
    const resolved = normalize(join(rootResolved, relPath))
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) return false
    return true
  }
}

/** 附录 C 强制字段校验（结构层交给 report-schema 单一事实源；此处只做任务类型语义）。 */
export function checkReportCompleteness(
  report: MissionReport,
  taskType: Task['type'] = 'implement',
): { check: string; detail: string }[] {
  const failures: { check: string; detail: string }[] = []
  // 结构完整性由 schema 裁决（DoD-16 单一事实源）：字段枚举/类型/必填在此不再手写
  const structural = validateMissionReport(report)
  if (!structural.ok) {
    for (const error of structural.errors) failures.push({ check: 'report_schema', detail: error })
  }
  const fail = (check: string, detail: string): void => {
    failures.push({ check, detail })
  }
  if ((taskType === 'implement' || taskType === 'test') && report.status === 'done' && !report.commit_sha) {
    fail('commit_sha', 'done report must carry commit_sha (commit discipline D4)')
  }
  if (report.test_result !== 'not_run' && !report.test_evidence) {
    fail('test_evidence', `test_result=${report.test_result} must carry test_evidence`)
  }
  return failures
}

/** 叙事与产物一致性（3.4 节 mismatch 判定；写码任务才要求产物非空）。 */
export function checkNarrativeMatch(task: Task, report: MissionReport): { check: string; detail: string }[] {
  const failures: { check: string; detail: string }[] = []
  const producesArtifacts = task.type === 'implement' || task.type === 'test'
  if (producesArtifacts && report.status === 'done' && report.files_changed.length === 0) {
    failures.push({ check: 'narrative_match', detail: `task ${task.id} claims done but changed no files` })
  }
  if (producesArtifacts && report.status === 'done' && report.test_result === 'fail') {
    // 证据化宽容（CR-06-8）：fail 但 test_evidence 证明是「缺测试框架」而非真实测试失败
    // （npm ENOENT / no package.json / 无测试命令）→ 属 not_run 语义，不判 mismatch。
    const missingFramework = /enoent|not found|no test (framework|command)|no package\.json|没有测试|无测试框架|缺少测试/i.test(
      report.test_evidence ?? '',
    )
    if (!missingFramework) {
      failures.push({ check: 'narrative_match', detail: `task ${task.id} claims done but tests failed` })
    }
  }
  return failures
}

/** 工具调用白名单（--allowedTools 校验，三道防线之一）。 */
export function verifyToolCalls(calls: string[], allowlist: string[]): { check: string; detail: string }[] {
  const allowed = new Set(allowlist)
  const failures: { check: string; detail: string }[] = []
  for (const call of calls) {
    if (!allowed.has(call)) {
      failures.push({ check: 'tool_whitelist', detail: `tool outside allowlist: ${call}` })
    }
  }
  return failures
}

export interface VerifyTaskArtifactsOptions {
  git: GitClient
  repoDir: string
  exists?: (path: string) => boolean
  worktreeRoot?: string
}

/** 在 repoDir 的常见产物目录（out/ 及根）按 basename 查找测试日志（容忍提示词措辞差异）。 */
function findFileByBasename(repoDir: string, basename: string): boolean {
  const candidates = [
    join(repoDir, basename),
    join(repoDir, 'out', basename),
    join(repoDir, 'artifacts', basename),
    join(repoDir, 'logs', basename),
    join(repoDir, 'reports', basename),
    join(repoDir, 'test-results', basename),
  ]
  return candidates.some((p) => existsSync(p))
}

/** 任务 done 报告的全量产物校验 → TaskVerifyResult（task-machine 注入点）。 */
export async function verifyTaskArtifacts(
  options: VerifyTaskArtifactsOptions,
  task: Task,
  report: MissionReport,
): Promise<TaskVerifyResult> {
  const exists = options.exists ?? ((path) => existsSync(path))
  const isAllowed = makePathWhitelist(options.worktreeRoot ?? options.repoDir)
  const failures: { check: string; detail: string }[] = []
  let mismatch = false
  let parentSha: string | undefined

  failures.push(...checkReportCompleteness(report, task.type))

  if (report.status === 'done' && report.commit_sha) {
    const sha = report.commit_sha
    if (!(await options.git.commitExists(options.repoDir, sha))) {
      failures.push({ check: 'commit_exists', detail: `commit not found in worktree: ${sha}` })
    }
    const parent = await options.git.parentOf(options.repoDir, sha)
    if (parent === undefined) {
      failures.push({ check: 'parent_resolvable', detail: `parent of ${sha} not resolvable (CR-01-3 baseline)` })
    } else {
      parentSha = parent
    }
  }

  for (const file of report.files_changed) {
    if (!isAllowed(file)) {
      failures.push({ check: 'path_whitelist', detail: `file outside whitelist: ${file}` })
    }
  }

  // 测试日志文件存在性校验只对产出测试的任务（implement/test）强制：
  // review/doc/plan/research 的 test_evidence 是说明性文本（审查结论/分析），
  // 不要求对应日志文件真实存在（CR-32 实证：review 报告引用测试输出文本被误判为路径）。
  const producesTests = task.type === 'implement' || task.type === 'test'
  if (producesTests && report.test_result !== 'not_run' && report.test_evidence) {
    // test_evidence 可能是「12/12 ✓（输出路径 out/x.log）」形式，取括号内路径；无括号按原值。
    // 中文输出用全角括号（）、提示词会把「输出路径」前缀带进括号 → 全角/半角都解析，
    // 并剥离前缀与首尾空白（CR-06-12 实证：bakeoff pod 条件 test_log_exists 误判）。
    const match = /[（(]([^）)]+)[）)]/.exec(report.test_evidence)
    const rawPath = (match?.[1] ?? report.test_evidence)
      .replace(/^(输出路径|日志路径|测试输出|路径|详见|见|at|output(?: path)?:?)\s*[:：]?\s*/i, '')
      .trim()
    // 相对路径必须相对 repo/worktree 根解析（worker 的 cwd），绝不能用宿主进程 cwd。
    const logPath = isAbsolute(rawPath) ? rawPath : join(options.repoDir, rawPath)
    if (!exists(logPath)) {
      // 精确路径未命中 → basename 模糊匹配（out/ 下按文件名查找），容忍提示词措辞差异（CR-06-12）
      const basename = rawPath.split(/[\\/]/).pop() ?? rawPath
      const found = findFileByBasename(options.repoDir, basename)
      if (!found) {
        failures.push({ check: 'test_log_exists', detail: `test log not found: ${rawPath}` })
      }
    }
  }

  const narrative = checkNarrativeMatch(task, report)
  if (narrative.length > 0) {
    failures.push(...narrative)
    mismatch = true
  }

  return {
    ok: failures.length === 0,
    commit_sha: report.commit_sha,
    parent_sha: parentSha,
    failures,
    mismatch,
  }
}
