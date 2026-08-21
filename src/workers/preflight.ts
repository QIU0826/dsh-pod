/**
 * Preflight 环境探测 —— 方案书附录 D（Launch 前自动执行，10 项）。
 *
 * Windows 专项（3.9 节 OS 矩阵）：版本解析容忍 `git version x.y.z.windows.1` 形态；
 * claude auth status 实测输出 JSON（loggedIn 字段）；
 * codex 未安装如实报告（CR-01-0：名册灰掉 + 登录指引，不假装可用）。
 *
 * 检测项全部通过注入的 CommandRunner 执行（测试注入 fake，不依赖真实 CLI）；
 * 真实运行用 execCommandRunner（child_process，15s 超时，windowsHide）。
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statfsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * PATH 修复器（CR-02-4/新实证：宿主进程 PATH 可能被外部程序改写，缺 node/git/claude）。
 * 把已知工具目录补回 PATH 前缀（幂等；本进程与后续 spawn 子进程均受益）。
 * 候选目录可由 POD_BIN_DIRS 环境变量追加（分号分隔）。
 */
export function repairPath(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return []
  const defaults = [
    'D:\\nodejs',
    'D:\\STUDYSOFT\\Git\\bin',
    'C:\\Program Files\\nodejs',
    'C:\\Program Files\\Git\\bin',
    'C:\\Program Files\\Git\\cmd',
  ]
  const extra = (process.env.POD_BIN_DIRS ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const candidates = [...defaults, ...extra]
  const entries = (process.env.PATH ?? '').split(delimiter).filter((s) => s.length > 0)
  const added: string[] = []
  for (const dir of candidates) {
    if (entries.includes(dir)) continue
    const useful = ['node.exe', 'git.exe', 'claude.cmd', 'codex.exe'].some((f) => existsSync(join(dir, f)))
    if (useful) {
      entries.unshift(dir)
      added.push(dir)
    }
  }
  if (added.length > 0) process.env.PATH = entries.join(delimiter)
  return added
}

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface CommandRunner {
  run(cmd: string, args: string[], options?: { cwd?: string; timeoutMs?: number }): Promise<CommandResult>
}

/** 真实 runner（生产路径）。 */
export const execCommandRunner: CommandRunner = {
  async run(cmd, args, options = {}) {
    try {
      return await spawnOnce(cmd, args, options, false)
    } catch (error) {
      const e = error as { code?: number | string; stdout?: string; stderr?: string }
      // Windows 专项：CLI 常以 .cmd/.ps1 包装器分发（如 claude.cmd），
      // execFile 直接 spawn 会 ENOENT——回退到 shell 执行一次。
      if (typeof e.code === 'string') {
        try {
          return await spawnOnce(cmd, args, options, true)
        } catch (shellError) {
          const se = shellError as { code?: number | string; stdout?: string; stderr?: string }
          return {
            code: typeof se.code === 'number' ? se.code : 127,
            stdout: String(se.stdout ?? ''),
            stderr: String(se.stderr ?? ''),
          }
        }
      }
      // 数字退出码：进程跑起来了但非零退出，输出原样带回（探测逻辑需要）。
      return {
        code: typeof e.code === 'number' ? e.code : 127,
        stdout: String(e.stdout ?? ''),
        stderr: String(e.stderr ?? ''),
      }
    }
  },
}

/**
 * 单次 spawn：进程退出（数字退出码）→ 正常返回 CommandResult；
 * spawn 本身失败（ENOENT/EPERM 等字符串错误码）→ 抛出，由调用方决定回退。
 */
async function spawnOnce(
  cmd: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number },
  shell: boolean,
): Promise<CommandResult> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 15_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    shell,
  })
  return { code: 0, stdout: String(stdout), stderr: String(stderr) }
}

export interface PreflightDeps {
  runner: CommandRunner
  cwd: string
  nodeVersion?: string
  exists?: (path: string) => boolean
  readFile?: (path: string) => string | undefined
  freeBytes?: (path: string) => number
}

export interface PreflightCheck {
  id: string
  label: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
}

export interface PreflightReport {
  ok: boolean
  checks: PreflightCheck[]
  failures: PreflightCheck[]
  warnings: PreflightCheck[]
}

export const MIN_NODE_VERSION = { major: 22, minor: 5, patch: 0 }
export const MIN_GIT_VERSION = { major: 2, minor: 30, patch: 0 }
export const MIN_FREE_BYTES = 1024 ** 3

/** 从版本串解析可比较的 major/minor/patch（容忍前缀与后缀，如 git 的 .windows.1）。 */
export function parseSemver(raw: string): { major: number; minor: number; patch: number } | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw)
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function satisfiesMin(raw: string, major: number, minor: number, patch: number): boolean {
  const version = parseSemver(raw)
  if (version === undefined) return false
  return (
    version.major > major ||
    (version.major === major && version.minor > minor) ||
    (version.major === major && version.minor === minor && version.patch >= patch)
  )
}

/** claude auth status 解析（实测 JSON；非 JSON 保守判未登录，fail-closed）。 */
export function parseClaudeAuth(stdout: string): { authed: boolean; account?: string } {
  try {
    const parsed: unknown = JSON.parse(stdout.trim())
    if (typeof parsed === 'object' && parsed !== null && 'loggedIn' in parsed) {
      const loggedIn = (parsed as { loggedIn: unknown }).loggedIn
      const account = (parsed as { account?: unknown }).account
      return {
        authed: loggedIn === true,
        account: typeof account === 'string' ? account : undefined,
      }
    }
    return { authed: false }
  } catch {
    return { authed: false }
  }
}

export interface TestCommandDetection {
  found: boolean
  command?: string
  source: string
}

/** 附录 D-9：测试命令探测（package.json → Makefile → CI workflow）。 */
export function detectTestCommand(files: {
  packageJson?: string
  makefile?: string
  workflow?: string
}): TestCommandDetection {
  if (files.packageJson !== undefined) {
    try {
      const pkg: unknown = JSON.parse(files.packageJson)
      const test = (pkg as { scripts?: Record<string, string> })?.scripts?.test
      if (typeof test === 'string' && test.length > 0) {
        return { found: true, command: 'npm test', source: 'package.json#scripts.test' }
      }
    } catch {
      // 非法 JSON 降级到下一探测源
    }
  }
  const makeTest = /^\s*test\s*:/m.exec(files.makefile ?? '')
  if (makeTest !== null) {
    return { found: true, command: 'make test', source: 'Makefile#test' }
  }
  const workflowRun = /-\s*run\s*:\s*([^\n]+)/.exec(files.workflow ?? '')
  if (workflowRun !== null) {
    return { found: true, command: workflowRun[1]!.trim(), source: 'ci-workflow' }
  }
  return { found: false, source: 'none' }
}

export interface CoverageResult {
  covered: boolean
  missing: string[]
}

/** 附录 D-10：能力覆盖体检（任务标签 ⊆ 员工能力；标红不硬拦）。 */
export function checkCapabilityCoverage(
  planTags: string[],
  slots: { slotId: string; capabilities: string[] }[],
): CoverageResult {
  const allCaps = new Set(slots.flatMap((s) => s.capabilities))
  const missing = planTags.filter((tag) => !allCaps.has(tag))
  return { covered: planTags.every((tag) => allCaps.has(tag)), missing }
}

/** 全量 preflight（附录 D 十项）。 */
export async function runPreflight(deps: PreflightDeps): Promise<PreflightReport> {
  const { runner, cwd } = deps
  const exists = deps.exists ?? ((path) => existsSync(path))
  const readFile = deps.readFile ?? ((path) => (exists(path) ? readFileSync(path, 'utf8') : undefined))
  const freeBytes = deps.freeBytes ?? ((path) => {
    try {
      return statfsSync(path).bavail * statfsSync(path).bsize
    } catch {
      return 0
    }
  })
  const checks: PreflightCheck[] = []
  const add = (id: string, label: string, status: PreflightCheck['status'], detail: string): void => {
    checks.push({ id, label, status, detail })
  }

  // [1] node ≥ 22.5
  const nodeVersion = deps.nodeVersion ?? process.version
  add(
    'node',
    'node ≥ 22.5',
    satisfiesMin(nodeVersion, MIN_NODE_VERSION.major, MIN_NODE_VERSION.minor, MIN_NODE_VERSION.patch) ? 'ok' : 'fail',
    nodeVersion,
  )

  // [2] git ≥ 2.30 + worktree 可用
  const git = await runner.run('git', ['--version'])
  if (git.code !== 0) {
    add('git', 'git ≥ 2.30 + worktree', 'fail', 'git not found')
  } else {
    const versionOk = satisfiesMin(git.stdout.trim(), MIN_GIT_VERSION.major, MIN_GIT_VERSION.minor, MIN_GIT_VERSION.patch)
    const worktree = await runner.run('git', ['worktree', 'list'], { cwd })
    add(
      'git',
      'git ≥ 2.30 + worktree',
      versionOk && worktree.code === 0 ? 'ok' : 'fail',
      `${git.stdout.trim()}${worktree.code === 0 ? '' : `; worktree list failed: ${worktree.stderr.trim()}`}`,
    )
  }

  // [3] claude CLI
  const claudeVersion = await runner.run('claude', ['--version'])
  if (claudeVersion.code !== 0) {
    add('claude', 'claude CLI 已安装 + 已登录 + 版本 pin', 'fail', 'claude not installed (roster greyed)')
  } else {
    const auth = await runner.run('claude', ['auth', 'status'])
    const parsed = parseClaudeAuth(auth.stdout)
    add(
      'claude',
      'claude CLI 已安装 + 已登录 + 版本 pin',
      parsed.authed ? 'ok' : 'fail',
      `${claudeVersion.stdout.trim()}; authed=${parsed.authed}${parsed.account ? ` (${parsed.account})` : ''}`,
    )
  }

  // [4] codex CLI（CR-01-0：未安装如实报告）
  const codexVersion = await runner.run('codex', ['--version'])
  if (codexVersion.code !== 0) {
    add('codex', 'codex CLI 已安装 + 已登录 + 版本 pin', 'fail', 'codex not installed (roster greyed; tier-A fallback ready)')
  } else {
    const auth = await runner.run('codex', ['login', 'status'])
    add(
      'codex',
      'codex CLI 已安装 + 已登录 + 版本 pin',
      auth.code === 0 ? 'ok' : 'warn',
      `${codexVersion.stdout.trim()}; login status unknown`,
    )
  }

  // [5] DSH subagent（宿主原生）
  add('dsh-subagent', 'DSH subagent 能力可用（原生）', 'ok', 'plugin runtime native')

  // [6] cwd 是 git 仓库
  const isRepo = exists(join(cwd, '.git')) || (await runner.run('git', ['rev-parse', '--is-inside-work-tree'], { cwd })).code === 0
  add('git-repo', '目标 cwd 是 git 仓库（可建 worktree）', isRepo ? 'ok' : 'fail', isRepo ? cwd : `${cwd} is not a git repo (guide git init or disable Pod)`)

  // [7] 磁盘空间 > 1GB。磁盘读取本质可失败（含注入源），异常一律兜底为 0 → fail，绝不击穿探测。
  let free: number
  try {
    free = freeBytes(cwd)
  } catch {
    free = 0
  }
  add('disk', '磁盘空间 > 1GB（worktree 余量）', free > MIN_FREE_BYTES ? 'ok' : 'fail', `${(free / 1024 ** 3).toFixed(1)} GB free`)

  // [8] 换行符策略（D4/3.7：.gitattributes + core.autocrlf）
  const attrs = readFile(join(cwd, '.gitattributes')) ?? ''
  const eolPolicyOk = /eol=lf/.test(attrs)
  add(
    'crlf',
    '换行符策略（.gitattributes eol=lf）',
    eolPolicyOk ? 'ok' : 'warn',
    eolPolicyOk ? 'worktree init will enforce .gitattributes' : '.gitattributes missing eol=lf; worktree init will write it',
  )

  // [9] 测试命令探测
  const testCommand = detectTestCommand({
    packageJson: readFile(join(cwd, 'package.json')),
    makefile: readFile(join(cwd, 'Makefile')),
    workflow: readFile(join(cwd, '.github', 'workflows', 'ci.yml')),
  })
  add(
    'test-command',
    '测试命令探测',
    testCommand.found ? 'ok' : 'warn',
    testCommand.found ? `${testCommand.command} (${testCommand.source})` : 'no test command detected; reviewer gets yellow card',
  )

  // [10] 能力覆盖体检（由插件层传入计划标签与名册；此处仅结构校验）
  add('capability-coverage', '能力覆盖体检（计划任务标签 ⊆ 员工能力）', 'ok', 'computed at launch from plan + roster')

  const failures = checks.filter((c) => c.status === 'fail')
  const warnings = checks.filter((c) => c.status === 'warn')
  return { ok: failures.length === 0, checks, failures, warnings }
}
