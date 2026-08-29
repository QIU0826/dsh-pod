import { describe, expect, it } from 'vitest'
import {
  codexBinaryCandidates,
  extractCodexThreadId,
  extractCodexUsage,
  parseCodexJsonlLine,
  resolveCodexMode,
  buildCodexArgs,
} from '../src/workers/codex-headless.js'
import { CodexHeadlessBackend } from '../src/workers/codex-headless.js'
import type { AgentSlot } from '../src/core/types.js'

function makeSlot(tier: AgentSlot['session_tier'], sessionRef?: string): AgentSlot {
  return {
    id: 'S-1',
    mission_id: 'M-1',
    vendor: 'codex',
    role: 'implementer',
    capabilities: ['编码'],
    model: 'codex-default',
    effort: 'medium',
    session_tier: tier,
    session_ref: sessionRef,
    status: 'idle',
    tokens_in: 0,
    tokens_out: 0,
    ctx_usage_pct: 0,
    window_tokens: 200_000,
  }
}

describe('parseCodexJsonlLine（exec --json JSONL 事件流）', () => {
  it('解析 thread.started / item.completed / turn.completed', () => {
    expect(parseCodexJsonlLine('{"type":"thread.started","thread_id":"t-1"}')).toEqual({ type: 'thread.started', thread_id: 't-1' })
    expect(
      parseCodexJsonlLine('{"type":"item.completed","item":{"id":"i_2","type":"agent_message","text":"POD-OK"}}'),
    ).toEqual({ type: 'item.completed', item: { id: 'i_2', type: 'agent_message', text: 'POD-OK' } })
  })
  it('非 JSON 行（登录提示等 stderr 混入）→ undefined', () => {
    expect(parseCodexJsonlLine('Logged in using an API key')).toBeUndefined()
  })
})

describe('extractCodexThreadId（线程 id 是 resume 的钥匙）', () => {
  it('thread.started → thread_id', () => {
    expect(extractCodexThreadId({ type: 'thread.started', thread_id: 'abc' })).toBe('abc')
  })
  it('其他事件 → undefined', () => {
    expect(extractCodexThreadId({ type: 'turn.started' })).toBeUndefined()
  })
})

describe('extractCodexUsage（turn.completed.usage，CR-01-5：codex JSONL 实测带 usage）', () => {
  it('usage → measured', () => {
    expect(
      extractCodexUsage({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } }),
    ).toEqual({ tokens_in: 100, tokens_out: 20, source: 'measured' })
  })
  it('无 usage → undefined', () => {
    expect(extractCodexUsage({ type: 'turn.started' })).toBeUndefined()
  })
})

describe('resolveCodexMode（会话档位 → 启动模式；R1 降级档位 A）', () => {
  it('transient（默认档）→ 新线程（W1 实证：默认 exec 每次新 thread）', () => {
    expect(resolveCodexMode(makeSlot('transient', 'old-thread'))).toEqual({ kind: 'new-thread' })
  })
  it('per-mission + 已有 thread → resume（exec resume <thread>）', () => {
    expect(resolveCodexMode(makeSlot('per-mission', 'thread-9'))).toEqual({ kind: 'resume', threadId: 'thread-9' })
  })
  it('per-mission 但无 thread → 新线程（首次派单）', () => {
    expect(resolveCodexMode(makeSlot('per-mission', undefined))).toEqual({ kind: 'new-thread' })
  })
  it('auto-reset 档 → 新线程（重置后重建，codex 无摘要注入路径 → 等价瞬时）', () => {
    expect(resolveCodexMode(makeSlot('auto-reset', 'stale'))).toEqual({ kind: 'new-thread' })
  })
})

describe('session_tier 语义与方案书一致', () => {
  it('codex 默认 transient（O7）；claude 默认 per-mission', async () => {
    const { DEFAULT_SESSION_TIERS } = await import('../src/core/types.js')
    expect(DEFAULT_SESSION_TIERS.codex).toBe('transient')
    expect(DEFAULT_SESSION_TIERS.claude).toBe('per-mission')
  })
})

describe('真实夹具验证（W1 本机实证输出，tests/fixtures/codex-w1/）', () => {
  it('recall3.jsonl：resume 同 thread + 跨进程记忆召回 ALPHA-77 + usage 实测', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const lines = readFileSync(join('tests', 'fixtures', 'codex-w1', 'recall3.jsonl'), 'utf8').split('\n')
    const events = lines.map(parseCodexJsonlLine).filter((e) => e !== undefined)
    const thread = events.find((e) => e?.type === 'thread.started')
    expect(thread?.thread_id).toBe('01a01eac-71a4-7752-9989-44fa2b5073cc')
    const messages = events
      .filter((e) => e?.type === 'item.completed')
      .map((e) => (e as { item?: { text?: string } }).item?.text)
      .filter((t) => typeof t === 'string')
    expect(messages.some((t) => t!.includes('ALPHA-77'))).toBe(true)
    const usage = events.find((e) => extractCodexUsage(e) !== undefined)
    expect(extractCodexUsage(usage!)).toEqual(expect.objectContaining({ source: 'measured' }))
  })

  it('plant.jsonl 与 recall3.jsonl 的 thread_id 一致（resume 实证的核心证据）', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const plantThread = readFileSync(join('tests', 'fixtures', 'codex-w1', 'plant.jsonl'), 'utf8')
      .split('\n')
      .map(parseCodexJsonlLine)
      .find((e) => e?.type === 'thread.started')?.thread_id
    const recallThread = readFileSync(join('tests', 'fixtures', 'codex-w1', 'recall3.jsonl'), 'utf8')
      .split('\n')
      .map(parseCodexJsonlLine)
      .find((e) => e?.type === 'thread.started')?.thread_id
    expect(plantThread).toBeDefined()
    expect(plantThread).toBe(recallThread)
  })

  it('codexBinaryCandidates：win32 家目录沙箱二进制兜底（PATH 滞后专项）', async () => {
    const candidates = codexBinaryCandidates('win32')
    expect(candidates[0]).toBe('codex')
    expect(candidates[1]).toContain('.sandbox-bin')
  })
})

describe('CodexHeadlessBackend（FakeSpawner 集成）', () => {
  const slot: AgentSlot = {
    id: 'S-1', mission_id: 'M-1', vendor: 'codex', role: 'implementer',
    capabilities: ['编码'], model: 'codex-default', effort: 'medium', session_tier: 'transient',
    status: 'idle', tokens_in: 0, tokens_out: 0, ctx_usage_pct: 0, window_tokens: 200_000,
  }
  const task = {
    id: 'T-1', mission_id: 'M-1', title: '做限流器', spec: '实现限流', skill_tags: [],
    type: 'implement' as const, depends_on: [], status: 'running' as const, attempts: 0,
    soft_attempts: 0, max_wall_clock_ms: 3600_000, created_at: 0, updated_at: 0,
  }

  it('detect：已安装已登录 / 未安装（fake runner）', async () => {
    const ok = new CodexHeadlessBackend({
      detectRunner: {
        run: async (_cmd, args) => {
          if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.148.0-alpha.9', stderr: '' }
          return { code: 0, stdout: 'Logged in using an API key - sk-****', stderr: '' }
        },
      },
    })
    const detected = await ok.detect()
    expect(detected.installed).toBe(true)
    expect(detected.authed).toBe(true)
    expect(detected.version).toMatch(/0\.148\.0/)

    const missing = new CodexHeadlessBackend({
      detectRunner: { run: async () => ({ code: 127, stdout: '', stderr: 'not found' }) },
    })
    const result = await missing.detect()
    expect(result.installed).toBe(false)
    expect(result.session_tiers).toEqual(['transient'])
  })

  it('detect：未登录 → authed=false（Not logged in 不得误判）', async () => {
    const backend = new CodexHeadlessBackend({
      detectRunner: {
        run: async (_cmd, args) => {
          if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.148.0', stderr: '' }
          return { code: 0, stdout: 'Not logged in. Run codex login to authenticate.', stderr: '' }
        },
      },
    })
    expect((await backend.detect()).authed).toBe(false)
  })

  it('start 新线程（transient 档）：参数含 --json/-s read-only/-C worktree；流回放产出进度+usage+thread', async () => {
    const captured: string[][] = []
    const events = [
      '{"type":"thread.started","thread_id":"thread-42"}',
      '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"完成。{\\"task_id\\":\\"T-1\\",\\"task_type\\":\\"implement\\",\\"status\\":\\"done\\",\\"summary\\":\\"s\\",\\"files_changed\\":[\\"a.ts\\"],\\"commit_sha\\":\\"abc\\",\\"test_result\\":\\"not_run\\",\\"decisions\\":[],\\"blockers\\":[],\\"questions\\":[]}"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}',
    ]
    const progress: string[] = []
    let completion: { exit: string; usage: { tokens_in: number }; report?: { commit_sha?: string } } | undefined
    const backend = new CodexHeadlessBackend({
      clock: () => 1,
      spawner: (binary, args) => {
        captured.push(args)
        let sink: (line: string) => void = () => {}
        const spawned = {
          pid: 777,
          kill: () => {},
          writeStdin() {},
          exited: Promise.resolve({ code: 0, signal: null, timedOut: false }),
        }
        Object.defineProperty(spawned, 'onLine', {
          set(fn: (line: string) => void) {
            sink = fn
            for (const line of events) fn(line)
          },
          get() {
            return sink
          },
        })
        void binary
        return spawned as never
      },
    })
    const handle = await backend.start(slot, task, 'C:\\repo\\.worktrees\\S-1', {
      onProgress: (e) => progress.push(e.kind),
      onExit: (c) => {
        completion = c
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(handle.pid).toBe(777)
    expect(handle.session_ref).toBe('thread-42')
    const args = captured[0]!
    expect(args[0]).toBe('exec')
    expect(args[1]).toBe('-') // prompt 走 stdin（Windows 引号/长度专项）
    expect(args).toContain('--json')
    expect(args).toContain('--skip-git-repo-check')
    expect(args).toContain('read-only')
    expect(args).toContain('C:\\repo\\.worktrees\\S-1')
    expect(progress).toEqual(['text'])
    expect(completion?.exit).toBe('done')
    expect(completion?.usage.tokens_in).toBe(100)
    expect(completion?.report?.commit_sha).toBe('abc')
  })

  it('start resume（per-mission + session_ref）：args 为 exec resume --json <thread> -（prompt 走 stdin）', async () => {
    const captured: string[][] = []
    let stdinText = ''
    const backend = new CodexHeadlessBackend({
      clock: () => 1,
      spawner: (binary, args) => {
        captured.push(args)
        void binary
        return {
          pid: 1,
          kill: () => {},
          onLine() {},
          writeStdin: (text: string) => {
            stdinText = text
          },
          exited: Promise.resolve({ code: 0, signal: null, timedOut: false }),
        }
      },
    })
    const persistent: AgentSlot = { ...slot, session_tier: 'per-mission', session_ref: 'thread-9' }
    await backend.start(persistent, task, 'W')
    const args = captured[0]!
    expect(args.slice(0, 5)).toEqual(['exec', 'resume', '--json', 'thread-9', '-'])
    expect(stdinText).toContain('T-1')
  })

  it('kill 无 pid 的 handle 是安全 no-op', async () => {
    const backend = new CodexHeadlessBackend({
      spawner: () => ({
        kill: () => {},
        onLine() {},
        writeStdin() {},
        exited: Promise.resolve({ code: 0, signal: null, timedOut: false }),
      }),
    })
    await expect(backend.kill({})).resolves.toBeUndefined()
  })
})

describe('buildCodexArgs 注入面收口（P1：win32 shell:true 下 cmd 元字符即命令注入）', () => {
  it('model 含 cmd 元字符 → 拒绝（& | ^ % < > ! 引号）', () => {
    for (const model of ['x&calc', 'a|b', 'p^wd', '%USERPROFILE%', 'a>b', 'x!y', 'mo"del', "it's"]) {
      expect(() => buildCodexArgs({ kind: 'new-thread' }, 'C:/repo/.wt', model)).toThrow(/unsafe argv/)
    }
  })
  it('worktree 含元字符 → 拒绝；合法路径（含空格）放行', () => {
    expect(() => buildCodexArgs({ kind: 'new-thread' }, 'C:/repo/.wt&calc', undefined)).toThrow(/unsafe argv path/)
    expect(() => buildCodexArgs({ kind: 'new-thread' }, 'C:/My Repo/.pod-worktrees/M-1-S-1', undefined)).not.toThrow()
  })
  it('resume threadId 走 token 白名单 → 元字符拒绝', () => {
    expect(() => buildCodexArgs({ kind: 'resume', threadId: 't1&calc' }, 'W', undefined)).toThrow(/unsafe argv/)
  })
  it('合法 model/threadId 正常组装', () => {
    expect(buildCodexArgs({ kind: 'new-thread' }, 'C:/repo/.wt', 'gpt-5.6-sol')).toContain('gpt-5.6-sol')
    expect(buildCodexArgs({ kind: 'resume', threadId: 'th_abc-123' }, 'W', undefined)).toContain('th_abc-123')
  })
})
