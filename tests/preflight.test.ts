import { describe, expect, it, vi } from 'vitest'
import { checkCapabilityCoverage, detectTestCommand, parseClaudeAuth, parseSemver, satisfiesMin } from '../src/workers/preflight'

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
    const { ProcessRegistry } = await import('../src/workers/process-registry')
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
    const { ProcessRegistry } = await import('../src/workers/process-registry')
    const registry = new ProcessRegistry(vi.fn(async () => {}))
    registry.register({ pid: 111, slot_id: 'S-1', task_id: 'T-1' })
    expect(() => registry.register({ pid: 111, slot_id: 'S-1', task_id: 'T-2' })).toThrowError(/already registered/)
  })

  it('killSlot 对不存在的槽位是安全 no-op', async () => {
    const killer = vi.fn(async () => {})
    const { ProcessRegistry } = await import('../src/workers/process-registry')
    const registry = new ProcessRegistry(killer)
    await registry.killSlot('nope')
    expect(killer).not.toHaveBeenCalled()
  })
})
