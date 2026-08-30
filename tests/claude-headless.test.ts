import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildTaskPrompt,
  classifyClaudeExit,
  extractReport,
  extractUsage,
  parseStreamJsonLine,
  resultErrorInfo,
  streamJsonToProgress,
} from '../src/workers/claude-headless.js'
import { buildClaudeArgs, ClaudeHeadlessBackend } from '../src/workers/claude-headless.js'
import { classifyFault } from '../src/core/task-machine.js'
import type { MissionReport, Task } from '../src/core/types.js'

const now = 1_700_000_000_000

function makeTask(): Task {
  return {
    id: 'T-3',
    mission_id: 'M-1',
    title: '实现 rate limiter',
    spec: '实现 RFC-12 的 rate limiter 中间件',
    skill_tags: ['编码'],
    type: 'implement',
    depends_on: [],
    status: 'running',
    attempts: 0,
    soft_attempts: 0,
    max_wall_clock_ms: 3600_000,
    created_at: now,
    updated_at: now,
  }
}

describe('parseStreamJsonLine（容错解析）', () => {
  it('解析合法 JSON 事件', () => {
    expect(parseStreamJsonLine('{"type":"system","subtype":"init"}')).toEqual({ type: 'system', subtype: 'init' })
  })
  it('容忍 BOM 前缀', () => {
    expect(parseStreamJsonLine('\uFEFF{"type":"system"}')).toEqual({ type: 'system' })
  })
  it('非 JSON 行 → undefined（不抛出：stderr 混入/日志行）', () => {
    expect(parseStreamJsonLine('error: some noise')).toBeUndefined()
    expect(parseStreamJsonLine('')).toBeUndefined()
  })
})

describe('streamJsonToProgress（stream-json 事件 → Canvas 进度事件）', () => {
  it('assistant 文本 → text 进度（partial messages 增量）', () => {
    const event = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '我先看下现有代码' }] },
    }
    expect(streamJsonToProgress('S-1', 'T-3', event, 1_700_000_000_001)).toEqual({
      slot_id: 'S-1',
      task_id: 'T-3',
      ts: 1_700_000_000_001,
      kind: 'text',
      text: '我先看下现有代码',
    })
  })
  it('tool_use → tool_call 进度', () => {
    const event = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
    }
    const progress = streamJsonToProgress('S-1', 'T-3', event, 1_700_000_000_001)
    expect(progress?.kind).toBe('tool_call')
    expect(progress?.tool).toBe('Bash')
  })
  it('非 assistant 事件（system/user/result）→ undefined', () => {
    expect(streamJsonToProgress('S-1', 'T-3', { type: 'system' }, 1)).toBeUndefined()
    expect(streamJsonToProgress('S-1', 'T-3', { type: 'result', usage: {} }, 1)).toBeUndefined()
  })
})

describe('extractUsage（result 事件 → usage，CR-01-5 实测来源）', () => {
  it('result.usage → measured', () => {
    expect(extractUsage({ type: 'result', usage: { input_tokens: 100, output_tokens: 20 } })).toEqual({
      tokens_in: 100,
      tokens_out: 20,
      source: 'measured',
    })
  })
  it('无 usage → undefined', () => {
    expect(extractUsage({ type: 'result' })).toBeUndefined()
  })
})

describe('extractReport（MISSION_REPORT JSON 提取）', () => {
  const reportText = `完成了实现。
\`\`\`json
{
  "task_id": "T-3",
  "task_type": "implement",
  "status": "done",
  "summary": "实现 rate limiter",
  "files_changed": ["src/middleware/rate-limit.ts"],
  "commit_sha": "f0e1d2c3",
  "test_command": "npm test",
  "test_result": "pass",
  "test_evidence": "12/12 ✓（输出路径 out/task-T-3.testlog）",
  "decisions": [],
  "blockers": [],
  "questions": []
}
\`\`\``

  it('从最终文本提取围栏 JSON 报告', () => {
    const report = extractReport(reportText)
    expect(report?.task_id).toBe('T-3')
    expect(report?.status).toBe('done')
    expect(report?.commit_sha).toBe('f0e1d2c3')
  })
  it('无报告 → undefined（fail-plausible 检测的数据源）', () => {
    expect(extractReport('I did the thing, all good!')).toBeUndefined()
  })
  it('容忍不带围栏的裸 JSON', () => {
    const report = extractReport('OK。{"task_id":"T-3","status":"blocked","blockers":["x"],"questions":[],"summary":"s","files_changed":[],"test_result":"not_run","task_type":"implement","decisions":[]}')
    expect(report?.status).toBe('blocked')
  })
})

describe('classifyClaudeExit（退出码 → 故障分类，3.4 节故障表）', () => {
  it('0 → null（成功）', () => {
    expect(classifyClaudeExit(0, null, false)).toBeNull()
  })
  it('非零 → crash', () => {
    expect(classifyClaudeExit(1, null, false)).toBe('crash')
  })
  it('超时杀 → 由调用方按 idle/wall-clock 显式给，不猜', () => {
    expect(classifyClaudeExit(null, 'SIGKILL', true)).toBeNull()
  })
  it('与 classifyFault 的 429/凭据特征兼容', () => {
    expect(classifyFault({ exit: 'failed', exitCode: 1, stderrTail: '429 Too Many Requests' })).toBe('rate_limited')
  })
})

describe('buildTaskPrompt（任务简报 + charter 纪律 + 报告 schema）', () => {
  const charter = `你是 Implementer。规则：\n1. 只处理分配给你的任务。\n2. 完成后 commit（message 含 task-<id>）并输出 MISSION_REPORT。`

  it('包含任务 id、spec、验收与 commit 纪律、工作目录约束', () => {
    const prompt = buildTaskPrompt({
      task: makeTask(),
      charterText: charter,
      worktreePath: 'C:\\repo\\.worktrees\\S-1',
    })
    expect(prompt).toContain('T-3')
    expect(prompt).toContain('rate limiter')
    expect(prompt).toContain('task-T-3')
    expect(prompt).toContain('C:\\repo\\.worktrees\\S-1')
    expect(prompt).toContain('MISSION_REPORT')
    expect(prompt).toContain('commit_sha')
  })

  it('附交接 payload 时注入四件套（queue 投递的任务前缀）', () => {
    const prompt = buildTaskPrompt({
      task: makeTask(),
      charterText: charter,
      worktreePath: 'X',
      handoff: {
        from: 'S-1',
        intent: { brief: 'brief', constraints: [], acceptance: 'acc' },
        artifacts: { spec: 'mission/plan.md#t-3', context_files: ['docs/rfc.md'] },
        state: { tried: [], blockers: [] },
        expected_output: 'commit + diff + report',
        verify: ['commit_exists'],
      },
    })
    expect(prompt).toContain('mission/plan.md#t-3')
    expect(prompt).toContain('docs/rfc.md')
    expect(prompt).toContain('brief')
  })

  it('review 任务提示刻意排除实现者叙事（审查者最小上下文，DoD-5）', () => {
    const reviewTask = makeTask()
    reviewTask.type = 'review'
    reviewTask.id = 'T-4'
    const prompt = buildTaskPrompt({ task: reviewTask, charterText: charter, worktreePath: 'X' })
    expect(prompt).toContain('审查任务')
    expect(prompt).toContain('最小上下文')
    expect(prompt).toContain('刻意排除实现者推理叙事')
  })
})

describe('真实夹具验证（W1 本机实证输出，tests/fixtures/claude-w1/）', () => {
  it('404 模型错误 fixture：result.is_error 优先于退出码 → auth_expired 分类（不重试）', () => {
    const lines = readFileSync(join('tests', 'fixtures', 'claude-w1', 'run1.jsonl'), 'utf8').split('\n')
    const events = lines.map(parseStreamJsonLine).filter((e) => e !== undefined)
    const result = events.reverse().find((e) => e?.type === 'result')
    expect(result).toBeDefined()
    const info = resultErrorInfo(result!)
    expect(info.isError).toBe(true)
    expect(info.apiStatus).toBe(404)
    // 实测 CLI 退出码 1，但分类必须看 result 事件面（静默假成功对策）
    expect(classifyClaudeExit(0, null, false, result)).toBe('auth_expired')
    expect(classifyClaudeExit(1, null, false, result)).toBe('auth_expired')
  })

  it('404 fixture 中 usage 与 session_id 均可提取（session 持久化数据源）', () => {
    const lines = readFileSync(join('tests', 'fixtures', 'claude-w1', 'run1.jsonl'), 'utf8').split('\n')
    const events = lines.map(parseStreamJsonLine).filter((e) => e !== undefined)
    const result = events.find((e) => e?.type === 'result')!
    expect(extractUsage(result)?.source).toBe('measured')
    expect(result.session_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('成功夹具 run4-deepseek：POD-OK + 实测 usage（CR-02-6 解除后的打通证据）', () => {
    const lines = readFileSync(join('tests', 'fixtures', 'claude-w1', 'run4-deepseek.jsonl'), 'utf8').split('\n')
    const events = lines.map(parseStreamJsonLine).filter((e) => e !== undefined)
    const result = events.find((e) => e?.type === 'result')!
    expect(resultErrorInfo(result).isError).toBe(false)
    expect(result.result).toBe('POD-OK')
    const usage = extractUsage(result)!
    expect(usage.source).toBe('measured')
    expect(usage.tokens_out).toBeGreaterThan(0)
    expect(classifyClaudeExit(0, null, false, result)).toBeNull()
  })

  it('会话连续性夹具：--session-id 与 -r 同 session_id + 跨进程召回 ALPHA-77', () => {
    const plant = readFileSync(join('tests', 'fixtures', 'claude-w1', 'plant-session.jsonl'), 'utf8')
      .split('\n')
      .map(parseStreamJsonLine)
      .find((e) => e?.type === 'result') as Record<string, unknown>
    const recall = readFileSync(join('tests', 'fixtures', 'claude-w1', 'recall-session.jsonl'), 'utf8')
      .split('\n')
      .map(parseStreamJsonLine)
      .find((e) => e?.type === 'result') as Record<string, unknown>
    expect(plant.session_id).toBe(recall.session_id)
    expect(plant.result).toBe('OK')
    expect(recall.result).toBe('ALPHA-77')
  })
})

describe('ClaudeHeadlessBackend.start（FakeSpawner 集成）', () => {
  const now = 1_700_000_000_000
  const slot = {
    id: 'S-1', mission_id: 'M-1', vendor: 'claude' as const, role: 'implementer',
    capabilities: ['编码'], model: '', effort: 'medium' as const, session_tier: 'per-mission' as const,
    status: 'idle' as const, tokens_in: 0, tokens_out: 0, ctx_usage_pct: 0, window_tokens: 200_000,
  }

  it('参数组装：stream-json/verbose/permission-mode bypassPermissions；档位 B 首派 --session-id；prompt 走 stdin', async () => {
    const captured: string[][] = []
    let stdinText = ''
    const backend = new ClaudeHeadlessBackend({
      clock: () => now,
      spawner: (_cmd, args) => {
        captured.push(args)
        return {
          child: { pid: 999 } as never,
          stderrTail: [],
          onLine() {},
          writeStdin: (text: string) => {
            stdinText = text
          },
          exited: Promise.resolve({ code: 0, signal: null, timedOut: false }),
        }
      },
    })
    await backend.start(slot, makeTask(), 'C:\\repo\\.worktrees\\S-1', {
      onProgress: vi.fn(),
      onExit: vi.fn(),
    })
    const args = captured[0]!
    expect(args[0]).toBe('-p')
    // prompt 不进 argv（Windows 引号/长度专项）
    expect(args.some((a) => a.includes('MISSION_REPORT'))).toBe(false)
    expect(args).toContain('--output-format')
    expect(args).toContain('--include-partial-messages')
    expect(args).toContain('--permission-mode')
    expect(args).toContain('bypassPermissions')
    expect(args).toContain('--session-id')
    // prompt 经 stdin 投递
    expect(stdinText).toContain('T-3')
    expect(stdinText).toContain('MISSION_REPORT')
  })

  it('envForSlot 进程级覆盖（ccswitch 共存方案，CR-03：不改全局 settings.json）', async () => {
    const capturedEnv: Array<Record<string, string> | undefined> = []
    const backend = new ClaudeHeadlessBackend({
      clock: () => now,
      envForSlot: (slot): Record<string, string> =>
        slot.id === 'S-1'
          ? { ANTHROPIC_MODEL: 'deepseek-v4-flash', ANTHROPIC_BASE_URL: 'https://alt.example/v1' }
          : {},
      spawner: (cmd, args, options) => {
        capturedEnv.push(options.env)
        void cmd
        void args
        return {
          child: { pid: 999 } as never,
          stderrTail: [],
          onLine() {},
          writeStdin() {},
          exited: Promise.resolve({ code: 0, signal: null, timedOut: false }),
        }
      },
    })
    await backend.start(slot, makeTask(), 'W')
    expect(capturedEnv[0]!).toEqual(expect.objectContaining({ ANTHROPIC_MODEL: 'deepseek-v4-flash' }))
    expect(capturedEnv[0]!).toEqual(expect.objectContaining({ ANTHROPIC_BASE_URL: 'https://alt.example/v1' }))
  })

  it('result 事件流 → 完成信号 + usage + 报告解析（fake 流回放）', async () => {    const events = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"开始实现"}]}}',
      '{"type":"result","is_error":false,"result":"完成。```json{\\"task_id\\":\\"T-3\\",\\"task_type\\":\\"implement\\",\\"status\\":\\"done\\",\\"summary\\":\\"s\\",\\"files_changed\\":[\\"a.ts\\"],\\"commit_sha\\":\\"abc\\",\\"test_command\\":\\"npm test\\",\\"test_result\\":\\"not_run\\",\\"decisions\\":[],\\"blockers\\":[],\\"questions\\":[]}```","session_id":"sess-1","usage":{"input_tokens":10,"output_tokens":5}}',
    ]
    const progress: string[] = []
    let exitCompletion: unknown
    const backend = new ClaudeHeadlessBackend({
      clock: () => now,
      spawner: () => {
        let sink: (line: string) => void = () => {}
        const spawned = {
          child: { pid: 999 } as never,
          stderrTail: [],
          onLine: (line: string) => {
            sink(line)
          },
          writeStdin() {},
          exited: Promise.resolve({ code: 0, signal: null, timedOut: false }),
        }
        // collect() 会重新赋值 onLine：用 setter 截获后回放事件流（模拟真实 spawn 的 data 事件）
        Object.defineProperty(spawned, 'onLine', {
          set(fn: (line: string) => void) {
            sink = fn
            for (const line of events) fn(line)
          },
          get() {
            return sink
          },
        })
        return spawned
      },
    })
    const handle = await backend.start(slot, makeTask(), 'W', {
      onProgress: (e) => {
        progress.push(e.kind)
      },
      onExit: (c) => {
        exitCompletion = c
      },
    })
    expect(handle.pid).toBe(999)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(handle.session_ref).toBe('sess-1')
    expect(progress).toEqual(['text'])
    const completion = exitCompletion as { exit: string; usage: { tokens_in: number; tokens_out: number }; report?: MissionReport }
    expect(completion.exit).toBe('done')
    expect(completion.usage.tokens_in).toBe(10)
    expect(completion.report?.commit_sha).toBe('abc')
  })
})

describe('spawn 失败路径（P0：error 监听防宿主崩溃 + 不误判 done）', () => {
  it('spawnFailed=true → completion failed + fault crash（而非 code=null 掉进 done 分支）', async () => {
    const slot = {
      id: 'S-1', mission_id: 'M-1', vendor: 'claude' as const, role: 'implementer',
      capabilities: ['编码'], model: '', effort: 'medium' as const, session_tier: 'per-mission' as const,
      status: 'idle' as const, tokens_in: 0, tokens_out: 0, ctx_usage_pct: 0, window_tokens: 200_000,
    }
    let captured: import('../src/core/types.js').WorkerCompletion | undefined
    const backend = new ClaudeHeadlessBackend({
      clock: () => 1_700_000_000_000,
      spawner: () => ({
        child: { pid: 999 } as never,
        stderrTail: [],
        onLine() {},
        writeStdin() {},
        exited: Promise.resolve({ code: null, signal: null, timedOut: false, spawnFailed: true }),
      }),
    })
    await backend.start(slot, makeTask(), 'W', {
      onExit: (completion) => {
        captured = completion
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(captured).toBeDefined()
    expect(captured!.exit).toBe('failed')
    expect(captured!.fault).toBe('crash')
  })
})

describe('buildClaudeArgs 注入面收口（P1：--model/--resume/--session-id 为动态值）', () => {
  it('model/sessionRef/newSessionId 含 cmd 元字符 → 拒绝', () => {
    expect(() => buildClaudeArgs({ prompt: 'p', cwd: 'C:\w', sessionTier: 'transient', model: 'm&calc' })).toThrow(/unsafe argv/)
    expect(() => buildClaudeArgs({ prompt: 'p', cwd: 'C:\w', sessionTier: 'per-mission', sessionRef: 's|id' })).toThrow(/unsafe argv/)
    expect(() => buildClaudeArgs({ prompt: 'p', cwd: 'C:\w', sessionTier: 'per-mission', newSessionId: '%PATH%' })).toThrow(/unsafe argv/)
    expect(() => buildClaudeArgs({ prompt: 'p', cwd: 'C:\w', sessionTier: 'transient', model: 'deepseek-v4-pro' })).not.toThrow()
  })
})
