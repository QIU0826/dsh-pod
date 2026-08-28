import { describe, expect, it } from 'vitest'
import {
  buildOpenCodeArgs,
  extractOpenCodeReport,
  opencodeBinaryCandidates,
  resolveOpenCodeMode,
  OpenCodeHeadlessBackend,
} from '../src/workers/opencode-headless.js'
import type { AgentSlot } from '../src/core/types.js'

function makeSlot(tier: AgentSlot['session_tier'], sessionRef?: string): AgentSlot {
  return {
    id: 'S-1', mission_id: 'M-1', vendor: 'opencode', role: 'implementer',
    capabilities: ['编码'], model: 'opencode/grok-code', effort: 'medium', session_tier: tier,
    session_ref: sessionRef, status: 'idle', tokens_in: 0, tokens_out: 0,
    ctx_usage_pct: 0, window_tokens: 200_000,
  }
}

const REPORT = JSON.stringify({
  task_id: 'T-1', task_type: 'implement', status: 'done', summary: 's',
  files_changed: ['src/util.ts'], commit_sha: 'abc123', test_result: 'pass',
  test_evidence: '2/2', decisions: [], blockers: [], questions: [],
})

describe('resolveOpenCodeMode（会话档位 → 启动模式）', () => {
  it('transient（默认档）→ new-run', () => {
    expect(resolveOpenCodeMode(makeSlot('transient', 'old-session'))).toEqual({ kind: 'new-run' })
  })
  it('per-mission + 已有 session → resume（--session <id>）', () => {
    expect(resolveOpenCodeMode(makeSlot('per-mission', 'ses-9'))).toEqual({ kind: 'resume', sessionId: 'ses-9' })
  })
  it('per-mission 但无 session → new-run（首次派单）', () => {
    expect(resolveOpenCodeMode(makeSlot('per-mission', undefined))).toEqual({ kind: 'new-run' })
  })
  it('auto-reset 档 → new-run（重置后重建，等价瞬时）', () => {
    expect(resolveOpenCodeMode(makeSlot('auto-reset', 'stale'))).toEqual({ kind: 'new-run' })
  })
})

describe('buildOpenCodeArgs', () => {
  it('新会话：run + -C worktree + --model，prompt 不进 argv（stdin 注入，Windows CR-02 专项）', () => {
    const args = buildOpenCodeArgs({ kind: 'new-run' }, 'C:/repo/.wt', 'opencode/grok-code')
    expect(args[0]).toBe('run')
    expect(args).toContain('-C')
    expect(args).toContain('C:/repo/.wt')
    expect(args).toContain('--model')
    expect(args).not.toContain('实现限流')
  })
  it('resume：--session <id> 在位置参数前；model 留空 → 不传 --model（走 opencode 默认）', () => {
    const args = buildOpenCodeArgs({ kind: 'resume', sessionId: 'ses-9' }, 'W', undefined)
    expect(args).toEqual(['run', '-C', 'W', '--session', 'ses-9'])
  })
})

describe('opencodeBinaryCandidates（Windows 家目录兜底）', () => {
  it('win32：PATH 优先 + ~/.opencode/bin 兜底', async () => {
    const { homedir } = await import('node:os')
    const { join } = await import('node:path')
    const candidates = opencodeBinaryCandidates('win32')
    expect(candidates[0]).toBe('opencode')
    expect(candidates[1]).toBe(join(homedir(), '.opencode', 'bin', 'opencode.exe'))
  })
})

describe('OpenCodeHeadlessBackend（FakeSpawner 集成）', () => {
  const slot = makeSlot('transient')
  const task = {
    id: 'T-1', mission_id: 'M-1', title: '做限流器', spec: '实现限流', skill_tags: [],
    type: 'implement' as const, depends_on: [], status: 'running' as const, attempts: 0,
    soft_attempts: 0, max_wall_clock_ms: 3600_000, created_at: 0, updated_at: 0,
  }

  function fakeSpawn(output: string, code = 0) {
    const captured: string[][] = []
    let stdinText = ''
    const backend = new OpenCodeHeadlessBackend({
      clock: () => 1,
      spawner: (binary, args) => {
        captured.push(args)
        void binary
        return {
          pid: 42,
          kill: () => {},
          writeStdin: (text: string) => {
            stdinText = text
          },
          exited: Promise.resolve({ code, signal: null, timedOut: false }),
          __output: () => output,
        } as never
      },
    })
    return { backend, captured, getStdin: () => stdinText }
  }

  it('detect：已安装 + auth list 成功 → authed；未安装 → 灰掉（CR-01-0）', async () => {
    const ok = new OpenCodeHeadlessBackend({
      detectRunner: {
        run: async (_cmd, args) => {
          if (args[0] === '--version') return { code: 0, stdout: 'opencode 1.0.0', stderr: '' }
          return { code: 0, stdout: 'opencode/grok-code', stderr: '' }
        },
      },
    })
    const detected = await ok.detect()
    expect(detected.installed).toBe(true)
    expect(detected.authed).toBe(true)
    expect(detected.session_tiers).toEqual(['transient'])

    const missing = new OpenCodeHeadlessBackend({
      detectRunner: { run: async () => ({ code: 127, stdout: '', stderr: 'not found' }) },
    })
    const result = await missing.detect()
    expect(result.installed).toBe(false)
    expect(result.error).toContain('not installed')
  })

  it('detect：auth list 失败 → authed=false 带指引', async () => {
    const backend = new OpenCodeHeadlessBackend({
      detectRunner: {
        run: async (_cmd, args) => {
          if (args[0] === '--version') return { code: 0, stdout: 'opencode 1.0.0', stderr: '' }
          return { code: 1, stdout: '', stderr: 'no credentials' }
        },
      },
    })
    const result = await backend.detect()
    expect(result.authed).toBe(false)
    expect(result.error).toContain('opencode auth login')
  })

  it('start：prompt 走 stdin；纯文本输出提取 MISSION_REPORT；usage 如实 unavailable', async () => {
    const output = [' doing work...', 'MISSION_REPORT', '```json', REPORT, '```', ''].join('\n')
    const { backend, captured, getStdin } = fakeSpawn(output, 0)
    const progress: string[] = []
    let completion: { exit: string; usage: { tokens_in: number; source: string }; report?: { commit_sha?: string } } | undefined
    const handle = await backend.start(slot, task, 'W', {
      onProgress: (e) => progress.push(e.kind),
      onExit: (c) => {
        completion = c
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(handle.pid).toBe(42)
    expect(getStdin()).toContain('T-1')
    expect(getStdin()).toContain('MISSION_REPORT')
    const args = captured[0]!
    expect(args[0]).toBe('run')
    expect(args).toContain('--model')
    expect(progress).toEqual(['system', 'text'])
    expect(completion?.exit).toBe('done')
    expect(completion?.usage).toEqual({ tokens_in: 0, tokens_out: 0, source: 'unavailable' })
    expect(completion?.report?.commit_sha).toBe('abc123')
  })

  it('退出码非 0 → failed/crash（完成信号 = 退出码 + 结构化报告双判定）', async () => {
    const { backend } = fakeSpawn('boom', 1)
    let completion: { exit: string; fault?: string } | undefined
    await backend.start(slot, task, 'W', { onExit: (c) => { completion = c } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completion?.exit).toBe('failed')
    expect(completion?.fault).toBe('crash')
  })

  it('kill 无 pid 的 handle 是安全 no-op', async () => {
    const backend = new OpenCodeHeadlessBackend({
      spawner: () => ({ kill: () => {}, writeStdin() {}, exited: Promise.resolve({ code: 0, signal: null, timedOut: false }), __output: () => '' } as never),
    })
    await expect(backend.kill({})).resolves.toBeUndefined()
  })

  it('extractOpenCodeReport：围栏 JSON 提取复用 claude 的平衡扫描', () => {
    expect(extractOpenCodeReport('前言\n```json\n' + REPORT + '\n```')?.commit_sha).toBe('abc123')
    expect(extractOpenCodeReport('无报告')).toBeUndefined()
  })
})

describe('session_tier 语义与方案书一致', () => {
  it('opencode 默认 transient（新增 vendor 档位登记）', async () => {
    const { DEFAULT_SESSION_TIERS } = await import('../src/core/types.js')
    expect(DEFAULT_SESSION_TIERS.opencode).toBe('transient')
  })
})
