import { describe, expect, it, vi } from 'vitest'
import {
  codexBinaryCandidates,
  codexJsonlToProgress,
  extractCodexThreadId,
  extractCodexUsage,
  parseCodexJsonlLine,
  resolveCodexMode,
  buildCodexArgs,
} from '../src/workers/codex-headless.js'
import { CodexHeadlessBackend } from '../src/workers/codex-headless.js'
import type { AgentSlot, WorkerCompletion } from '../src/core/types.js'

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

  it('detect：login 状态在 stderr（非 TTY 实证）→ 合并两路仍判已登录（回归：双 harness E2E 2026-09-01）', async () => {
    const backend = new CodexHeadlessBackend({
      detectRunner: {
        run: async (_cmd, args) => {
          if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.148.0-alpha.9', stderr: '' }
          return { code: 0, stdout: '', stderr: 'Logged in using an API key - sk-****' }
        },
      },
    })
    const detected = await backend.detect()
    expect(detected.authed).toBe(true) // 旧实现只测 stdout → 误判未登录
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
          stderrTail: [],
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
          stderrTail: [],
        exited: Promise.resolve({ code: 0, signal: null, timedOut: false }),
        }
      },
    })
    const persistent: AgentSlot = { ...slot, session_tier: 'per-mission', session_ref: 'thread-9' }
    await backend.start(persistent, task, 'W')
    const args = captured[0]!
    // 沙箱不降级（审计 P2-4）：resume 同样锚定 -C worktree + -s read-only
    expect(args).toEqual(['exec', 'resume', '--json', '-C', 'W', '-s', 'read-only', 'thread-9', '-'])
    expect(stdinText).toContain('T-1')
  })

  it('kill 无 pid 的 handle 是安全 no-op', async () => {
    const backend = new CodexHeadlessBackend({
      spawner: () => ({
        kill: () => {},
        onLine() {},
        writeStdin() {},
        stderrTail: [],
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

describe('codex 纯函数补充分支（2026-09-05 覆盖加固）', () => {
  it('parseCodexJsonlLine：BOM 前缀可解析 / 坏 JSON → undefined', () => {
    expect(parseCodexJsonlLine('\uFEFF{"type":"turn.started"}')).toEqual({ type: 'turn.started' })
    expect(parseCodexJsonlLine('{"type":')).toBeUndefined()
  })
  it('extractCodexThreadId：thread_id 非字符串 → undefined', () => {
    expect(extractCodexThreadId({ type: 'thread.started', thread_id: 42 })).toBeUndefined()
  })
  it('codexJsonlToProgress：function_call → tool_call / error → system / 其他 item → undefined', () => {
    const base = { slot_id: 'S-1', task_id: 'T-1', ts: 1 }
    expect(codexJsonlToProgress('S-1', 'T-1', { type: 'item.completed', item: { type: 'function_call', name: 'shell' } }, 1)).toEqual({
      ...base, kind: 'tool_call', tool: 'shell',
    })
    expect(codexJsonlToProgress('S-1', 'T-1', { type: 'item.completed', item: { type: 'command', name: 'ls' } }, 1)).toEqual({
      ...base, kind: 'tool_call', tool: 'ls',
    })
    expect(codexJsonlToProgress('S-1', 'T-1', { type: 'item.completed', item: { type: 'error', message: 'boom' } }, 1)).toEqual({
      ...base, kind: 'system', text: 'boom',
    })
    expect(codexJsonlToProgress('S-1', 'T-1', { type: 'item.completed', item: { type: 'other' } }, 1)).toBeUndefined()
    expect(codexJsonlToProgress('S-1', 'T-1', { type: 'turn.completed' }, 1)).toBeUndefined()
  })
  it('codexBinaryCandidates：POSIX 只有 PATH 候选；win32 含 .sandbox-bin 兜底', () => {
    expect(codexBinaryCandidates('linux')).toEqual(['codex'])
    const win = codexBinaryCandidates('win32')
    expect(win[0]).toBe('codex')
    expect(win[1]).toContain('.sandbox-bin')
  })
  it('resolveCodexMode：per-mission + thread → resume；transient / 无 thread → new-thread', () => {
    expect(resolveCodexMode(makeSlot('per-mission', 'th-1'))).toEqual({ kind: 'resume', threadId: 'th-1' })
    expect(resolveCodexMode(makeSlot('transient'))).toEqual({ kind: 'new-thread' })
    expect(resolveCodexMode(makeSlot('per-mission'))).toEqual({ kind: 'new-thread' })
  })
  it('buildCodexArgs：resume 保持 -s read-only 不降级沙箱（审计 P2-4）', () => {
    const args = buildCodexArgs({ kind: 'resume', threadId: 'th-9' }, 'C:/repo')
    expect(args).toContain('resume')
    expect(args).toContain('read-only')
    expect(args).toContain('th-9')
  })
})

describe('真实子进程链（2026-09-05 覆盖加固：StringDecoder 跨块重组 + close 残尾冲刷）', () => {
  it('真 spawn：CJK 字符跨 stdout 块边界被 decoder 正确重组；末行无换行经 close 冲刷不丢', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'pod-codex-fixture-'))
    try {
      const fixtureLines = [
        'if (process.argv.includes(\'--version\')) { console.log(\'codex 0.148.0-fixture\'); process.exit(0) }',
        'const report = {task_id:\'T-1\',task_type:\'implement\',status:\'done\',summary:\'完成 中文摘要\',files_changed:[],test_result:\'not_run\',decisions:[],blockers:[],questions:[]}',
        'const fenced = \'```json\\n\' + JSON.stringify(report) + \'\\n```\'',
        'const buf = Buffer.from(JSON.stringify({type:\'item.completed\',item:{type:\'agent_message\',text:fenced}}) + \'\\n\', \'utf8\')',
        'const cjkStart = buf.indexOf(Buffer.from(\'完\', \'utf8\'))',
        'process.stdout.write(\'{"type":"thread.started","thread_id":"th-e2e"}\\n\')',
        'process.stdout.write(buf.subarray(0, cjkStart + 1))',
        'setTimeout(() => {',
        '  process.stdout.write(buf.subarray(cjkStart + 1))',
        '  process.stdout.write(Buffer.from(JSON.stringify({ type: \'turn.completed\', usage: { input_tokens: 7, output_tokens: 3 } }), \'utf8\'))',
        '  process.stdout.end(\'\', () => process.exit(0))  // 等 pipe 写回调再退出：Linux 上 process.exit 会截断未刷出的缓冲（CI 实证）',
        '}, 80)',
      ]
      // 跨平台（2026-09-05 CI 实证）：POSIX shell:false 下 binary 整串被当可执行文件名
      // （ENOENT → failed）——改为 shebang + chmod 直接执行；Windows shell:true 用 node 前缀。
      const isWin = process.platform === 'win32'
      const fixture = join(dir, 'fixture.js')
      if (isWin) {
        writeFileSync(fixture, fixtureLines.join('\n'), 'utf8')
      } else {
        writeFileSync(fixture, '#!/usr/bin/env node\n' + fixtureLines.join('\n'), 'utf8')
        chmodSync(fixture, 0o755)
      }
      const backend = new CodexHeadlessBackend({ binary: isWin ? 'node ' + fixture : fixture, clock: () => Date.now() })
      const progressTexts: Array<string | undefined> = []
      let captured: WorkerCompletion | undefined
      await backend.start(makeSlot('transient'), { id: 'T-1', mission_id: 'M-1', title: 't', spec: 's', skill_tags: [], type: 'implement', depends_on: [], status: 'ready', attempts: 0, soft_attempts: 0, max_wall_clock_ms: 60_000, created_at: 0, updated_at: 0 } as never, dir, {
        onProgress: (ev) => { if (ev.kind === 'text') progressTexts.push(ev.text) },
        onExit: (c) => { captured = c },
      })
      await vi.waitFor(() => expect(captured).toBeDefined(), { timeout: 10_000 })
      const c = captured!
      expect(c.exit).toBe('done')
      // decoder 重组：摘要里的 CJK 完好（旧实现逐块 toString 会产出 U+FFFD → 报告丢失）
      expect(c.report?.summary).toBe('完成 中文摘要')
      expect(progressTexts.some((t) => t?.includes('中文摘要'))).toBe(true)
      // close 冲刷：末行无换行的 turn.completed 仍被解析 → usage 实测入账
      expect(c.usage).toEqual({ tokens_in: 7, tokens_out: 3, source: 'measured' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
