import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CELL,
  COLUMNS,
  ROW_FRAMES,
  animationForPhase,
  framePosition,
  initialSequenceState,
  advanceSequence,
  type PetAnimation,
  type PetPhase,
} from '../src/web/pet-sprite.js'
import { slotPhase, latestProgressByTask, PetRoomView, zoneOf } from '../src/web/pet-room.js'
import type { PodEvent, StatusResponse, StatusSlot, StatusTask } from '../src/web/api.js'

/**
 * 桌宠房间（学习 dsh-web/dsh-pet，2026-09-02）契约测试：
 * 1. atlas 帧定位（framePosition）——8 列 × 9 行 cell 192×208；
 * 2. phase→animation 映射（animationForPhase）——harness 语义 → 9 轨动画；
 * 3. 序列推进（advanceSequence）——track 轮换 + 帧推进（防死循环）；
 * 4. slot→phase 映射（slotPhase）——harness 工作状态 → 桌宠动作；
 * 5. 事件流进度提取（latestProgressByTask）——气泡内容。
 */

// ─── fixture ────────────────────────────────────────────────────────────────

function slot(over: Partial<StatusSlot> = {}): StatusSlot {
  return { id: 'S-1', role: 'implementer', vendor: 'claude', status: 'idle', ctx_usage_pct: 0, ...over }
}

function task(over: Partial<StatusTask> = {}): StatusTask {
  return {
    id: 'T-1',
    title: '写 clampInt',
    type: 'implement',
    status: 'running',
    fault: null,
    attempts: 0,
    owner: 'S-1',
    commit: null,
    depends_on: [],
    ...over,
  }
}

// ─── 1. atlas 帧定位 ────────────────────────────────────────────────────────

describe('图集帧定位（framePosition）', () => {
  it('cell 契约为 192×208、8 列、9 行', () => {
    expect(CELL.width).toBe(192)
    expect(CELL.height).toBe(208)
    expect(COLUMNS).toBe(8)
    expect(ROW_FRAMES.length).toBe(9)
  })

  it('首帧 idle（row 0 col 0）位置为 0,0', () => {
    expect(framePosition('idle', 0, 1)).toEqual({ x: -0, y: -0 })
  })

  it('running-right（row 1）第 1 帧偏移 -192,-208', () => {
    expect(framePosition('running-right', 1, 1)).toEqual({ x: -192, y: -208 })
  })

  it('scale 放大等比缩放偏移', () => {
    expect(framePosition('review', 2, 0.5)).toEqual({ x: -192, y: -832 })
  })
})

// ─── 2. phase→animation 映射 ────────────────────────────────────────────────

describe('phase→animation 映射（animationForPhase）', () => {
  it('全部 phase 都映射到合法动画轨', () => {
    const phases: PetPhase[] = ['idle', 'thinking', 'tool', 'review', 'waiting', 'done', 'failed']
    const valid: PetAnimation[] = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review']
    for (const p of phases) {
      expect(valid, `phase ${p} 应映射到合法动画轨`).toContain(animationForPhase(p))
    }
  })

  it('关键语义映射：thinking→跑动 / tool→右跑 / review→翻阅 / done→跳跃 / failed→趴下', () => {
    expect(animationForPhase('thinking')).toBe('running')
    expect(animationForPhase('tool')).toBe('running-right')
    expect(animationForPhase('review')).toBe('review')
    expect(animationForPhase('waiting')).toBe('waiting')
    expect(animationForPhase('done')).toBe('jumping')
    expect(animationForPhase('failed')).toBe('failed')
    expect(animationForPhase('idle')).toBe('idle')
  })
})

// ─── 3. 序列推进 ────────────────────────────────────────────────────────────

describe('序列推进（advanceSequence）', () => {
  it('零增量推进到首轨首帧（thinking → running frame 0）', () => {
    const st = initialSequenceState('thinking')
    const next = advanceSequence(st, 0, 'thinking')
    expect(next.track).toBe('running')
    expect(next.frame).toBe(0)
  })

  it('帧推进：running 首帧 330ms 后进入第 2 帧', () => {
    const st = initialSequenceState('thinking')
    const next = advanceSequence(st, 400, 'thinking')
    expect(next.track).toBe('running')
    expect(next.frame).toBe(1)
  })

  it('大增量跨越整条 track 后推进到序列下一条，不死循环', () => {
    let st = advanceSequence(initialSequenceState('thinking'), 0, 'thinking')
    for (let i = 0; i < 200; i++) {
      st = advanceSequence(st, 1000, 'thinking')
    }
    // 序列 thinking 含 running 等轨道；跑 200 帧后仍应返回合法 track + 有效帧号
    const valid: PetAnimation[] = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review']
    expect(valid).toContain(st.track)
    expect(st.frame).toBeGreaterThanOrEqual(0)
  })
})

// ─── 4. slot→phase 映射（核心：harness 工作状态 → 桌宠动作）────────────────

describe('slot→phase 映射（slotPhase）', () => {
  it('idle slot 无任务 → 悠闲 idle', () => {
    expect(slotPhase(slot(), undefined, 'running', undefined)).toBe('idle')
  })

  it('mission 待审批时全员等待主人', () => {
    expect(slotPhase(slot(), undefined, 'awaiting_approval', undefined)).toBe('waiting')
  })

  it('slot error → 趴下 failed；rate_limited → 等待', () => {
    expect(slotPhase(slot({ status: 'error' }), undefined, 'running', undefined)).toBe('failed')
    expect(slotPhase(slot({ status: 'rate_limited' }), undefined, 'running', undefined)).toBe('waiting')
  })

  it('running review 任务 → 翻阅审查', () => {
    expect(slotPhase(slot(), task({ type: 'review', status: 'running' }), 'running', undefined)).toBe('review')
  })

  it('running + tool_call 事件 → 工具跑动；其余 → 思考踱步', () => {
    expect(slotPhase(slot(), task({ status: 'running' }), 'running', 'tool_call')).toBe('tool')
    expect(slotPhase(slot(), task({ status: 'running' }), 'running', 'text')).toBe('thinking')
    expect(slotPhase(slot(), task({ status: 'running' }), 'running', undefined)).toBe('thinking')
  })

  it('协商/派发/就绪/暂停 → 等待观望', () => {
    for (const s of ['negotiating', 'accepted', 'dispatched', 'ready', 'paused']) {
      expect(slotPhase(slot(), task({ status: s }), 'running', undefined), `${s} 应等待`).toBe('waiting')
    }
  })

  it('blocked/escalated → 出状况趴下', () => {
    expect(slotPhase(slot(), task({ status: 'blocked' }), 'running', undefined)).toBe('failed')
    expect(slotPhase(slot(), task({ status: 'escalated' }), 'running', undefined)).toBe('failed')
  })
})

// ─── 5. 事件流进度提取 ─────────────────────────────────────────────────────

describe('事件流进度提取（latestProgressByTask）', () => {
  it('空事件流 → 空 map', () => {
    expect(latestProgressByTask([]).size).toBe(0)
  })

  it('tool_call 事件提取工具名（🛠 前缀）', () => {
    const evs: PodEvent[] = [
      { id: 'e1', kind: 'worker_progress', task_id: 'T-1', ts: 1, payload: { kind: 'tool_call', tool: 'edit_file' } },
    ]
    const map = latestProgressByTask(evs)
    expect(map.get('T-1')).toEqual({ kind: 'tool_call', text: '🛠 edit_file' })
  })

  it('同任务多条事件 → 最后一条覆盖', () => {
    const evs: PodEvent[] = [
      { id: 'e1', kind: 'worker_progress', task_id: 'T-1', ts: 1, payload: { kind: 'text', text: '第一步' } },
      { id: 'e2', kind: 'worker_progress', task_id: 'T-1', ts: 2, payload: { kind: 'text', text: '第二步' } },
    ]
    const map = latestProgressByTask(evs)
    expect(map.get('T-1')?.text).toBe('第二步')
  })

  it('非 worker_progress 事件被忽略', () => {
    const evs: PodEvent[] = [
      { id: 'e1', kind: 'task_started', task_id: 'T-1', ts: 1, payload: {} },
      { id: 'e2', kind: 'worker_progress', task_id: 'T-2', ts: 2, payload: { kind: 'text', text: 'x' } },
    ]
    const map = latestProgressByTask(evs)
    expect(map.has('T-1')).toBe(false)
    expect(map.has('T-2')).toBe(true)
  })
})

// ─── 6. 房间视图 SSR 渲染（防黑屏验收）───────────────────────────────────────

function statusFixture(over: Partial<StatusResponse> = {}): StatusResponse {
  return {
    mission: { id: 'M-1', status: 'running', goal: 'g', spent_tokens: 0, spent_equiv_usd: 0, budget_usd: 1, name: '桌宠预览' },
    tasks: [],
    slots: [],
    pending_approvals: [],
    experiments: { topology_animation: false, canvas_third_column: false },
    ledger: { total_tokens: 0, total_equiv_usd: 0, entries: [] },
    message: 'ok',
    ...over,
  }
}

describe('房间视图 SSR 渲染（PetRoomView）', () => {
  it('status null → 渲染连接中空状态（不黑屏）', () => {
    const html = renderToStaticMarkup(createElement(PetRoomView, { status: null, events: [] }))
    expect(html).toContain('dsh-pet-room')
    expect(html).toContain('连接中')
  })

  it('多 slot → 每 harness 一只桌宠，名牌显示 vendor', () => {
    const st = statusFixture({
      slots: [
        slot({ id: 'S-1', vendor: 'claude', role: 'implementer' }),
        slot({ id: 'S-2', vendor: 'codex', role: 'reviewer' }),
        slot({ id: 'S-3', vendor: 'dsh', role: 'planner' }),
      ],
    })
    const html = renderToStaticMarkup(createElement(PetRoomView, { status: st, events: [] }))
    expect(html).toContain('Claude')
    expect(html).toContain('Codex')
    expect(html).toContain('DSH')
    expect((html.match(/dsh-pet-station/g) ?? []).length).toBe(3)
  })

  it('有任务时气泡显示任务标题', () => {
    const st = statusFixture({
      slots: [slot({ id: 'S-1', vendor: 'claude', role: 'implementer' })],
      tasks: [task({ id: 'T-1', owner: 'S-1', status: 'running', title: '写 clampInt 函数' })],
    })
    const html = renderToStaticMarkup(createElement(PetRoomView, { status: st, events: [] }))
    expect(html).toContain('写 clampInt 函数')
    expect(html).toContain('思考中')
  })
})

describe('桌宠增强（2026-09-03）：多房间分区 + 戳一下详情卡', () => {
  it('zoneOf：failed→alert（最显眼）、thinking/tool/review→busy、其余→rest', () => {
    expect(zoneOf('failed')).toBe('alert')
    expect(zoneOf('thinking')).toBe('busy')
    expect(zoneOf('tool')).toBe('busy')
    expect(zoneOf('review')).toBe('busy')
    expect(zoneOf('idle')).toBe('rest')
    expect(zoneOf('waiting')).toBe('rest')
    expect(zoneOf('done')).toBe('rest')
  })

  it('分区渲染：出状况 slot 进 alert 区（分区标题 + 前置排序），忙碌/待命各归其区', () => {
    const st = statusFixture({
      slots: [
        slot({ id: 'S-1', vendor: 'claude', role: 'implementer', status: 'idle' }),
        slot({ id: 'S-2', vendor: 'codex', role: 'reviewer', status: 'working' }),
        slot({ id: 'S-3', vendor: 'ark', role: 'implementer', status: 'error' }),
      ],
      tasks: [
        task({ id: 'T-1', owner: 'S-1', status: 'done' }),
        task({ id: 'T-2', owner: 'S-2', status: 'running', type: 'review', title: '审查 T-1' }),
        task({ id: 'T-3', owner: 'S-3', status: 'escalated', title: '出状况的实现' }),
      ],
    })
    const html = renderToStaticMarkup(createElement(PetRoomView, { status: st, events: [] }))
    // 三个分区标题都渲染，且 alert 分区在 busy 之前（出状况排最前）
    expect(html).toContain('dsh-pet-zone-title alert')
    expect(html).toContain('dsh-pet-zone-title busy')
    expect(html).toContain('dsh-pet-zone-title rest')
    expect(html.indexOf('dsh-pet-zone-title alert')).toBeLessThan(html.indexOf('dsh-pet-zone-title busy'))
  })

  it('详情卡默认收起（未选中不渲染 steer 输入框），station 带点击手柄提示', () => {
    const st = statusFixture({
      slots: [slot({ id: 'S-1', vendor: 'claude', role: 'implementer' })],
      tasks: [task({ id: 'T-1', owner: 'S-1', status: 'running', title: '写 clampInt 函数' })],
    })
    const html = renderToStaticMarkup(createElement(PetRoomView, { status: st, events: [] }))
    expect(html).toContain('dsh-pet-station')
    expect(html).not.toContain('dsh-pet-detail')
    expect(html).not.toContain('dsh-pet-detail-input')
    expect(html).toContain('戳一下看详情')
  })
})
