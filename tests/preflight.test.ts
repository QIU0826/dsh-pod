import { describe, expect, it, vi } from 'vitest'
import { checkCapabilityCoverage, detectTestCommand, parseClaudeAuth, parseSemver, satisfiesMin } from '../src/workers/preflight.js'

describe('parseSemver / satisfiesMin', () => {
  it('解析并比较版本', () => {
    expect(satisfiesMin('2.50.0.windows.1', 2, 30, 0)).toBe(true)
    expect(satisfiesMin('2.29.9', 2, 30, 0)).toBe(false)
    expect(satisfiesMin('22.15.1', 22, 5, 0)).toBe(true)
    expect(satisfiesMin('22.4.0', 22, 5, 0)).toBe(false)
    expect(satisfiesMin('v22.15.1', 22, 5, 0)).toBe(true)
    expect(satisfiesMin('garbage', 22, 5, 0)).toBe(false)
  })
  it('解析 git --version 输出', () => {
    expect(parseSemver('git version 2.50.0.windows.1')).toEqual({ major: 2, minor: 50, patch: 0 })
  })
})

describe('parseClaudeAuth（claude auth status 实测为 JSON loggedIn）', () => {
  it('loggedIn=true → authed', () => {
    expect(parseClaudeAuth('{"loggedIn":true,"account":"x"}')).toEqual({ authed: true, account: 'x' })
  })
  it('loggedIn=false → not authed', () => {
    expect(parseClaudeAuth('{"loggedIn":false}')).toEqual({ authed: false })
  })
  it('非 JSON 输出 → 保守判未登录（fail-closed）', () => {
    expect(parseClaudeAuth('weird output')).toEqual({ authed: false })
  })
  it('空输出 → 未登录', () => {
    expect(parseClaudeAuth('')).toEqual({ authed: false })
  })
})

describe('detectTestCommand（附录 D-9：测试命令探测）', () => {
  it('package.json scripts.test 优先', () => {
    expect(detectTestCommand({ packageJson: JSON.stringify({ scripts: { test: 'vitest run' } }) })).toEqual({
      found: true,
      command: 'npm test',
      source: 'package.json#scripts.test',
    })
  })
  it('Makefile test 目标次之', () => {
    expect(detectTestCommand({ makefile: 'all:\n\techo hi\n\ntest:\n\tpytest -q' })).toEqual({
      found: true,
      command: 'make test',
      source: 'Makefile#test',
    })
  })
  it('CI workflow 再退而求其次', () => {
    expect(
      detectTestCommand({ workflow: 'jobs:\n  test:\n    steps:\n      - run: pytest --cov\n' }),
    ).toEqual({ found: true, command: 'pytest --cov', source: 'ci-workflow' })
  })
  it('全无 → found:false（reviewer 黄牌数据源）', () => {
    expect(detectTestCommand({})).toEqual({ found: false, command: undefined, source: 'none' })
  })
  it('非法 package.json 不炸', () => {
    expect(detectTestCommand({ packageJson: 'not json' }).found).toBe(false)
  })
})

describe('checkCapabilityCoverage（附录 D-10：覆盖性体检）', () => {
  it('全量覆盖 → 无缺失', () => {
    const result = checkCapabilityCoverage(['编码', '测试'], [
      { slotId: 'S-1', capabilities: ['编码', '测试'] },
    ])
    expect(result.missing).toEqual([])
  })
  it('缺口列出无人覆盖的标签（标红不硬拦）；covered=严格全覆盖', () => {
    const result = checkCapabilityCoverage(['编码', '翻译'], [
      { slotId: 'S-1', capabilities: ['编码'] },
    ])
    expect(result.missing).toEqual(['翻译'])
    expect(result.covered).toBe(false)
  })
  it('完全无覆盖 → covered:false', () => {
    const result = checkCapabilityCoverage(['编码'], [{ slotId: 'S-1', capabilities: [] }])
    expect(result.covered).toBe(false)
  })
})

describe('ProcessRegistry（进程注册表，3.2 节进程治理）', () => {
  it('注册/注销/列出', async () => {
    const killer = vi.fn(async () => {})
    const { ProcessRegistry } = await import('../src/workers/process-registry.js')
    const registry = new ProcessRegistry(killer, { clock: () => 1000 })
    registry.register({ pid: 111, slot_id: 'S-1', task_id: 'T-1' })
    registry.register({ pid: 222, slot_id: 'S-2', task_id: 'T-2' })
    expect(registry.list()).toHaveLength(2)
    registry.unregister(111)
    expect(registry.list().map((e) => e.pid)).toEqual([222])
    await registry.killSlot('S-2')
    expect(killer).toHaveBeenCalledWith(222)
    expect(registry.list()).toHaveLength(0)
  })

  it('重复注册同 pid → 拒绝（注册表是唯一事实源）', async () => {
    const { ProcessRegistry } = await import('../src/workers/process-registry.js')
    const registry = new ProcessRegistry(vi.fn(async () => {}))
    registry.register({ pid: 111, slot_id: 'S-1', task_id: 'T-1' })
    expect(() => registry.register({ pid: 111, slot_id: 'S-1', task_id: 'T-2' })).toThrowError(/already registered/)
  })

  it('killSlot 对不存在的槽位是安全 no-op', async () => {
    const killer = vi.fn(async () => {})
    const { ProcessRegistry } = await import('../src/workers/process-registry.js')
    const registry = new ProcessRegistry(killer)
    await registry.killSlot('nope')
    expect(killer).not.toHaveBeenCalled()
  })

  it('killAll / findByTask / contains / 注入时钟', async () => {
    const killer = vi.fn(async () => {})
    const { ProcessRegistry } = await import('../src/workers/process-registry.js')
    const registry = new ProcessRegistry(killer, { clock: () => 1234 })
    registry.register({ pid: 1, slot_id: 'S-1', task_id: 'T-1' })
    registry.register({ pid: 2, slot_id: 'S-1', task_id: 'T-2' })
    expect(registry.findByTask('T-2').map((e) => e.pid)).toEqual([2])
    expect(registry.findBySlot('S-1')).toHaveLength(2)
    expect(registry.contains(1)).toBe(true)
    expect(registry.list()[0]!.started_at).toBe(1234)
    expect(await registry.killAll()).toBe(2)
    expect(registry.contains(1)).toBe(false)
    expect(registry.contains(2)).toBe(false)
  })
})

/** runPreflight 主函数：fake runner 覆盖附录 D 十项检查的全部分支。 */
describe('runPreflight（fake runner，确定性）', () => {
  type Script = (cmd: string, args?: string[]) => { code: number; stdout: string; stderr: string }
  function fakeRunner(script: Script) {
    return { run: vi.fn(async (cmd: string, args?: string[]) => script(cmd, args)) }
  }

  const goodEnv = {
    nodeVersion: 'v22.15.1',
    exists: () => true,
    readFile: () => '',
    freeBytes: () => 2 * 1024 ** 3,
  }

  /** 全绿环境的 runner：git/claude/codex 均正常。 */
  function okRunner() {
    return fakeRunner((cmd, args) => {
      if (cmd === 'git' && args?.[0] === '--version') return { code: 0, stdout: 'git version 2.50.0.windows.1', stderr: '' }
      if (cmd === 'git' && args?.[0] === 'worktree') return { code: 0, stdout: '', stderr: '' }
      if (cmd === 'git') return { code: 0, stdout: '', stderr: '' }
      if (cmd === 'claude' && args?.[0] === '--version') return { code: 0, stdout: '2.1.129 (Claude Code)', stderr: '' }
      if (cmd === 'claude') return { code: 0, stdout: '{"loggedIn":true,"account":"t"}', stderr: '' }
      if (cmd === 'codex' && args?.[0] === '--version') return { code: 0, stdout: '0.42.0', stderr: '' }
      if (cmd === 'codex') return { code: 0, stdout: 'ok', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
  }

  it('全绿环境 → ok（claude 已登录、codex 探测通过、git worktree 可用）', async () => {
    const { runPreflight } = await import('../src/workers/preflight.js')
    const report = await runPreflight({ runner: okRunner(), cwd: 'C:\\repo', ...goodEnv })
    expect(report.ok).toBe(true)
    expect(report.checks.find((c) => c.id === 'claude')!.detail).toContain('t')
    expect(report.checks.find((c) => c.id === 'codex')!.status).toBe('ok')
    expect(report.checks.find((c) => c.id === 'git')!.status).toBe('ok')
  })

  it('node 版本过低 → fail', async () => {
    const { runPreflight } = await import('../src/workers/preflight.js')
    const report = await runPreflight({ runner: okRunner(), cwd: 'C:\\repo', ...goodEnv, nodeVersion: 'v18.0.0' })
    expect(report.ok).toBe(false)
    expect(report.checks.find((c) => c.id === 'node')!.status).toBe('fail')
  })

  it('git 缺失 / git 版本过低 / worktree 不可用 → fail', async () => {
    const { runPreflight } = await import('../src/workers/preflight.js')
    const noGit = await runPreflight({
      runner: fakeRunner(() => ({ code: 127, stdout: '', stderr: 'not found' })),
      cwd: 'C:\\repo',
      ...goodEnv,
    })
    expect(noGit.checks.find((c) => c.id === 'git')!.status).toBe('fail')

    const oldGit = await runPreflight({
      runner: fakeRunner((cmd) => (cmd === 'git' ? { code: 0, stdout: 'git version 2.29.9', stderr: '' } : { code: 0, stdout: '', stderr: '' })),
      cwd: 'C:\\repo',
      ...goodEnv,
    })
    expect(oldGit.checks.find((c) => c.id === 'git')!.status).toBe('fail')

    const brokenWorktree = await runPreflight({
      runner: fakeRunner((cmd, args) => {
        if (cmd === 'git' && args?.[0] === '--version') return { code: 0, stdout: 'git version 2.50.0', stderr: '' }
        if (cmd === 'git' && args?.[0] === 'worktree') return { code: 1, stdout: '', stderr: 'boom' }
        return { code: 0, stdout: '', stderr: '' }
      }),
      cwd: 'C:\\repo',
      ...goodEnv,
    })
    expect(brokenWorktree.checks.find((c) => c.id === 'git')!.status).toBe('fail')
    expect(brokenWorktree.checks.find((c) => c.id === 'git')!.detail).toContain('boom')
  })

  it('claude 未安装 / 未登录 → fail；codex 未安装 → fail（CR-01-0 如实报告）', async () => {
    const { runPreflight } = await import('../src/workers/preflight.js')
    const report = await runPreflight({
      runner: fakeRunner((cmd) => {
        if (cmd === 'git') return { code: 0, stdout: 'git version 2.50.0', stderr: '' }
        if (cmd === 'claude') return { code: 127, stdout: '', stderr: '' }
        if (cmd === 'codex') return { code: 127, stdout: '', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      }),
      cwd: 'C:\\repo',
      ...goodEnv,
    })
    expect(report.checks.find((c) => c.id === 'claude')!.status).toBe('fail')
    expect(report.checks.find((c) => c.id === 'codex')!.status).toBe('fail')
    expect(report.checks.find((c) => c.id === 'codex')!.detail).toMatch(/not installed/)

    const notAuthed = await runPreflight({
      runner: fakeRunner((cmd, args) => {
        if (cmd === 'git') return { code: 0, stdout: 'git version 2.50.0', stderr: '' }
        if (cmd === 'claude' && args?.[0] === '--version') return { code: 0, stdout: '2.1.129', stderr: '' }
        if (cmd === 'claude') return { code: 0, stdout: '{"loggedIn":false}', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      }),
      cwd: 'C:\\repo',
      ...goodEnv,
    })
    expect(notAuthed.checks.find((c) => c.id === 'claude')!.status).toBe('fail')
  })

  it('cwd 非 git 仓库 → fail；磁盘不足 → fail', async () => {
    const { runPreflight } = await import('../src/workers/preflight.js')
    const notRepo = await runPreflight({
      runner: fakeRunner((cmd, args) => {
        if (cmd === 'git' && args?.[0] === 'rev-parse') return { code: 1, stdout: '', stderr: 'not a repo' }
        return { code: 0, stdout: 'git version 2.50.0', stderr: '' }
      }),
      cwd: 'C:\\plain-dir',
      ...goodEnv,
      exists: () => false,
    })
    expect(notRepo.checks.find((c) => c.id === 'git-repo')!.status).toBe('fail')

    const noDisk = await runPreflight({
      runner: okRunner(),
      cwd: 'C:\\repo',
      ...goodEnv,
      freeBytes: () => 0.5 * 1024 ** 3,
    })
    expect(noDisk.checks.find((c) => c.id === 'disk')!.status).toBe('fail')
  })

  it('.gitattributes 缺 eol=lf → warn；测试命令探测不到 → warn（黄牌不硬拦）', async () => {
    const { runPreflight } = await import('../src/workers/preflight.js')
    const report = await runPreflight({
      runner: okRunner(),
      cwd: 'C:\\repo',
      nodeVersion: 'v22.15.1',
      exists: () => true,
      readFile: () => undefined,
      freeBytes: () => 2 * 1024 ** 3,
    })
    expect(report.checks.find((c) => c.id === 'crlf')!.status).toBe('warn')
    expect(report.checks.find((c) => c.id === 'test-command')!.status).toBe('warn')
  })

  it('disk statfs 异常 → 默认 0 字节 → fail（不抛出）', async () => {
    const { runPreflight } = await import('../src/workers/preflight.js')
    const report = await runPreflight({
      runner: okRunner(),
      cwd: 'C:\\repo',
      ...goodEnv,
      freeBytes: () => {
        throw new Error('no statfs')
      },
    })
    expect(report.checks.find((c) => c.id === 'disk')!.status).toBe('fail')
  })
})
