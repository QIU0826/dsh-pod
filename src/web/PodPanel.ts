/**
 * Mission Canvas 面板（W4 两栏，MVP）——React（createElement，无 JSX 依赖）。
 * 左栏：看板（To-do/Doing/Review/Done）+ 员工状态灯；右栏：team 事件流。
 * 顶栏：mission 状态 + 预算 + 审批卡操作；Team Builder 表单（W3 最小形态）。
 * 数据：2s 轮询 /api/dsh-pod/status + /events（同源 fetch，dsh-ssh 实证路径）。
 */
import { createElement, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { fetchEvents, fetchStatus, postLaunch, type PodEvent, type StatusResponse } from './api.js'

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

  const poll = async (): Promise<void> => {
    try {
      const [snapshot, tail] = await Promise.all([fetchStatus(), fetchEvents(lastTs.current)])
      setStatus(snapshot)
      if (tail.length > 0) {
        lastTs.current = tail[tail.length - 1]!.ts
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.id))
          const merged = [...prev, ...tail.filter((e) => !seen.has(e.id))]
          return merged.slice(-300)
        })
      }
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    return () => clearInterval(timer)
  }, [])

  const handleLaunch = async (): Promise<void> => {
    const parsedSlots = slots
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part, i) => {
        const [vendorRaw, roleRaw, ...rest] = part.split(/\s+/)
        const capabilities = rest.length > 0 ? [rest.join(' ').replace(/^./, (c) => c.toUpperCase())] : []
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
      error !== null ? createElement('span', { style: styles.msg }, error) : null,
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
      createElement('button', { style: styles.button, onClick: () => void handleLaunch() }, '组队 Launch'),
    ),
    createElement(
      'div',
      { style: styles.columns },
      createElement(
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
      ),
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
