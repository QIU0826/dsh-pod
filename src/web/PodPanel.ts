/**
 * Mission Canvas 面板（W4 两栏，MVP）——React（createElement，无 JSX 依赖）。
 * 左栏：看板（To-do/Doing/Review/Done）+ 员工状态灯；右栏：team 事件流。
 * 顶栏：mission 状态 + 预算 + 审批卡操作；Team Builder 表单（W3 最小形态）。
 * 数据：2s 轮询 /api/dsh-pod/status + /events（同源 fetch，dsh-ssh 实证路径）。
 */
import { createElement, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import {
  fetchEvents,
  fetchStatus,
  postAbort,
  postApprove,
  postDeny,
  postDispatch,
  postLaunch,
  postSteer,
  type PodEvent,
  type StatusResponse,
  type StatusTask,
} from './api.js'
import { openEventStream } from './event-stream.js'
import { TopologyCanvas, type TopologyPoint } from './TopologyCanvas.js'

const POLL_MS = 2000

const styles: Record<string, CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, fontFamily: 'var(--ds-font-family-ui, sans-serif)', fontSize: 13, height: '100%' },
  header: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  pill: { padding: '2px 8px', borderRadius: 10, background: 'var(--ds-color-bg-2, rgba(0,0,0,.06))' },
  columns: { display: 'flex', gap: 12, flex: 1, minHeight: 0 },
  board: { flex: 1, display: 'flex', gap: 8, minWidth: 0 },
  col: { flex: 1, border: '1px solid var(--ds-color-border, rgba(0,0,0,.12))', borderRadius: 6, padding: 6, overflow: 'auto', minWidth: 90 },
  colTitle: { fontWeight: 600, marginBottom: 4 },
  task: { padding: '3px 6px', borderRadius: 4, background: 'var(--ds-color-bg-2, rgba(0,0,0,.05))', marginBottom: 4, fontSize: 12 },
  events: { flex: 1, border: '1px solid var(--ds-color-border, rgba(0,0,0,.12))', borderRadius: 6, padding: 6, overflow: 'auto' },
  eventLine: { fontSize: 11, color: 'var(--ds-color-text-2, #666)', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  form: { display: 'grid', gap: 6, padding: 8, border: '1px dashed var(--ds-color-border, rgba(0,0,0,.2))', borderRadius: 6 },
  input: { fontFamily: 'inherit', fontSize: 12 },
  button: { fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' },
  msg: { fontSize: 11, color: '#b45309' },
  approvals: { display: 'grid', gap: 4, padding: 8, border: '1px solid var(--ds-color-border, rgba(0,0,0,.12))', borderRadius: 6 },
  approvalCard: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flexWrap: 'wrap' },
  bar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  ledger: { flex: 1, border: '1px solid var(--ds-color-border, rgba(0,0,0,.12))', borderRadius: 6, padding: 6, overflow: 'auto', maxHeight: 160 },
  ledgerLine: { fontSize: 11, color: 'var(--ds-color-text-2, #666)', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  toggle: { fontSize: 11, padding: '2px 6px' },
}

const BOARD_COLS = ['ready', 'dispatched', 'running', 'blocked', 'done', 'escalated'] as const
const COL_LABEL: Record<string, string> = {
  ready: 'To-do',
  dispatched: 'Doing',
  running: 'Doing',
  blocked: 'Blocked',
  done: 'Done',
  escalated: '转人工',
}

/** 员工状态灯配色（方案书 174 行：idle/working/waiting_approval/error/stopped/rate_limited）。 */
const SLOT_COLOR: Record<string, string> = {
  idle: '#94a3b8',
  working: '#22c55e',
  waiting_approval: '#f59e0b',
  error: '#ef4444',
  stopped: '#64748b',
  rate_limited: '#f97316',
}

/** DoD-9 预设阵型：一键填充 slots（与手输同构，产物等价可改）。 */
const PRESETS: Array<{ id: string; label: string; slots: string }> = [
  { id: 'pair', label: '实现+审查（默认）', slots: 'claude implementer 编码; codex reviewer 审查' },
  { id: 'fullstack', label: '实现+测试+审查', slots: 'claude implementer 编码; claude tester 测试; codex reviewer 审查' },
  { id: 'research', label: '调研+实现', slots: 'claude researcher 调研; claude implementer 编码' },
  // v0.2 cross-review 阵型强化：双实现者交叉互审（异构 + 审查者≠实现者）
  { id: 'cross', label: '双实现互审', slots: 'claude implementer 编码 审查; codex implementer 编码 审查' },
]

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

export function PodPanel(): ReactElement {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [events, setEvents] = useState<PodEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('demo mission')
  const [goal, setGoal] = useState('')
  const [cwd, setCwd] = useState('D:\\玩具\\pod-demo-repo')
  const [budget, setBudget] = useState('3')
  const [slots, setSlots] = useState('claude implementer 编码; codex reviewer 审查')
  const lastTs = useRef(0)
  const [steerSlot, setSteerSlot] = useState('')
  const [steerText, setSteerText] = useState('')
  // v0.2 拓扑动画/自由画布（Berd-E 灰度 key: topology-animation）
  const [view, setView] = useState<'board' | 'topology' | 'canvas'>('board')
  const [topoPos, setTopoPos] = useState<Record<string, TopologyPoint>>({})
  const [draftTasks, setDraftTasks] = useState<StatusTask[]>([])
  const [draftPos, setDraftPos] = useState<Record<string, TopologyPoint>>({})

  const runAction = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action()
      setError(null)
      setTimeout(() => void poll(), 300)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const mergeEvents = (incoming: PodEvent[]): void => {
    if (incoming.length === 0) return
    lastTs.current = Math.max(lastTs.current, incoming[incoming.length - 1]!.ts)
    setEvents((prev) => {
      const seen = new Set(prev.map((e) => e.id))
      const merged = [...prev, ...incoming.filter((e) => !seen.has(e.id))]
      return merged.slice(-300)
    })
  }

  const poll = async (): Promise<void> => {
    try {
      const snapshot = await fetchStatus()
      setStatus(snapshot)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const pollEvents = async (): Promise<void> => {
    try {
      const tail = await fetchEvents(lastTs.current)
      mergeEvents(tail)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    // v0.2 拓扑动画 CSS（一次性注入；dsb-pod 无独立样式表，动画 keyframes 内联）
    if (!document.getElementById('pod-topo-anim')) {
      const style = document.createElement('style')
      style.id = 'pod-topo-anim'
      style.textContent = [
        '@keyframes pod-dash-flow { to { stroke-dashoffset: -16; } }',
        '@keyframes pod-node-pulse { 0% { opacity: .9; } 50% { opacity: .25; } 100% { opacity: .9; } }',
        '.pod-edge-running { animation: pod-dash-flow 1s linear infinite; }',
        '.pod-node-pulse { animation: pod-node-pulse 1.4s ease-in-out infinite; }',
      ].join('\n')
      document.head.appendChild(style)
    }
    void poll()
    const statusTimer = setInterval(() => void poll(), POLL_MS)
    // EV-2（AgentScope-I）：优先 SSE（replay + live）；失败回退 2s 事件轮询
    let eventsTimer: ReturnType<typeof setInterval> | undefined
    const stopStream = openEventStream(
      (event) => mergeEvents([event]),
      () => {
        if (eventsTimer === undefined) eventsTimer = setInterval(() => void pollEvents(), POLL_MS)
      },
    )
    // 先轮询一次补上 SSE 建立前的窗口（id 去重，安全）
    void pollEvents()
    return () => {
      clearInterval(statusTimer)
      if (eventsTimer !== undefined) clearInterval(eventsTimer)
      stopStream()
    }
  }, [])

  const handleLaunch = async (): Promise<void> => {
    const parsedSlots = slots
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part, i) => {
        const [vendorRaw, roleRaw, ...rest] = part.split(/\s+/)
        // v0.2 阵型强化：capabilities 按空格拆为多能力（'编码 审查' → ['编码','审查']）
        const capabilities = rest.map((w) => w.replace(/^./, (c) => c.toUpperCase()))
        const vendor = vendorRaw === 'codex' ? 'codex' : vendorRaw === 'dsh' ? 'dsh' : 'claude'
        return {
          id: `S-${i + 1}`,
          vendor,
          role: roleRaw ?? 'implementer',
          capabilities,
          model: vendor === 'codex' ? '' : 'deepseek-v4-pro',
        }
      })
    try {
      const result = await postLaunch({
        name,
        goal,
        cwd,
        budget_usd: Number(budget) || 3,
        slots: parsedSlots,
      })
      setError(null)
      void result
      // 启动后立即刷新看板
      setTimeout(() => void poll(), 500)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const mission = status?.mission
  // v0.2 崩溃恢复 UI：跨 DSH Web 刷新后按 mission.status 派生「恢复/需人工动作」提示（DoD-11 审批卡重建、paused/派发门）
  let recoveryNote: { text: string; tone: string } | null = null
  if (status !== null && mission === null && (status.pending_approvals.length > 0)) {
    recoveryNote = { text: '检测到待办审批卡（跨重启重建，DoD-11）· 审批卡已从磁盘恢复，等待裁决', tone: '#b45309' }
  } else if (mission != null) {
    if (mission.status === 'awaiting_approval') {
      recoveryNote = { text: 'mission 已跨重启重建（DoD-11）：审批卡待人工批准/驳回后合并', tone: '#b45309' }
    } else if (mission.status === 'awaiting_dispatch' || (status?.pending_approvals ?? []).some((a) => a.summary.includes('放行派发'))) {
      recoveryNote = { text: '（模式 2）派发确认门待放行：请在下方审批区批准/驳回', tone: '#b45309' }
    } else if (mission.status === 'paused') {
      recoveryNote = { text: 'mission 已暂停（预算/审批超期/崩溃）——状态已磁盘化，可恢复/接管后续派发', tone: '#b91c1c' }
    }
  }

  const handleApprove = (approvalId: string): void => {
    // AS-3（AgentScope-C）：批准前可编辑参数（merge note 备注，留痕在审批事件）
    const note = window.prompt('批准合并（可选合并备注，直接回车放行）：', '')
    const edited = note !== null && note.trim().length > 0 ? { merge_note: note.trim() } : undefined
    // W4「记住规则」：批准时是否生成同类免弹卡规则（取消=不记住，每次仍弹卡）
    const remember = window.confirm('记住此规则？（同类合并免弹卡；取消=不记住）')
    void runAction(() => postApprove(approvalId, edited, remember))
  }

  const handleDeny = (approvalId: string): void => {
    const reason = window.prompt('驳回原因：') ?? 'denied via canvas-ui'
    void runAction(() => postDeny(approvalId, reason))
  }

  const handleSteer = (): void => {
    if (steerSlot.trim().length === 0 || steerText.trim().length === 0) {
      setError('steer 需要 slot_id 与指令')
      return
    }
    void runAction(() => postSteer(steerSlot.trim(), steerText.trim()))
    setSteerText('')
  }

  const handleAbort = (): void => {
    if (window.confirm('中止当前 mission？（终态，不可恢复）')) {
      void runAction(() => postAbort('aborted via canvas-ui'))
    }
  }

  const handleDispatch = (): void => {
    void runAction(() => postDispatch())
  }

  return createElement(
    'div',
    { style: styles.root },
    createElement(
      'div',
      { style: styles.header },
      createElement('strong', null, 'Pod 鲸群'),
      mission
        ? createElement(
            'span',
            { style: styles.pill },
            `${mission.status} · tokens ${mission.spent_tokens} · ≈$${mission.spent_equiv_usd.toFixed(4)}/${mission.budget_usd}`,
          )
        : createElement('span', { style: styles.pill }, '无 active mission'),
      mission !== null
        ? createElement(
            'button',
            { style: { ...styles.button, color: '#b91c1c' }, onClick: handleAbort, 'aria-label': '中止 mission' },
            '中止',
          )
        : null,
      error !== null ? createElement('span', { style: styles.msg }, error) : null,
    ),
    recoveryNote !== null
      ? createElement('div', { style: { padding: 6, marginBottom: 4, borderRadius: 6, border: '1px dashed rgba(180,83,9,.4)', color: recoveryNote.tone, fontSize: 12, background: 'rgba(180,83,9,.06)' } }, '↻ ' + recoveryNote.text)
      : null,
    // v0.2 拓扑动画/自由画布（Berd-E 灰度：topology-animation 开启才显示入口）
    status?.experiments?.topology_animation === true
      ? createElement(
          'div',
          { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          (['board', 'topology', 'canvas'] as const).map((v) =>
            createElement(
              'button',
              {
                key: v,
                style: { ...styles.button, ...(view === v ? { background: 'var(--ds-color-bg-2, rgba(0,0,0,.08))', fontWeight: 700 } : {}) },
                'aria-label': `视图 ${v}`,
                onClick: () => setView(v),
              },
              v === 'board' ? '看板' : v === 'topology' ? '拓扑动画' : '自由画布',
            ),
          ),
        )
      : null,
    (status?.pending_approvals ?? []).length > 0
      ? createElement(
          'div',
          { style: styles.form },
          (status?.pending_approvals ?? []).map((approval) =>
            createElement(
              'div',
              { key: approval.id, style: { display: 'flex', gap: 8, alignItems: 'center' } },
              createElement('span', null, `审批卡 ${approval.id}: ${approval.summary}`),
              createElement('button', { style: styles.button, onClick: () => handleApprove(approval.id) }, '批准合并'),
              createElement('button', { style: { ...styles.button, color: '#b91c1c' }, onClick: () => handleDeny(approval.id) }, '驳回'),
            ),
          ),
        )
      : null,
    createElement(
      'div',
      { style: styles.form },
      createElement('input', {
        style: styles.input,
        name: 'pod-steer-slot',
        'aria-label': 'steer 目标员工槽位',
        placeholder: 'steer 目标槽位（如 S-1）',
        value: steerSlot,
        onChange: (e) => setSteerSlot(e.target.value),
      }),
      createElement('input', {
        style: styles.input,
        name: 'pod-steer-text',
        'aria-label': 'steer 指令',
        placeholder: 'steer 指令（员工下次派单必带，不打断进程）',
        value: steerText,
        onChange: (e) => setSteerText(e.target.value),
      }),
      createElement('button', { style: styles.button, onClick: handleSteer }, '发指令'),
      createElement('button', { style: styles.button, onClick: handleDispatch }, '手动派发'),
    ),
    createElement(
      'div',
      { style: styles.form },
      createElement('input', {
        style: styles.input,
        name: 'pod-name',
        'aria-label': 'mission 名称',
        placeholder: 'mission 名称',
        value: name,
        onChange: (e) => setName(e.target.value),
      }),
      createElement('input', {
        style: styles.input,
        name: 'pod-goal',
        'aria-label': '一句话可验收目标',
        placeholder: '一句话可验收目标',
        value: goal,
        onChange: (e) => setGoal(e.target.value),
      }),
      createElement('input', {
        style: styles.input,
        name: 'pod-cwd',
        'aria-label': 'cwd（git 仓库绝对路径）',
        placeholder: 'cwd（git 仓库绝对路径）',
        value: cwd,
        onChange: (e) => setCwd(e.target.value),
      }),
      createElement('input', {
        style: styles.input,
        name: 'pod-budget',
        'aria-label': '预算（美元）',
        placeholder: '预算 $',
        value: budget,
        onChange: (e) => setBudget(e.target.value),
      }),
      createElement('input', {
        style: styles.input,
        name: 'pod-slots',
        'aria-label': '员工（vendor role 能力，; 分隔）',
        placeholder: '员工：vendor role 能力（; 分隔，如 "claude implementer 编码; codex reviewer 审查"）',
        value: slots,
        onChange: (e) => setSlots(e.target.value),
      }),
      // DoD-9 预设组队：一键填充 slots（与手输同构，产物等价可改）
      createElement(
        'div',
        { style: { display: 'flex', gap: 6, alignItems: 'center' } },
        createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, '预设阵型：'),
        PRESETS.map((preset) =>
          createElement(
            'button',
            {
              key: preset.id,
              style: styles.button,
              'aria-label': `预设 ${preset.label}`,
              onClick: () => setSlots(preset.slots),
            },
            preset.label,
          ),
        ),
      ),
      createElement('button', { style: styles.button, onClick: () => void handleLaunch() }, '组队 Launch'),
    ),
    createElement(
      'div',
      { style: styles.columns },
      view === 'board'
        ? createElement(
            'div',
            { style: styles.board },
            BOARD_COLS.map((col) =>
              createElement(
                'div',
                { key: col, style: styles.col },
                createElement('div', { style: styles.colTitle }, COL_LABEL[col] ?? col),
                (status?.tasks ?? [])
                  .filter((t) => t.status === col)
                  .map((t) =>
                    createElement(
                      'div',
                      { key: t.id, style: styles.task },
                      `${t.id} ${t.title}${t.owner ? ` [${t.owner}]` : ''}${t.fault ? ` ⚠${t.fault}` : ''}${t.attempts > 0 ? ` (×${t.attempts})` : ''}`,
                    ),
                  ),
              ),
            ),
          )
        : createElement(
            'div',
            { style: { ...styles.board, flexDirection: 'column' } },
            // v0.2 拓扑动画/自由画布：同一 SVG 组件，canvas 模式可拖拽 + 手画 DAG
            createElement(TopologyCanvas, {
              tasks: status?.tasks ?? [],
              draggable: view === 'canvas',
              positions: topoPos,
              onMove: (id, x, y) => setTopoPos((prev) => ({ ...prev, [id]: { id, x, y } })),
              draftTasks,
              draftPositions: draftPos,
              onDraftMove: (id, x, y) => setDraftPos((prev) => ({ ...prev, [id]: { id, x, y } })),
              onAddTask:
                view === 'canvas'
                  ? (id, title) => {
                      setDraftTasks((prev) => [...prev, { id, title, type: 'implement', status: 'ready', fault: null, attempts: 0, owner: null, commit: null, depends_on: [] }])
                    }
                  : undefined,
              onDeleteDraft:
                view === 'canvas'
                  ? (id) => setDraftTasks((prev) => prev.filter((d) => d.id !== id))
                  : undefined,
            }),
          ),
    // v0.2 第三栏（Berd-E 灰度 key canvas-third-column）：员工状态灯 + 上下文占用 + 账本
    status?.experiments?.canvas_third_column === true
      ? createElement(
          'div',
          { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220, border: '1px solid var(--ds-color-border, rgba(0,0,0,.12))', borderRadius: 6, padding: 6, overflow: 'auto' } },
          createElement('div', { style: styles.colTitle }, '员工（状态灯）'),
          (status?.slots ?? []).map((s) =>
            createElement(
              'div',
              { key: s.id, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 4 } },
              createElement('span', { style: { width: 8, height: 8, borderRadius: '50%', background: SLOT_COLOR[s.status] ?? '#94a3b8', display: 'inline-block' } }),
              createElement('span', { style: { fontWeight: 600 } }, s.id),
              createElement('span', { style: { color: 'var(--ds-color-text-2, #666)' } }, `${s.role} · ${s.vendor}`),
              createElement('span', { style: { marginLeft: 'auto', fontSize: 10, color: 'var(--ds-color-text-2, #666)' } }, s.status),
              createElement('span', { style: { fontSize: 10, color: 'var(--ds-color-text-2, #666)' } }, `${s.ctx_usage_pct}%`),
            ),
          ),
          createElement('div', { style: { ...styles.colTitle, marginTop: 8 } }, '账本（tokens 实测 + 等效美元）'),
          (status?.ledger ?? []).map((entry, i) =>
            createElement(
              'div',
              { key: `${entry.slot_id}-${entry.ts}-${i}`, style: styles.ledgerLine },
              `${formatTime(entry.ts)} ${entry.slot_id}${entry.task_id ? ` [${entry.task_id}]` : ''} · ${entry.model} · ${entry.tokens_in}/${entry.tokens_out}t · $${entry.equiv_usd.toFixed(4)}${entry.price_known ? '' : '(无价目)'}`,
            ),
          ),
        )
      : null,
      createElement(
        'div',
        { style: styles.events },
        events.map((e) =>
          createElement(
            'div',
            { key: e.id, style: styles.eventLine },
            `${formatTime(e.ts)} ${e.kind}${e.task_id ? ` [${e.task_id}]` : ''}`,
          ),
        ),
      ),
    ),
  )
}
