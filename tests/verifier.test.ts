import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkNarrativeMatch,
  checkReportCompleteness,
  execGitClient,
  makePathWhitelist,
  verifyTaskArtifacts,
  verifyToolCalls,
} from '../src/core/verifier.js'
import type { MissionReport, Task } from '../src/core/types.js'

const now = 1_700_000_000_000

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'T-1',
    mission_id: 'M-1',
    title: 't',
    spec: 's',
    skill_tags: [],
    type: 'implement',
    depends_on: [],
    status: 'running',
    attempts: 0,
    soft_attempts: 0,
    max_wall_clock_ms: 3600_000,
    created_at: now,
    updated_at: now,
    ...over,
  }
}

function doneReport(over: Partial<MissionReport> = {}): MissionReport {
  return {
    task_id: 'T-1',
    task_type: 'implement',
    status: 'done',
    summary: 'implemented',
    files_changed: ['src/x.ts'],
    commit_sha: 'abc123',
    test_result: 'pass',
    test_evidence: '12/12 ✓',
    decisions: [],
    blockers: [],
    questions: [],
    ...over,
  }
}

describe('makePathWhitelist（路径白名单，3.8 节三道防线之一）', () => {
  const root = 'C:\\repo\\.worktrees\\S-1'
  const allowed = makePathWhitelist(root)

  it('白名单内相对路径放行', () => {
    expect(allowed('src/middleware/rate-limit.ts')).toBe(true)
  })
  it('越界 .. 拒绝', () => {
    expect(allowed('../secret.md')).toBe(false)
    expect(allowed('a/../../secret.md')).toBe(false)
  })
  it('绝对路径拒绝', () => {
    expect(allowed('C:\\Users\\x\\secret.md')).toBe(false)
    expect(allowed('C:/repo/.worktrees/S-1/src/x.ts')).toBe(false)
  })
  it('盘符相对路径拒绝', () => {
    expect(allowed('C:secret.md')).toBe(false)
  })
})

describe('checkReportCompleteness（附录 C schema 强制字段）', () => {
  it('完整报告零失败', () => {
    expect(checkReportCompleteness(doneReport())).toEqual([])
  })
  it('done 报告缺 commit_sha → 失败（commit 纪律 D4）', () => {
    const failures = checkReportCompleteness(doneReport({ commit_sha: undefined }))
    expect(failures.some((f) => f.check === 'commit_sha')).toBe(true)
  })
  it('pass 缺 test_evidence → 失败', () => {
    const failures = checkReportCompleteness(doneReport({ test_evidence: undefined }))
    expect(failures.some((f) => f.check === 'test_evidence')).toBe(true)
  })
  it('not_run 不强制 test_evidence（charter 允许注明 not_run）', () => {
    const failures = checkReportCompleteness(doneReport({ test_result: 'not_run', test_evidence: undefined }))
    expect(failures).toEqual([])
  })
  it('status 非法枚举 → 失败', () => {
    const failures = checkReportCompleteness(
      doneReport({ status: 'whatever' as MissionReport['status'] }),
    )
    expect(failures.some((f) => f.check === 'status')).toBe(true)
  })
})

describe('checkNarrativeMatch（叙事与产物一致性，防静默假成功）', () => {
  it('一致 → 零失败', () => {
    expect(checkNarrativeMatch(makeTask(), doneReport())).toEqual([])
  })
  it('声称 done 但 files_changed 为空 → mismatch', () => {
    const failures = checkNarrativeMatch(makeTask(), doneReport({ files_changed: [] }))
    expect(failures.some((f) => f.check === 'narrative_match')).toBe(true)
  })
  it('声称 done 但 test_result=fail → mismatch', () => {
    const failures = checkNarrativeMatch(makeTask(), doneReport({ test_result: 'fail' }))
    expect(failures.some((f) => f.check === 'narrative_match')).toBe(true)
  })
})

describe('verifyToolCalls（--allowedTools 白名单校验）', () => {
  it('白名单内工具放行', () => {
    expect(verifyToolCalls(['Bash', 'Read'], ['Bash', 'Read', 'Edit'])).toEqual([])
  })
  it('白名单外工具拒绝', () => {
    const failures = verifyToolCalls(['Bash', 'WebFetch'], ['Bash'])
    expect(failures.some((f) => f.check === 'tool_whitelist')).toBe(true)
  })
})

/** 真实 git 集成测试：本机 git 2.50 实证可用（方案书 3.9 节 OS 矩阵）。 */
const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
})()

describe.runIf(gitAvailable)('verifyTaskArtifacts × 真实 git 仓库', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'pod-verify-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
    writeFileSync(join(repo, 'x.ts'), 'export const x = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'first'], { cwd: repo })
    writeFileSync(join(repo, 'x.ts'), 'export const x = 2\n')
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'second'], { cwd: repo })
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  const headSha = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim()
  const firstSha = () => execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: repo }).toString().trim()

  it('真实 commit + 可解析 parent → 通过（CR-01-3 校验基准）', async () => {
    const verdict = await verifyTaskArtifacts(
      { git: execGitClient(), repoDir: repo },
      makeTask(),
      doneReport({ commit_sha: headSha(), test_result: 'not_run', test_evidence: undefined }),
    )
    expect(verdict.ok).toBe(true)
    expect(verdict.parent_sha).toBe(firstSha())
  })

  it('commit 不存在 → silent_failure 校验失败（静默假成功对策）', async () => {
    const verdict = await verifyTaskArtifacts(
      { git: execGitClient(), repoDir: repo },
      makeTask(),
      doneReport({ commit_sha: 'deadbeef' }),
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.some((f) => f.check === 'commit_exists')).toBe(true)
    expect(verdict.mismatch).toBe(false)
  })

  it('文件不在白名单（写出 repo）→ 校验失败', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'pod-outside-'))
    try {
      const verdict = await verifyTaskArtifacts(
        { git: execGitClient(), repoDir: repo },
        makeTask(),
        doneReport({ commit_sha: headSha(), files_changed: [`${outside}\\secret.ts`] }),
      )
      expect(verdict.ok).toBe(false)
      expect(verdict.failures.some((f) => f.check === 'path_whitelist')).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('test_evidence 指向的日志文件必须存在', async () => {
    mkdirSync(join(repo, 'out'))
    writeFileSync(join(repo, 'out', 't.log'), '12/12 ✓')
    const verdict = await verifyTaskArtifacts(
      { git: execGitClient(), repoDir: repo },
      makeTask(),
      doneReport({ commit_sha: headSha(), test_evidence: 'out/t.log' }),
    )
    expect(verdict.ok).toBe(true)

    const missing = await verifyTaskArtifacts(
      { git: execGitClient(), repoDir: repo },
      makeTask(),
      doneReport({ commit_sha: headSha(), test_evidence: 'out/nope.log' }),
    )
    expect(missing.ok).toBe(false)
    expect(missing.failures.some((f) => f.check === 'test_log_exists')).toBe(true)
    expect(existsSync(join(repo, 'out', 't.log'))).toBe(true)
  })
})
