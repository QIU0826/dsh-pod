import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApplyPatch, execGitRunner } from '../src/core/apply-patch.js'
import { repairPath } from '../src/workers/preflight.js'
import type { PodStore } from '../src/core/store.js'
import type { ApprovalRequest } from '../src/core/types.js'

repairPath()

interface Fixture {
  root: string
  repo: string
  worktree: string
  branch: string
  store: PodStore
  approvals: Record<string, ApprovalRequest>
}

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'pod-patch-'))
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  writeFileSync(join(repo, 'a.txt'), 'base\n')
  writeFileSync(join(repo, '.gitattributes'), '* text=auto eol=lf\n')
  // worktree 目录建在主树内部 → 主树须忽略之，避免 status 污染
  writeFileSync(join(repo, '.gitignore'), '.pod-worktrees/\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  const worktree = join(repo, '.pod-worktrees', 'S-1')
  const branch = 'pod-S-1'
  execFileSync('git', ['-C', repo, 'worktree', 'add', worktree, '-b', branch], { stdio: 'pipe' })
  writeFileSync(join(worktree, 'a.txt'), 'base\nimplemented\n')
  execFileSync('git', ['add', '-A'], { cwd: worktree })
  execFileSync('git', ['commit', '-m', 'task-T-1: implement'], { cwd: worktree })
  const approvals: Record<string, ApprovalRequest> = {}
  const store = {
    getSlot: () => ({ worktree_path: worktree }),
    getMission: () => ({ cwd: repo, id: 'M-1' }),
    appendEvent: () => {},
    getApproval: (id: string) => approvals[id],
  } as unknown as PodStore
  return { root, repo, worktree, branch, store, approvals }
}

function approval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'A-1',
    mission_id: 'M-1',
    patch: {
      slot_id: 'S-1',
      worktree_path: '',
      base_commit: '',
      head_commit: '',
      summary: 'merge T-1',
    },
    status: 'approved',
    created_at: 0,
    decided_at: 0,
    decided_by: 'user',
    ...over,
  }
}

let fixture: Fixture

beforeEach(async () => {
  fixture = await makeFixture()
})

afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true })
})

describe('ApplyPatch（W5：审批通过 → 串行合并主树，3.7 节）', () => {
  it('approved 审批卡 → 合并 worktree 分支进主树', async () => {
    const apply = new ApplyPatch({ store: fixture.store, git: execGitRunner() })
    const card = approval({ patch: { ...approval().patch, worktree_path: fixture.worktree } })
    fixture.approvals[card.id] = card
    const result = await apply.apply('M-1', card)
    expect(result.ok).toBe(true)
    // 主树包含实现内容
    expect(readFileSync(join(fixture.repo, 'a.txt'), 'utf8')).toContain('implemented')
    expect(execFileSync('git', ['-C', fixture.repo, 'log', '--oneline']).toString()).toContain('task-T-1')
  })

  it('未批准（pending）的审批卡 → ApprovalConflictError', async () => {
    const apply = new ApplyPatch({ store: fixture.store, git: execGitRunner() })
    const card = approval({ status: 'pending' })
    fixture.approvals[card.id] = card
    await expect(apply.apply('M-1', card)).rejects.toThrowError(/APPROVAL_CONFLICT|expected approved/i)
  })

  it('主树分歧 → 冲突返回 + merge --abort（主树保持干净，不丢变更）', async () => {
    // 主树另行提交同一文件 → 冲突
    writeFileSync(join(fixture.repo, 'a.txt'), 'base\nmain-side change\n')
    execFileSync('git', ['add', '-A'], { cwd: fixture.repo })
    execFileSync('git', ['commit', '-m', 'main diverges'], { cwd: fixture.repo })
    const apply = new ApplyPatch({ store: fixture.store, git: execGitRunner() })
    const card = approval({ patch: { ...approval().patch, worktree_path: fixture.worktree } })
    fixture.approvals[card.id] = card
    const result = await apply.apply('M-1', card)
    expect(result.ok).toBe(false)
    expect((result as { conflict: boolean }).conflict).toBe(true)
    // 主树干净：merge --abort 已执行
    const status = execFileSync('git', ['-C', fixture.repo, 'status', '--porcelain']).toString()
    expect(status).toBe('')
    // 主树内容未被破坏
    expect(readFileSync(join(fixture.repo, 'a.txt'), 'utf8')).toContain('main-side change')
  })

  it('串行化：并发 apply 逐个执行（同一时刻只有一个 merge，锁重试）', async () => {
    const apply = new ApplyPatch({ store: fixture.store, git: execGitRunner() })
    const card1 = approval({ patch: { ...approval().patch, worktree_path: fixture.worktree } })
    const card2 = approval({ id: 'A-2', patch: { ...approval().patch, worktree_path: fixture.worktree } })
    fixture.approvals[card1.id] = card1
    fixture.approvals[card2.id] = card2
    const results = await Promise.all([apply.apply('M-1', card1), apply.apply('M-1', card2)])
    // 第一个成功合并；第二个因分支已合并/无新变更 → 不破坏主树（幂等或明确失败）
    expect(results.some((r) => r.ok)).toBe(true)
    const status = execFileSync('git', ['-C', fixture.repo, 'status', '--porcelain']).toString()
    expect(status).toBe('')
    expect(readFileSync(join(fixture.repo, 'a.txt'), 'utf8')).toContain('implemented')
  })

  it('不存在的审批卡 → NotFoundError', async () => {
    const apply = new ApplyPatch({ store: fixture.store, git: execGitRunner() })
    await expect(apply.apply('M-1', approval())).rejects.toThrowError(/not found/i)
  })

  it('工作树路径缺失 → 明确失败而非破坏主树', async () => {
    const apply = new ApplyPatch({ store: fixture.store, git: execGitRunner() })
    const card = approval({ patch: { ...approval().patch, worktree_path: '' } })
    fixture.approvals[card.id] = card
    const result = await apply.apply('M-1', card)
    expect(result.ok).toBe(false)
    expect((result as { conflict: boolean }).conflict).toBe(false)
    expect(existsSync(join(fixture.repo, 'a.txt'))).toBe(true)
  })
})
