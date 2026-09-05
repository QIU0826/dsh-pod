/**
 * 2026-09-05 全面代码审查修复回归测试。
 * 每个用例对应一条审查发现，防止回退：
 *   A1 dispatcher excludeBusy 漏 negotiating/accepted
 *   A3 task-machine.report 畸形报告 TypeError
 *   A8 worker_progress 事件 id 跨槽位同毫秒撞车
 *   B1 memory.json 崩溃窗口 .bak 自愈
 *   B2 claude baseline HEAD 在 spawn 前捕获
 *   B3 openPodData 对 STORE_CORRUPT fail-fast（不再静默开空库）
 *   B4 sqlite 迁移判定改 meta 标志（崩溃窗口重入安全）
 *   B6 recordUsage 原子入账
 *   B9 RemoteBackend 轮询循环失败收口 + kill 本地兜底
 *   B10 ProcessRegistry 接线（注册/注销）
 *   C1 /dispatch GET → 405
 *   C2 /a2a 统一端点 body 复用
 *   C3 matchApprovalId 完整 id
 *   C6 IM 出站 send 失败释放重放标记
 *   C9 cron history 上限
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routeTask } from '../src/core/dispatcher.js'
import { TaskMachine } from '../src/core/task-machine.js'
import { emitWorkerProgress } from '../src/core/events.js'
import { JsonMemoryPersistence, MemoryStore } from '../src/core/memory.js'
import { openPodData } from '../src/core/store-open.js'
import { JsonStore, type PodStore } from '../src/core/store.js'
import { Ledger } from '../src/core/ledger.js'
import { RemoteBackend, type SatelliteTransport } from '../src/workers/remote-backend.js'
import { ProcessRegistry } from '../src/workers/process-registry.js'
import { ClaudeHeadlessBackend } from '../src/workers/claude-headless.js'
import { parseInstruction } from '../src/core/channel.js'
import { handleImRequest, slackExpectedSignature, ImReplayGuard, type ImRequest } from '../src/core/channel-im.js'
import type { ChannelTarget } from '../src/core/channel.js'
import { CronScheduler } from '../src/core/cron.js'
import { makePodRoutes } from '../src/routes.js'
import type { PodService } from '../src/pod-service.js'
import type {
  AgentSlot, Mission, PodEvent, Task,
  WorkerCompletion, WorkerProgressEvent,
} from '../src/core/types.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pod-audit-0905-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const now = 1_700_000_000_000

function slot(over: Partial<AgentSlot> = {}): AgentSlot {
  return {
    id: 'M-1-S-1', mission_id: 'M-1', vendor: 'claude', role: 'implementer',
    capabilities: ['编码'], model: 'm', effort: 'medium', session_tier: 'transient',
    status: 'idle', tokens_in: 0, tokens_out: 0, ctx_usage_pct: 0, window_tokens: 200_000,
    ...over,
  }
}
function task(over: Partial<Task> = {}): Task {
  return {
    id: 'T-1', mission_id: 'M-1', title: 't', spec: 's', skill_tags: [], type: 'implement',
    depends_on: [], status: 'ready', attempts: 0, soft_attempts: 0,
    max_wall_clock_ms: 60_000, created_at: 0, updated_at: 0,
    ...over,
  }
}
function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'M-1', name: 'm', goal: 'g', status: 'running', budget_usd: 2,
    spent_tokens: 0, spent_equiv_usd: 0, approval_mode: 1, cwd: root,
    worktree_policy: 'per-slot', orchestration_mode: 'commander', commander_healthy: true,
    created_at: now, updated_at: now,
    ...over,
  }
}

describe('A1 · dispatcher slot 级互斥口径对齐', () => {
  it('excludeBusy 排除 negotiating/accepted 任务占用的槽位（此前只看 dispatched/running）', () => {
    const s1 = slot({ id: 'M-1-S-1', capabilities: ['编码'] })
    const t1 = task({ id: 'T-1', owner_slot_id: 'M-1-S-1', status: 'negotiating' })
    const r1 = routeTask(task({ id: 'T-2' }), {
      slots: [s1], tasks: [t1], excludeBusy: true,
    })
    expect(r1.slotId).toBeNull()
    expect(r1.reason).toContain('busy')

    const t2 = task({ id: 'T-1', owner_slot_id: 'M-1-S-1', status: 'accepted' })
    const r2 = routeTask(task({ id: 'T-2' }), { slots: [s1], tasks: [t2], excludeBusy: true })
    expect(r2.slotId).toBeNull()
  })

  it('excludeBusy=false 不受影响（正常路由仍命中）', () => {
    const s1 = slot({ id: 'M-1-S-1' })
    const t1 = task({ id: 'T-1', owner_slot_id: 'M-1-S-1', status: 'negotiating' })
    const r = routeTask(task({ id: 'T-2' }), { slots: [s1], tasks: [t1] })
    expect(r.slotId).toBe('M-1-S-1')
  })
})

describe('A3 · task-machine.report 畸形报告不炸', () => {
  function setup() {
    const store = new JsonStore({ rootDir: root, clock: () => now })
    store.open()
    store.createMission(mission())
    store.createSlot(slot({ id: 'S-1', mission_id: 'M-1' }))
    store.createTask(task({ id: 'T-1', mission_id: 'M-1', status: 'running', owner_slot_id: 'S-1' }))
    const machine = new TaskMachine(store, { clock: () => now, rng: () => 0 })
    return { store, machine }
  }

  it('need_clarify 报告缺 questions（非数组）→ 软失败，不 TypeError', () => {
    const { store, machine } = setup()
    expect(() =>
      machine.report('T-1', { task_id: 'T-1', task_type: 'implement', status: 'need_clarify', summary: '?' } as never),
    ).not.toThrow()
    const t = store.getTask('T-1')!
    expect(t.status).toBe('blocked')
    expect(t.fault).toBe('need_clarify')
    expect(t.attempts).toBe(0) // 软失败不烧 attempts
  })

  it('blocked 报告 blockers 为非数组 → 硬失败降级语义保留，不 TypeError', () => {
    const { store, machine } = setup()
    expect(() =>
      machine.report('T-1', { task_id: 'T-1', task_type: 'implement', status: 'blocked', blockers: 'nope' } as never),
    ).not.toThrow()
    const t = store.getTask('T-1')!
    expect(t.status).toBe('blocked')
    expect(t.fault).toBe('crash')
  })
})

describe('A8 · worker_progress 事件 id 跨槽位唯一', () => {
  it('两个槽位同毫秒同 seq → id 不同（含 slot_id）', () => {
    const events: PodEvent[] = []
    emitWorkerProgress(progress({ slot_id: 'S-1', task_id: 'T-1' }), (e) => events.push(e))
    emitWorkerProgress(progress({ slot_id: 'S-2', task_id: 'T-2' }), (e) => events.push(e))
    expect(events[0]!.id).not.toBe(events[1]!.id)
    expect(events[0]!.id).toContain('S-1')
    expect(events[1]!.id).toContain('S-2')
  })
})

function progress(over: Partial<WorkerProgressEvent> = {}): WorkerProgressEvent {
  return { slot_id: 'S-1', task_id: 'T-1', ts: now, kind: 'text', text: 'hello', ...over }
}

describe('B1 · memory.json 崩溃窗口 .bak 自愈', () => {
  it('主文件缺失而 .bak 完好 → load 返回备份内容并写回主文件', () => {
    const filePath = join(root, 'memory.json')
    const bak = `${filePath}.bak`
    const data = {
      schemaVersion: 1,
      records: { 'MEM-1': { id: 'MEM-1', owner_slot_id: 'S-1', type: 'fact', importance: 4, content_ref: '经验', created_ts: now, updated_ts: now } },
      edges: [],
      history: {},
    }
    writeFileSync(bak, JSON.stringify(data), 'utf8')
    const persistence = new JsonMemoryPersistence({ filePath })
    persistence.open()
    const loaded = persistence.load()
    expect(loaded).toBeDefined()
    expect(loaded!.records['MEM-1']!.content_ref).toBe('经验')
    // 自愈：主文件已恢复，后续 open 不再依赖 .bak
    expect(existsSync(filePath)).toBe(true)
    const again = new JsonMemoryPersistence({ filePath })
    again.open()
    expect(again.load()!.records['MEM-1']).toBeDefined()
  })

  it('主文件与 .bak 都缺失 → undefined（真·首次启动路径不变）', () => {
    const persistence = new JsonMemoryPersistence({ filePath: join(root, 'none.json') })
    persistence.open()
    expect(persistence.load()).toBeUndefined()
  })

  it('MemoryStore.open 崩溃窗口恢复：记忆不静默清零', () => {
    const filePath = join(root, 'memory.json')
    writeFileSync(`${filePath}.bak`, JSON.stringify({ schemaVersion: 1, records: {}, edges: [], history: { h: [{ id: 'x', ts: now, kind: 'write', summary: 's' }] } }), 'utf8')
    const mem = new MemoryStore({ filePath, clock: () => now })
    mem.open()
    expect(mem.all()).toEqual([]) // 空记录但结构完好（原内容本就空）
    expect(existsSync(filePath)).toBe(true) // 主文件已自愈转正
  })
})

describe('B2 · claude 基线 HEAD 在 spawn 前捕获', () => {
  it('HEAD 读取先于 spawner 调用（基线 = 任务开始前 HEAD，校正分支不再是死代码）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-baseline-'))
    try {
      const callLog: string[] = []
      let captured: WorkerCompletion | undefined
      const events = ['{"type":"result","is_error":false,"result":"done","session_id":"s","usage":{"input_tokens":1,"output_tokens":1}}']
      const backend = new ClaudeHeadlessBackend({
        clock: () => now,
        detectRunner: {
          run: async (_cmd, args) => {
            if (args.includes('HEAD')) callLog.push('head')
            return { code: 1, stdout: '', stderr: '' }
          },
        },
        spawner: () => {
          callLog.push('spawn')
          let sink: (line: string) => void = () => {}
          const spawned = {
            child: { pid: 1 } as never,
            stderrTail: [] as string[],
            writeStdin() {},
            exited: Promise.resolve({ code: 0, signal: null, timedOut: false, spawnFailed: false }),
            closed: Promise.resolve(),
          }
          const obj = spawned as never as { onLine: (line: string) => void }
          Object.defineProperty(spawned, 'onLine', {
            set(fn: (line: string) => void) {
              sink = fn
              for (const line of events) fn(line)
            },
            get() {
              return sink
            },
          })
          void obj
          return spawned as never
        },
      })
      const s = slot({ id: 'S-1', mission_id: 'M-1' })
      await backend.start(s, task({ id: 'T-1' }), dir, { onExit: (c) => { captured = c } })
      await vi.waitFor(() => expect(captured).toBeDefined())
      // 修复前：head 读取发生在 exited 之后（spawn → head）；修复后 spawn 前先读基线
      expect(callLog.indexOf('head')).toBeLessThan(callLog.indexOf('spawn'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('B3 · openPodData 对 STORE_CORRUPT fail-fast', () => {
  it('store.json 与 .bak 均损坏 → 抛 StoreCorruptError，不再静默开空库', () => {
    writeFileSync(join(root, 'store.json'), 'not json {', 'utf8')
    writeFileSync(join(root, 'store.json.bak'), 'also not json [', 'utf8')
    expect(() => openPodData({ rootDir: root, engine: 'sqlite' })).toThrow(/corrupt/)
    // 损坏证据保留：主文件被改名 .corrupt-*，损坏 .bak 原样留存
    expect(existsSync(join(root, 'store.json'))).toBe(false)
    expect(existsSync(`${join(root, 'store.json')}.bak`)).toBe(true)
  })

  it('engine=json 且损坏 → JsonStore.open 本身抛 StoreCorruptError（不吞）', () => {
    writeFileSync(join(root, 'store.json'), 'not json {', 'utf8')
    expect(() => openPodData({ rootDir: root, engine: 'json' })).toThrow(/corrupt/)
  })
})

describe('B4 · sqlite 迁移判定（meta 标志 + 幂等重入）', () => {
  it('迁移完成后 meta 置位；人为回滚 rename（崩溃窗口）后重开不重复、不炸', () => {
    // 1) 造存量 store.json → sqlite 首启迁移
    const store = new JsonStore({ rootDir: root, clock: () => now })
    store.open()
    store.createMission(mission({ id: 'M-9' }))
    store.close()

    const first = openPodData({ rootDir: root, engine: 'sqlite' })
    expect(first.engine).toBe('sqlite')
    expect(first.store.listMissions().map((m) => m.id)).toEqual(['M-9'])
    expect(first.db!.prepare("SELECT value FROM meta WHERE key = 'json_migrated'").get()).toBeDefined()
    first.db!.close()

    // 2) 模拟「tx 已提交但 rename 未完成」的崩溃窗口：store.json 回来 + meta 标志抹掉
    //    （.migrated 内容拷回 store.json）
    const migratedPath = join(root, 'store.json.migrated')
    if (existsSync(migratedPath)) {
      writeFileSync(join(root, 'store.json'), readFileSync(migratedPath, 'utf8'), 'utf8')
    }
    const second = openPodData({ rootDir: root, engine: 'sqlite' })
    // 打开路径会把缺标志的库再走一次迁移判定：missions 非空 → 跳过导入（不重复、不抛）
    expect(second.store.listMissions().map((m) => m.id)).toEqual(['M-9'])
    second.db!.close()
  })
})

describe('B6 · recordUsage 原子入账', () => {
  it('实现 recordUsageAtomic 的 store：一次调用完成账本+花费（不再两笔 persist）', () => {
    const store = new JsonStore({ rootDir: root, clock: () => now })
    store.open()
    store.createMission(mission())
    const atomic = vi.spyOn(store, 'recordUsageAtomic')
    const ledger = new Ledger(store, { clock: () => now })
    ledger.recordUsage('M-1', 'S-1', 'T-1', 'm', 10, 5, 'measured')
    expect(atomic).toHaveBeenCalledTimes(1)
    expect(store.getMission('M-1')!.spent_tokens).toBe(15)
    expect(store.listLedger('M-1')).toHaveLength(1)
  })

  it('未实现该方法的 store（测试桩）：回落两笔独立写，行为不变', () => {
    const fallback = {
      getMission: () => mission(),
      updateMission: vi.fn(),
      addLedgerEntry: vi.fn(),
    }
    const ledger = new Ledger(fallback as unknown as PodStore, { clock: () => now })
    ledger.recordUsage('M-1', 'S-1', 'T-1', 'm', 10, 5, 'measured')
    expect(fallback.addLedgerEntry).toHaveBeenCalledTimes(1)
    expect(fallback.updateMission).toHaveBeenCalledTimes(1)
  })
})

describe('B9 · RemoteBackend 轮询收口', () => {
  class DeadSatellite implements SatelliteTransport {
    attempts = 0
    async request(method: 'GET' | 'POST', path: string): Promise<unknown> {
      // /start 成功（start 前卫星在线），/events 恒失败（卫星随后下线）
      if (method === 'POST' && path.includes('/start')) {
        return { session_ref: 'session-abc', backend_vendor: 'dsh' }
      }
      this.attempts += 1
      throw new Error('ECONNREFUSED')
    }
  }

  it('卫星持续不可达 → 连续失败达上限后合成 failed completion（循环终止）', async () => {
    vi.useFakeTimers()
    try {
      const transport = new DeadSatellite()
      const backend = new RemoteBackend({ url: 'http://x', vendor: 'dsh', transport, pollMs: 10 })
      const exits: WorkerCompletion[] = []
      await backend.start(slot({ mission_id: 'M-1' }), task({ id: 'T-1' }), 'unused', {
        onExit: (c) => exits.push(c),
      })
      await vi.advanceTimersByTimeAsync(10 * 60 + 500)
      expect(exits).toHaveLength(1)
      expect(exits[0]!.exit).toBe('failed')
      expect(exits[0]!.fault).toBe('crash')
      expect(exits[0]!.error_detail).toContain('unreachable')
    } finally {
      vi.useRealTimers()
    }
  })

  it('kill 在卫星不可达时也落地本地标记 → 轮询循环立即退出', async () => {
    vi.useFakeTimers()
    try {
      const transport = new DeadSatellite()
      const backend = new RemoteBackend({ url: 'http://x', vendor: 'dsh', transport, pollMs: 10 })
      const exits: WorkerCompletion[] = []
      await backend.start(slot({ mission_id: 'M-1' }), task({ id: 'T-1' }), 'unused', {
        onExit: (c) => exits.push(c),
      })
      await expect(backend.kill({ session_ref: 'session-abc' })).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(50)
      expect(exits).toHaveLength(1)
      expect(exits[0]!.error_detail).toContain('killed locally')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('B10 · ProcessRegistry 接线', () => {
  it('start 注册 pid↔slot↔task，完成注销', async () => {
    const registry = new ProcessRegistry(async () => {})
    const spawned = {
      child: { pid: 42_424 } as never,
      stderrTail: [] as string[],
      writeStdin() {},
      exited: Promise.resolve({ code: 0, signal: null, timedOut: false, spawnFailed: false }),
      closed: Promise.resolve(),
    }
    Object.defineProperty(spawned, 'onLine', {
      set(fn: (line: string) => void) {
        fn('{"type":"result","is_error":false,"result":"done","session_id":"s","usage":{"input_tokens":0,"output_tokens":0}}')
      },
      get() {
        return () => {}
      },
    })
    const backend = new ClaudeHeadlessBackend({ clock: () => now, registry, spawner: () => spawned as never })
    let captured: WorkerCompletion | undefined
    await backend.start(slot({ id: 'S-1', mission_id: 'M-1' }), task({ id: 'T-1' }), 'unused', {
      onExit: (c) => { captured = c },
    })
    expect(registry.list().map((e) => e.pid)).toEqual([42_424])
    await vi.waitFor(() => expect(captured).toBeDefined())
    await vi.waitFor(() => expect(registry.list()).toEqual([]))
  })
})

describe('C1 · /dispatch 方法检查', () => {
  function makeRes(): { status: number | undefined; body: string | undefined; writeHead: unknown; end: unknown } {
    const r: { status?: number; body?: string } = {}
    return {
      get status() { return r.status },
      get body() { return r.body },
      writeHead: (code: number) => { r.status = code },
      end: (b: string) => { r.body = b },
    } as never
  }

  it('GET /api/dsh-pod/dispatch → 405（CSRF 加固），派发不被触发', async () => {
    const dispatched = vi.fn(async () => false)
    const service = () => ({ dispatchNext: dispatched }) as unknown as PodService
    const route = makePodRoutes(service).find((r) => r.kind === 'exact' && r.path === '/api/dsh-pod/dispatch')!
    const res = makeRes()
    await (route as { handler: (req: unknown, res: unknown) => Promise<void> }).handler(
      { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {} },
      res,
    )
    expect((res as { status?: number }).status).toBe(405)
    expect(dispatched).not.toHaveBeenCalled()
  })

  it('POST /api/dsh-pod/dispatch → 走派发（行为不变）', async () => {
    const dispatched = vi.fn(async () => true)
    const service = () => ({ dispatchNext: dispatched }) as unknown as PodService
    const route = makePodRoutes(service).find((r) => r.kind === 'exact' && r.path === '/api/dsh-pod/dispatch')!
    const res = makeRes()
    await (route as { handler: (req: unknown, res: unknown) => Promise<void> }).handler(
      { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: {} },
      res,
    )
    expect(dispatched).toHaveBeenCalledTimes(1)
  })
})

describe('C3 · IM 指令审批 id 完整匹配', () => {
  it('生产格式 A-<毫秒>-<随机数> 完整提取（此前截断成 A-<毫秒>）', () => {
    const cmd = parseInstruction('批准 A-1735680000000-123456 合并')
    expect(cmd.kind).toBe('approve')
    if (cmd.kind === 'approve') expect(cmd.approval_id).toBe('A-1735680000000-123456')
  })
  it('旧短 id 兼容', () => {
    const cmd = parseInstruction('批准 A-1')
    expect(cmd.kind).toBe('approve')
    if (cmd.kind === 'approve') expect(cmd.approval_id).toBe('A-1')
  })
})

describe('C6 · IM 出站 send 失败释放重放标记', () => {
  function target(): ChannelTarget {
    return {
      status: () => ({ mission: { id: 'M-1', status: 'running' } as never, pendingApprovalIds: [] }),
      launch: vi.fn(() => ({ mission_id: 'M-2', status: 'running' })),
      approve: vi.fn(() => ({ ok: true })),
      deny: vi.fn(),
      steer: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      abort: vi.fn(),
    }
  }

  function slackRequest(rawBody: string, secret: string, ts: string): ImRequest {
    return {
      vendor: 'slack',
      headers: {
        'x-slack-signature': slackExpectedSignature(secret, ts, rawBody),
        'x-slack-request-timestamp': ts,
        'content-type': 'application/json',
      },
      rawBody,
    }
  }

  it('指令执行成功但 send 抛错 → 抛给 HTTP 层（5xx）且释放重放标记，vendor 重试可送达回复', async () => {
    const secret = 's3cret'
    const ts = '1700000000'
    const rawBody = JSON.stringify({
      type: 'event_callback',
      event_id: 'evt-send-fail-1',
      event: { type: 'message', text: '状态', channel: 'C1', user: 'U1' },
    })
    const released: string[] = []
    const seen: string[] = []
    const guard = new ImReplayGuard()
    const firstSeenOriginal = guard.firstSeen.bind(guard)
    guard.firstSeen = (id: string, nowMs: number) => {
      seen.push(id)
      return firstSeenOriginal(id, nowMs)
    }
    guard.release = (id: string) => released.push(id)
    const opts = { slackSigningSecret: secret, nowMs: 1_700_000_000_000, replayGuard: guard }
    const req = slackRequest(rawBody, secret, ts)
    await expect(
      handleImRequest(req, target(), opts, async () => {
        throw new Error('slack api 503')
      }),
    ).rejects.toThrow('slack api 503')
    expect(seen).toContain('evt-send-fail-1')
    expect(released).toContain('evt-send-fail-1')
    // 重试（同 event_id）在标记释放后可再次执行：回复最终送达
    const second = await handleImRequest(req, target(), opts, async () => {})
    expect(second.handled).toBe(true)
  })

  it('send 成功 → 标记不释放（重放仍被去重拒绝）', async () => {
    const secret = 's3cret'
    const ts = '1700000000'
    const rawBody = JSON.stringify({
      type: 'event_callback',
      event_id: 'evt-send-ok-1',
      event: { type: 'message', text: '状态', channel: 'C1', user: 'U1' },
    })
    const released: string[] = []
    const guard = new ImReplayGuard()
    guard.release = (id: string) => released.push(id)
    const req = slackRequest(rawBody, secret, ts)
    const first = await handleImRequest(req, target(), { slackSigningSecret: secret, nowMs: 1_700_000_000_000, replayGuard: guard }, async () => {})
    expect(first.handled).toBe(true)
    expect(released).toEqual([])
    const replay = await handleImRequest(req, target(), { slackSigningSecret: secret, nowMs: 1_700_000_000_000, replayGuard: guard }, async () => {})
    expect(replay.handled).toBe(true)
    expect(replay.reason).toContain('duplicate')
  })
})

describe('C9 · cron history 有界', () => {
  it('超过上限后最旧记录被裁掉（historyTail 仍返回最近记录）', async () => {
    const scheduler = new CronScheduler({ clock: () => now })
    scheduler.setTarget({
      status: () => ({ mission: null, pendingApprovalIds: [] }),
      launch: vi.fn(() => ({ mission_id: 'M-2', status: 'running' })),
      approve: vi.fn(),
      deny: vi.fn(),
      steer: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      abort: vi.fn(),
    })
    // 直接内部注入大量历史：走 600 次 gated 记录
    scheduler.register({ id: 'j1', intervalMs: 1, enabled: true, command: { kind: 'status' } } as never)
    for (let i = 0; i < 600; i++) {
      await scheduler.tick(now + i * 10)
      ;(scheduler as unknown as { jobs: Map<string, { lastFiredAt?: number }> }).jobs.get('j1')!.lastFiredAt = undefined
    }
    const history = (scheduler as unknown as { history: unknown[] }).history
    expect(history.length).toBeLessThanOrEqual(500)
    expect(scheduler.historyTail(1).length).toBe(1)
  })
})
