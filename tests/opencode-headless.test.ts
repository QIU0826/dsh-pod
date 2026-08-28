import { describe, expect, it } from 'vitest'
import {
  buildOpenCodeArgs,
  extractOpenCodeSessionId,
  extractOpenCodeUsage,
  isOpenCodeStepFinish,
  opencodeBinaryCandidates,
  parseOpenCodeJsonlLine,
  resolveOpenCodeMode,
  OpenCodeHeadlessBackend,
} from '../src/workers/opencode-headless.js'
import type { AgentSlot } from '../src/core/types.js'

function makeSlot(tier: AgentSlot['session_tier'], sessionRef?: string): AgentSlot {
  return {
    id: 'S-1', mission_id: 'M-1', vendor: 'opencode', role: 'implementer',
    capabilities: ['编码'], model: 'glm/GLM-5.3-Flash', effort: 'medium', session_tier: tier,
    session_ref: sessionRef, status: 'idle', tokens_in: 0, tokens_out: 0,
    ctx_usage_pct: 0, window_tokens: 200_000,
  }
}

const REPORT = JSON.stringify({
  task_id: 'T-1', task_type: 'implement', status: 'done', summary: 's',
  files_changed: ['src/util.ts'], commit_sha: 'abc123', test_result: 'pass',
  test_evidence: '6/6', decisions: [], blockers: [], questions: [],
})

// 真机实证事件流样例（opencode 1.18.24 --format json，2026-08-28）
const REAL_EVENTS = [
  '{"type":"step_start","timestamp":1787892161484,"sessionID":"ses_fb952c"}',
  JSON.stringify({ type: 'text', timestamp: 1787892161837, sessionID: 'ses_fb952c', part: { id: 'p1', type: 'text', text: 'working... MISSION_REPORT ```json ' + REPORT + ' ```' } }),
  '{"type":"step_finish","timestamp":1787892161837,"sessionID":"ses_fb952c","part":{"type":"step-finish","tokens":{"total":38030,"input":37996,"output":34,"reasoning":0}}}',
]

describe('parseOpenCodeJsonlLine / extractOpenCodeSessionId / extractOpenCodeUsage（真机事件流契约）', () => {
  it('解析 step_start/text/step_finish；sessionID 每事件顶层', () => {
    const events = REAL_EVENTS.map(parseOpenCodeJsonlLine).filter((e) => e !== undefined)
    expect(events.length).toBe(3)
    expect(extractOpenCodeSessionId(events[0]!)).toBe('ses_fb952c')
    expect(isOpenCodeStepFinish(events[2]!)).toBe(true)
    const usage = extractOpenCodeUsage(events[2]!)
    expect(usage).toEqual({ tokens_in: 37996, tokens_out: 34, source: 'measured' })
  })
  it('非 JSON 行（日志混入）→ undefined', () => {
    expect(parseOpenCodeJsonlLine('opencode > some log line')).toBeUndefined()
  })
})

describe('resolveOpenCodeMode（会话档位）', () => {
  it('transient → new-run；per-mission+ref → resume；auto-reset → new-run', () => {
    expect(resolveOpenCodeMode(makeSlot('transient', 'old'))).toEqual({ kind: 'new-run' })
    expect(resolveOpenCodeMode(makeSlot('per-mission', 'ses-9'))).toEqual({ kind: 'resume', sessionId: 'ses-9' })
    expect(resolveOpenCodeMode(makeSlot('auto-reset', 'stale'))).toEqual({ kind: 'new-run' })
  })
})

describe('buildOpenCodeArgs（真机实证 1.18.24）', () => {
  it('run --dir worktree --format json + model；prompt 走 stdin 不进 argv（CR-02）', () => {
    const args = buildOpenCodeArgs({ kind: 'new-run' }, 'C:/repo/.wt', 'glm/GLM-5.3-Flash')
    expect(args.slice(0, 5)).toEqual(['run', '--dir', 'C:/repo/.wt', '--format', 'json'])
    expect(args).toContain('--model')
    expect(args.join(' ')).not.toContain('MISSION_REPORT')
  })
  it('resume：--session 置于末尾（stdin 注入 prompt）', () => {
    const args = buildOpenCodeArgs({ kind: 'resume', sessionId: 'ses-9' }, 'W', undefined)
    expect(args).toEqual(['run', '--dir', 'W', '--format', 'json', '--session', 'ses-9'])
  })
})

describe('opencodeBinaryCandidates（npm 全局包内 exe 兜底，实证 1.18.24 布局）', () => {
  it('win32：PATH → ~/.opencode/bin → node_modules/opencode-ai/bin', async () => {
    const { homedir } = await import('node:os')
    const { dirname, join } = await import('node:path')
    const candidates = opencodeBinaryCandidates('win32')
    expect(candidates[0]).toBe('opencode')
    expect(candidates[1]).toBe(join(homedir(), '.opencode', 'bin', 'opencode.exe'))
    expect(candidates[2]).toBe(join(dirname(process.execPath), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'))
  })
})

describe('OpenCodeHeadlessBackend（FakeSpawner 集成，回放真机事件流）', () => {
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
        let lineHandler: (line: string) => void = () => {}
        const linesToReplay = output.split('\n')
        const spawned = {
          pid: 42,
          kill: () => {},
          onLine: (line: string) => {
            lineHandler(line)
          },
          writeStdin: (text: string) => {
            stdinText = text
          },
          exited: new Promise<{ code: number | null; signal: string | null; timedOut: boolean }>((resolve) => {
            // 宏任务回放：collect 同步挂 onLine 后再喂行（模拟 stdout 异步到达）
            setTimeout(() => {
              for (const line of linesToReplay) spawned.onLine(line)
              resolve({ code, signal: null, timedOut: false })
            }, 0)
          }),
        }
        return spawned as never
      },
    })
    return { backend, captured, getStdin: () => stdinText }
  }

  it('detect：--version 过 + auth list 有 credentials → authed；未装 → 灰掉', async () => {
    const ok = new OpenCodeHeadlessBackend({
      detectRunner: {
        run: async (_cmd, args) => {
          if (args[0] === '--version') return { code: 0, stdout: '1.18.24', stderr: '' }
          return { code: 0, stdout: 'Credentials\n\n└  1 credentials', stderr: '' }
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
    expect((await missing.detect()).installed).toBe(false)
  })

  it('detect：0 credentials → authed=false 带指引（真机实证输出格式）', async () => {
    const backend = new OpenCodeHeadlessBackend({
      detectRunner: {
        run: async (_cmd, args) => {
          if (args[0] === '--version') return { code: 0, stdout: '1.18.24', stderr: '' }
          return { code: 0, stdout: '0 credentials', stderr: '' }
        },
      },
    })
    const result = await backend.detect()
    expect(result.authed).toBe(false)
    expect(result.error).toContain('auth login')
  })

  it('start：JSONL 回放 → session_ref/usage(measured)/report 全提取；stdin 注入 prompt', async () => {
    const output = REAL_EVENTS.join('\n') + '\n' + 'MISSION_REPORT\n```json\n' + REPORT + '\n```'
    const { backend, captured, getStdin } = fakeSpawn(output, 0)
    const progress: string[] = []
    let completion: { exit: string; usage: { tokens_in: number; source: string }; report?: { commit_sha?: string }; session_ref?: string } | undefined
    const handle = await backend.start(slot, task, 'W', {
      onProgress: (e) => progress.push(e.kind),
      onExit: (c) => {
        completion = c
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(getStdin()).toContain('T-1')
    const args = captured[0]!
    expect(args.slice(0, 5)).toEqual(['run', '--dir', 'W', '--format', 'json'])
    expect(progress.length).toBeGreaterThanOrEqual(1)
    expect(completion?.exit).toBe('done')
    expect(completion?.usage).toEqual({ tokens_in: 37996, tokens_out: 34, source: 'measured' })
    expect(completion?.report?.commit_sha).toBe('abc123')
    expect(handle.session_ref).toBe('ses_fb952c')
  })

  it('退出码非 0 → failed/crash（双判定：退出码 + 结构化报告）', async () => {
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
})
