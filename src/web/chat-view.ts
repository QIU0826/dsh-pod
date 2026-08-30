/**
 * 对话视图（流式 + 传信版）：
 * - 流式输出：worker_progress 文本按「agent × 任务」聚合成单一气泡增量追加，
 *   执行中尾部显示打字光标（数据源 = SSE/轮询的既有事件流，非前端造流）；
 * - agent 间传信：task_dispatched（派单）/ agent_relay（审查上下文注入）/
 *   plan_delegation（目标下发）/ task_reassigned（交接）/ steer_queued（用户注入）
 *   以「A → B」行呈现，内容全部来自引擎落盘的真实事件 payload；
 * - 右侧任务面板：可拖拽调宽 + 一键折叠/展开；
 * - composer：多行 textarea（Enter 发送 / Shift+Enter 换行 / 可纵向拉伸）。
 */
import { createElement, useEffect, useRef, useState, type ReactElement } from 'react'
import type { PodEvent, StatusResponse, StatusSlot, StatusTask } from './api.js'
import { Icon } from './icons.js'
import { Avatar } from './avatars.js'
import type { ConsoleSettings } from './console-settings.js'
import { SLOT_LABEL, TASK_TYPE_LABEL, fmtTime, fmtTokens, shortSlotId } from './view-helpers.js'

type ThreadItem =
  | { k: 'user'; ts: number; text: string; key: string }
  | { k: 'agent'; ts: number; lastTs: number; slot: string; task: string; text: string; key: string }
  | { k: 'sys'; ts: number; text: string; tone?: 'sys' | 'warn' | 'ok'; key: string; noise: 1 | 2 }
  | { k: 'relay'; ts: number; from: string; to: string; note: string; key: string; noise: 1 | 2 }
  | { k: 'tool'; ts: number; slot: string; tool: string; count: number; key: string }
  | { k: 'question'; ts: number; ev: PodEvent; key: string }

/** 事件 → 对话流条目。worker_progress 按 (slot, task) 聚合 = 流式增量拼接。 */
function buildThread(events: PodEvent[], userMessages: Array<{ id: string; ts: number; text: string }>): ThreadItem[] {
  const items: ThreadItem[] = []
  const agentStreams = new Map<string, { k: 'agent'; ts: number; lastTs: number; slot: string; task: string; text: string; key: string }>()
  for (const m of userMessages) items.push({ k: 'user', ts: m.ts, text: m.text, key: m.id })
  for (const e of events) {
    const p = e.payload as Record<string, unknown>
    switch (e.kind) {
      case 'worker_progress': {
        if (p.kind === 'tool_call') {
          // 工具调用活动行（真实 agent 工作的心跳；同 agent 连续调用合并计数）
          const slot = e.slot_id ?? ''
          const tool = typeof p.tool === 'string' && p.tool.length > 0 ? p.tool : '工具'
          const lastItem = items[items.length - 1]
          if (lastItem !== undefined && lastItem.k === 'tool' && lastItem.slot === slot) {
            lastItem.count += 1
            lastItem.tool = tool
            lastItem.ts = e.ts
          } else {
            items.push({ k: 'tool', ts: e.ts, slot, tool, count: 1, key: e.id })
          }
          break
        }
        if (p.kind === 'system') {
          const text = typeof p.text === 'string' ? p.text.trim() : ''
          if (text.length === 0) break
          items.push({ k: 'sys', ts: e.ts, key: e.id, tone: 'warn', noise: 1, text })
          break
        }
        if (p.kind !== 'text') break
        const text = typeof p.text === 'string' ? p.text : ''
        if (text.trim().length === 0) break
        const slot = e.slot_id ?? ''
        const task = e.task_id ?? ''
        const key = `s|${slot}|${task}`
        const stream = agentStreams.get(key)
        if (stream !== undefined) {
          stream.text += text
          stream.lastTs = e.ts
        } else {
          const item = { k: 'agent' as const, ts: e.ts, lastTs: e.ts, slot, task, text, key }
          agentStreams.set(key, item)
          items.push(item)
        }
        break
      }
      case 'mission_created':
        items.push({ k: 'sys', ts: e.ts, key: e.id, noise: 2, text: `会话启动 · ${String(p.goal ?? '')}` })
        break
      case 'mission_started':
        items.push({ k: 'sys', ts: e.ts, key: e.id, noise: 2, text: 'mission 运行中' })
        break
      case 'plan_delegation':
        items.push({ k: 'relay', ts: e.ts, key: e.id, from: '编排', to: shortSlotId(e.slot_id), noise: 1, note: '目标下发：交给规划者分解为任务 DAG' })
        break
      case 'plan_expanded':
        items.push({ k: 'sys', ts: e.ts, key: e.id, tone: 'ok', noise: 1, text: `任务 DAG 就绪：${Array.isArray(p.tasks) ? (p.tasks as Array<{ id: string }>).map((t) => t.id).join(' · ') : ''}` })
        break
      case 'plan_replan_requested':
        items.push({ k: 'sys', ts: e.ts, key: e.id, tone: 'warn', noise: 1, text: `重规划：${String(p.reason ?? '')}` })
        break
      case 'plan_rejected':
        items.push({ k: 'sys', ts: e.ts, key: e.id, tone: 'warn', noise: 2, text: '规划提案未过裁决，重试中' })
        break
      case 'task_dispatched': {
        const to = shortSlotId(typeof p.to_slot === 'string' ? p.to_slot : undefined)
        const title = typeof p.title === 'string' ? p.title : ''
        const type = typeof p.type === 'string' ? p.type : ''
        items.push({
          k: 'relay', ts: e.ts, key: e.id, from: '编排', to, noise: 1,
          note: `派单 ${e.task_id ?? ''}「${title}」${type.length > 0 ? `（${TASK_TYPE_LABEL[type] ?? type}）` : ''}`,
        })
        break
      }
      case 'agent_relay': {
        const to = shortSlotId(typeof p.to_slot === 'string' ? p.to_slot : undefined)
        items.push({ k: 'relay', ts: e.ts, key: e.id, from: shortSlotId(e.slot_id), to, noise: 1, note: typeof p.note === 'string' ? p.note : '传信' })
        break
      }
      case 'task_started':
        items.push({ k: 'sys', ts: e.ts, key: e.id, noise: 2, text: `${e.task_id} 开始执行` })
        break
      case 'task_negotiation': {
        // 协商三态（任务生命周期 Negotiating）：要约 → 接受 / 谢绝（谢绝后换人再协商）
        const who = shortSlotId(typeof (p.to_slot ?? p.by_slot) === 'string' ? String(p.to_slot ?? p.by_slot) : undefined)
        const phase = typeof p.phase === 'string' ? p.phase : ''
        if (phase === 'offer') {
          items.push({ k: 'relay', ts: e.ts, key: e.id, from: '编排', to: who, noise: 1, note: `要约 ${e.task_id ?? ''}（能力匹配 · 预算 ${String((p.terms as { est_usd?: number } | undefined)?.est_usd ?? '?')}）` })
        } else if (phase === 'accepted') {
          items.push({ k: 'sys', ts: e.ts, key: e.id, tone: 'ok', noise: 1, text: `🤝 ${who} 接受 ${e.task_id ?? ''}` })
        } else {
          items.push({ k: 'sys', ts: e.ts, key: e.id, tone: 'warn', noise: 1, text: `🚫 ${who} 谢绝 ${e.task_id ?? ''}（${String(p.reason ?? '')}）→ 换人协商` })
        }
        break
      }
      case 'task_rejected':
        items.push({ k: 'sys', ts: e.ts, key: e.id, tone: 'warn', noise: 1, text: `⛔ ${e.task_id} 终局拒绝（全员谢绝：${String(p.reason ?? '')}）` })
        break
      case 'task_paused':
        items.push({ k: 'sys', ts: e.ts, key: e.id, tone: 'warn', noise: 1, text: `⏸ ${e.task_id} 已暂停（在途进程已终止，不计故障）` })
        break
      case 'task_resumed':
        items.push({ k: 'sys', ts: e.ts, key: e.id, noise: 1, text: `▶️ ${e.task_id} 已恢复，重新协商派发` })
        break
      case 'task_done':
        items.push({ k: 'sys', ts: e.ts, key: e.id, tone: 'ok', noise: 1, text: `✓ ${e.task_id} 完成` })
        break
      case 'task_blocked':
        items.push({ k: 'sys', ts: e.ts, key: e.id, tone: 'warn', noise: 1, text: `${e.task_id} 受阻（${String(p.fault ?? '')}）` })
        break
      case 'task_escalated':
        items.push({ k: 'sys', ts: e.ts, key: e.id, tone: 'warn', noise: 1, text: `${e.task_id} 转人工` })
        break
      case 'task_reassigned':
        items.push({ k: 'relay', ts: e.ts, key: e.id, from: shortSlotId(typeof p.from === 'string' ? p.from : undefined), to: shortSlotId(typeof p.to === 'string' ? p.to : undefined), noise: 1, note: `任务交接：${e.task_id ?? ''}（含进度/产物/指令上下文）` })
        break
      case 'task_human_resolved':
        items.push({ k: 'sys', ts: e.ts, key: e.id, noise: 1, text: `${e.task_id} 人工裁决生效` })
        break
      case 'task_question':
        items.push({ k: 'question', ts: e.ts, ev: e, key: e.id })
        break
      case 'steer_queued':
        items.push({ k: 'relay', ts: e.ts, key: e.id, from: '用户', to: shortSlotId(e.slot_id), noise: 1, note: `指令注入：${String(p.instruction ?? '').slice(0, 90)}` })
        break
      case 'dispatch_awaiting_approval':
        items.push({ k: 'sys', ts: e.ts, key: e.id, tone: 'warn', noise: 1, text: '派发确认门待放行（模式 2）' })
        break
      case 'budget_short_circuit':
      case 'mission_paused_budget':
        items.push({ k: 'sys', ts: e.ts, key: e.id, tone: 'warn', noise: 1, text: '预算告警：剩余不足以下派' })
        break
      case 'mission_paused_stale_approval':
      case 'mission_paused':
        items.push({ k: 'sys', ts: e.ts, key: e.id, tone: 'warn', noise: 1, text: 'mission 已暂停' })
        break
      case 'mission_resumed':
        items.push({ k: 'sys', ts: e.ts, key: e.id, noise: 2, text: 'mission 已恢复' })
        break
      case 'mission_denied':
        items.push({ k: 'sys', ts: e.ts, key: e.id, tone: 'warn', noise: 1, text: '审批驳回，任务重跑' })
        break
      case 'mission_aborted':
        items.push({ k: 'sys', ts: e.ts, key: e.id, noise: 1, text: 'mission 已中止' })
        break
      case 'mission_run_error':
      case 'completion_error':
      case 'commander_creation_error':
        items.push({ k: 'sys', ts: e.ts, key: e.id, tone: 'warn', noise: 1, text: `${e.kind}（详见事件）` })
        break
      default:
        items.push({ k: 'sys', ts: e.ts, key: e.id, noise: 2, text: e.kind })
    }
  }
  return items.sort((a, b) => a.ts - b.ts)
}

export interface ChatViewProps {
  live: boolean
  mission: StatusResponse['mission']
  tasks: StatusTask[]
  slots: StatusSlot[]
  events: PodEvent[]
  ledger: { total_tokens: number; total_equiv_usd: number; tokens_in: number; tokens_out: number }
  /** 按执行阶段（任务类型）的 token 归因（unknown = 无任务归属）。 */
  ledgerByStage: Record<string, { tokens: number; equiv_usd: number; entries: number }>
  pendingApprovals: Array<{ id: string; summary: string }>
  userMessages: Array<{ id: string; ts: number; text: string }>
  answered: Set<string>
  settings: ConsoleSettings
  selectedSlot: string
  onSelectSlot: (id: string) => void
  onSend: (text: string) => void
  onAnswer: (ev: PodEvent, action: 'continue' | 'answer' | 'hold', text: string) => void
  onApprove: (id: string) => void
  onViewApproval: (id: string) => void
  onDispatch: () => void
  onAbort: () => void
  /** 打开该任务的上下文查看器（Context Builder）。 */
  onOpenContext: (taskId: string) => void
  /** 暂停 / 恢复：此前只在 pod_pause / pod_resume 工具面可达，HTTP 与 UI 都没有入口。 */
  onPause: () => void
  onResume: () => void
  /** 是否存在可暂停的活跃会话（无 mission 或已终态 → 按钮禁用）。 */
  canPause: boolean
  /** 当前是否已暂停（决定按钮显示「恢复」还是「暂停」）。 */
  isPaused: boolean
  onNewSession: () => void
}

const SIDE_MIN = 232
const SIDE_MAX = 480

export function ChatView(props: ChatViewProps): ReactElement {
  const { live, mission, tasks, slots, events, ledger, ledgerByStage, pendingApprovals, userMessages, answered, settings, selectedSlot, onSelectSlot, onSend, onAnswer, onApprove, onViewApproval, onDispatch, onAbort, onOpenContext, onPause, onResume, canPause, isPaused, onNewSession } = props
  const [draft, setDraft] = useState('')
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [modalChoice, setModalChoice] = useState<'continue' | 'clarify' | 'escalate'>('continue')
  const [clarify, setClarify] = useState('')
  const [sideWidth, setSideWidth] = useState(288)
  const [sideOpen, setSideOpen] = useState(true)
  const [, setHeartbeat] = useState(0)
  const drag = useRef<{ startX: number; startW: number } | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const items = buildThread(events, userMessages)
  const noiseFloor = settings.density === 'compact' ? 1 : settings.density === 'standard' ? 2 : 3
  const visible = items.filter((it) => (it.k !== 'sys' && it.k !== 'relay') || it.noise < noiseFloor)
  const openQuestion = items.find((it) => it.k === 'question' && !answered.has(it.key) && !dismissed.has(it.key))

  useEffect(() => {
    // scrollIntoView 非标准宿主/测试环境可能缺失（实测 jsdom 下整页崩）：
    // 可选调用降级为「不滚动」，不能因为一个视觉效果让会话视图整体挂掉。
    bottomRef.current?.scrollIntoView?.({ block: 'end' })
  }, [visible.length])

  // 1s 心跳：活动卡耗时计时（事件粒度 2s，本地补 1s）
  useEffect(() => {
    const t = setInterval(() => setHeartbeat((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  // 侧面板拖拽调宽（window 级 pointermove）
  useEffect(() => {
    const move = (e: PointerEvent): void => {
      if (drag.current === null) return
      const delta = drag.current.startX - e.clientX
      setSideWidth(Math.min(SIDE_MAX, Math.max(SIDE_MIN, drag.current.startW + delta)))
    }
    const up = (): void => { drag.current = null }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [])

  const send = (): void => {
    const text = draft.trim()
    if (text.length === 0) return
    onSend(text)
    setDraft('')
    if (inputRef.current !== null) inputRef.current.style.height = 'auto'
  }

  const slotBusy = (id: string): boolean => {
    const s = slots.find((x) => x.id === id)
    return s !== undefined && (s.status === 'working' || s.status === 'running' || s.status === 'dispatched')
  }
  const taskOpen = (id: string): boolean => tasks.some((t) => t.id === id && t.status !== 'done' && t.status !== 'escalated')

  const welcome = visible.length === 0 && live && mission === null
    // key 必填：welcome 是 threadChildren 数组的成员，缺省会触发 React 重复/缺失 key 警告
    ? createElement('div', { key: 'welcome', style: { padding: '70px 8px 30px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 } },
        createElement('div', { style: { fontSize: 19, fontWeight: 600 } }, '开始一段新会话'),
        createElement('div', { className: 'dsh-hint', style: { maxWidth: 430 } },
          '一句话描述可验收的目标。发送后按设置里的默认名册组队：planner 分解任务，agent 并行执行、交叉审查，关键合并等你批准。'),
        createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, width: 430, marginTop: 8 } },
          ['给 README 增加安装章节并通过独立审查', '修复当前失败的测试，说明根因', '调研 SQLite 与 LevelDB 的取舍并给结论'].map((s) =>
            createElement('button', {
              key: s, className: 'dsh-btn ghost', type: 'button',
              style: { border: '1px solid var(--line)', borderRadius: 10, padding: '10px 14px', textAlign: 'left', fontSize: 13 },
              onClick: () => { setDraft(s); inputRef.current?.focus() },
            }, s))))
    : null

  const threadChildren: ReactElement[] = []
  if (welcome !== null) threadChildren.push(welcome)
  for (const it of visible) {
    if (it.k === 'user') {
      threadChildren.push(createElement('div', { className: 'dsh-msg-user-wrap', key: it.key },
        createElement('div', null,
          createElement('div', { className: 'dsh-msg-user' }, it.text),
          createElement('div', { className: 'dsh-msg-time' }, fmtTime(it.ts)))))
    } else if (it.k === 'agent') {
      const slot = slots.find((s) => s.id === it.slot)
      const streaming = live && slotBusy(it.slot) && taskOpen(it.task)
      const shown = it.text.length > settings.agentMsgMax ? `${it.text.slice(0, settings.agentMsgMax)}…` : it.text
      threadChildren.push(createElement('div', { className: 'dsh-msg', key: it.key },
        createElement('div', { className: 'dsh-msg-avatar' + (streaming ? ' accent' : ''), style: { padding: 2, borderRadius: 12 } },
          Avatar(slot?.avatar, slot?.status ?? (streaming ? 'working' : 'idle'), 28, false)),
        createElement('div', { className: 'dsh-msg-body' },
          createElement('div', { className: 'dsh-msg-head' },
            createElement('span', { className: 'dsh-msg-name' }, shortSlotId(it.slot)),
            createElement('span', { className: 'dsh-msg-sub' }, `${slot?.vendor ?? ''} · ${slot?.role ?? ''}`),
            streaming ? createElement('span', { className: 'dsh-dot on' }) : null),
          createElement('div', { className: 'dsh-msg-bubble', title: it.text.length > settings.agentMsgMax ? '已截断（设置可调）' : undefined },
            shown,
            streaming ? createElement('span', { className: 'dsh-caret', 'aria-hidden': 'true' }) : null),
          createElement('div', { className: 'dsh-msg-time' }, `${it.task.length > 0 ? `${it.task} · ` : ''}${fmtTime(it.lastTs)}`))))
    } else if (it.k === 'sys') {
      threadChildren.push(createElement('div', {
        className: it.tone === 'warn' ? 'dsh-sysline warn' : it.tone === 'ok' ? 'dsh-sysline ok' : 'dsh-sysline',
        key: it.key,
      }, it.text))
    } else if (it.k === 'tool') {
      threadChildren.push(createElement('div', { className: 'dsh-toolline', key: it.key },
        createElement('span', { className: 'who' }, `⚒ ${shortSlotId(it.slot)}`),
        createElement('span', { className: 'note' },
          it.count > 1 ? `${it.tool} ×${it.count}` : it.tool),
        createElement('span', { className: 'dsh-dot on', style: { marginLeft: 'auto' } })))
    } else if (it.k === 'relay') {
      threadChildren.push(createElement('div', { className: 'dsh-relay', key: it.key, title: it.note },
        createElement('span', { className: 'who' }, it.from),
        createElement('span', { className: 'arr' }, '→'),
        createElement('span', { className: 'who' }, it.to),
        createElement('span', { className: 'note' }, it.note.length > 64 ? `${it.note.slice(0, 64)}…` : it.note)))
    } else if (it.k === 'question') {
      const q = it.ev.payload as { questions?: string[] }
      const done = answered.has(it.key)
      threadChildren.push(createElement('div', { className: 'dsh-msg', key: it.key, style: done ? { opacity: .55 } : undefined },
        createElement('div', { className: 'dsh-msg-avatar info' }, Icon('helpCircle', 15)),
        createElement('div', { className: 'dsh-msg-body' },
          createElement('div', { className: 'dsh-msg-head' },
            createElement('span', { className: 'dsh-msg-name' }, '待确认'),
            createElement('span', { className: 'dsh-msg-sub' }, `来自 ${shortSlotId(it.ev.slot_id)}`)),
          createElement('div', { className: 'dsh-msg-card' },
            (q.questions ?? []).map((question, i) => createElement('div', { className: 'dsh-inline-q', key: i }, question)),
          done
            ? createElement('div', { className: 'dsh-hint', style: { marginTop: 8 } }, '已答复')
            : createElement('div', { className: 'dsh-card-actions' },
                createElement('button', { className: 'dsh-btn sm primary', type: 'button', onClick: () => setDismissed((prev) => new Set(prev).add(it.key)) }, '逐项答复…'),
                createElement('button', { className: 'dsh-btn sm', type: 'button', onClick: () => onAnswer(it.ev, 'continue', '请按你的专业判断继续执行') }, '按你的判断继续'))),
          createElement('div', { className: 'dsh-msg-time' }, fmtTime(it.ts)))))
    }
  }
  for (const approval of pendingApprovals) {
    threadChildren.push(createElement('div', { className: 'dsh-msg', key: approval.id },
      createElement('div', { className: 'dsh-msg-avatar warn' }, Icon('gitPullRequest', 15)),
      createElement('div', { className: 'dsh-msg-body' },
        createElement('div', { className: 'dsh-msg-head' },
          createElement('span', { className: 'dsh-msg-name' }, '审批请求'),
          createElement('span', { className: 'dsh-msg-sub' }, approval.id)),
        createElement('div', { className: 'dsh-msg-card' },
          createElement('h4', null, '待合并补丁'),
          createElement('div', { className: 'sub' }, approval.summary),
          createElement('div', { className: 'dsh-card-actions' },
            createElement('button', { className: 'dsh-btn sm primary', type: 'button', onClick: () => onViewApproval(approval.id) }, '查看完整补丁'),
            createElement('button', { className: 'dsh-btn sm', type: 'button', onClick: () => onApprove(approval.id) }, '批准'),
            createElement('button', { className: 'dsh-btn sm ghost', type: 'button', onClick: () => onViewApproval(approval.id) }, '拒绝…'))))))
  }

  const modal = openQuestion !== undefined && openQuestion.k === 'question'
    ? createElement('div', { className: 'dsh-overlay', role: 'dialog', 'aria-modal': 'true', key: `modal-${openQuestion.key}` },
        createElement('div', { className: 'dsh-modal' },
          createElement('div', { className: 'dsh-modal-header' },
            createElement('div', { className: 'dsh-modal-badge' }, Icon('bot', 20)),
            createElement('div', null,
              createElement('div', { className: 'dsh-modal-title' }, `Agent ${shortSlotId(openQuestion.ev.slot_id)} 需要你确认`),
              createElement('div', { className: 'dsh-hint' }, `关于 ${openQuestion.ev.task_id ?? ''} 的执行问题`))),
          createElement('div', { className: 'dsh-modal-body' },
            createElement('div', { className: 'dsh-qlist' },
              ((openQuestion.ev.payload as { questions?: string[] }).questions ?? ['（agent 报告了需要澄清的情况）']).map((q, i) =>
                createElement('div', { className: 'dsh-qitem', key: i },
                  createElement('span', { className: 'idx' }, String(i + 1)),
                  createElement('span', null, q)))),
            createElement('button', {
              className: modalChoice === 'continue' ? 'dsh-choice-card on' : 'dsh-choice-card', type: 'button',
              onClick: () => setModalChoice('continue'),
            },
              createElement('span', { className: 'dsh-choice-icon' }, Icon('play', 16)),
              createElement('span', null,
                createElement('div', { className: 'dsh-choice-label' }, '按你的判断继续'),
                createElement('div', { className: 'dsh-choice-hint' }, 'Agent 将根据现有上下文继续执行'))),
            createElement('button', {
              className: modalChoice === 'clarify' ? 'dsh-choice-card on' : 'dsh-choice-card', type: 'button',
              onClick: () => setModalChoice('clarify'),
            },
              createElement('span', { className: 'dsh-choice-icon' }, Icon('edit', 16)),
              createElement('span', null,
                createElement('div', { className: 'dsh-choice-label' }, '我来补充说明'),
                createElement('div', { className: 'dsh-choice-hint' }, '展开输入框，填写额外信息'))),
            modalChoice === 'clarify'
              ? createElement('textarea', {
                  className: 'dsh-textarea', value: clarify, autoFocus: true,
                  onChange: (e: { target: { value: string } }) => setClarify(e.target.value),
                  placeholder: '例如：需要包含 Windows 11 + Node 20 的约束…',
                })
              : null,
            createElement('button', {
              className: modalChoice === 'escalate' ? 'dsh-choice-card on' : 'dsh-choice-card', type: 'button',
              onClick: () => setModalChoice('escalate'),
            },
              createElement('span', { className: 'dsh-choice-icon' }, Icon('users', 16)),
              createElement('span', null,
                createElement('div', { className: 'dsh-choice-label' }, '保持转人工'),
                createElement('div', { className: 'dsh-choice-hint' }, '暂停并等待人工接管')))),
          createElement('div', { className: 'dsh-modal-footer' },
            createElement('button', {
              className: 'dsh-btn primary', type: 'button',
              disabled: modalChoice === 'clarify' && clarify.trim().length === 0,
              onClick: () => {
                if (modalChoice === 'continue') onAnswer(openQuestion.ev, 'continue', '请按你的专业判断继续执行')
                else if (modalChoice === 'clarify') onAnswer(openQuestion.ev, 'answer', clarify.trim())
                else { onAnswer(openQuestion.ev, 'hold', ''); setDismissed((prev) => new Set(prev).add(openQuestion.key)) }
                setModalChoice('continue')
                setClarify('')
              },
            }, '提交答复'))))
    : null

  // 活动推导：槽位 → 当前任务 + 最近工具 + 开始时刻（Context Builder 入口在活动卡上）
  const startedAt = new Map<string, number>()
  const lastTool = new Map<string, { tool: string; ts: number }>()
  for (const e of events) {
    if ((e.kind === 'task_started' || e.kind === 'task_dispatched') && e.task_id !== undefined) {
      startedAt.set(e.task_id, e.ts)
    } else if (e.kind === 'worker_progress' && e.slot_id !== undefined) {
      const p = e.payload as { kind?: string; tool?: string }
      if (p.kind === 'tool_call' && p.tool !== undefined) lastTool.set(e.slot_id, { tool: p.tool, ts: e.ts })
    }
  }
  const currentTaskOf = (slotId: string): StatusTask | undefined =>
    tasks.find((t) => t.owner === slotId && (t.status === 'running' || t.status === 'dispatched'))
  const fmtElapsed = (ms: number): string => {
    const sec = Math.max(0, Math.floor(ms / 1000))
    return sec >= 60 ? `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s` : `${sec}s`
  }

  const target = live && mission !== null ? (selectedSlot.length > 0 ? selectedSlot : slots[0]?.id ?? '') : ''
  const budgetTokens = mission?.budget_tokens ?? null
  const unlimited = budgetTokens === null || budgetTokens <= 0
  const budgetPctLocal = !unlimited ? Math.min(100, Math.round((mission?.spent_tokens ?? 0) / budgetTokens * 100)) : null

  const sideBody = createElement('aside', { className: 'dsh-chat-side', 'aria-label': '任务面板', style: { flex: 1, minWidth: 0, height: '100%' } },
    createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
      createElement('span', { className: 'dsh-side-title', style: { marginBottom: 0 } }, '任务面板'),
      createElement('button', {
        className: 'dsh-btn sm icon', type: 'button', 'aria-label': '折叠任务面板', title: '折叠',
        onClick: () => setSideOpen(false),
      }, Icon('arrowRight', 13))),
    createElement('div', null,
      createElement('div', { className: 'dsh-side-title' }, unlimited ? 'Token 消耗（不限预算）' : 'Token 预算'),
      budgetPctLocal !== null
        ? createElement('div', { className: 'dsh-meter' },
            createElement('span', {
              className: budgetPctLocal >= 90 ? 'dsh-meter-fill hot' : budgetPctLocal >= 60 ? 'dsh-meter-fill warn' : 'dsh-meter-fill',
              style: { width: `${budgetPctLocal}%` },
            }))
        : null,
      createElement('div', { className: 'dsh-kvrow' },
        createElement('span', null, `${fmtTokens(mission?.spent_tokens ?? 0)} 已用`),
        unlimited
          ? createElement('span', { style: { color: 'var(--ink-3)' } }, '不限')
          : createElement('span', { className: 'dsh-mono' }, `/ ${fmtTokens(budgetTokens)}`))),
    createElement('div', { className: 'dsh-side-card' },
      createElement('div', { className: 'dsh-kvrow', style: { marginTop: 0 } },
        createElement('span', null, 'Token 明细'),
        createElement('span', { className: 'dsh-mono', style: { color: 'var(--ink)' } }, fmtTokens(ledger.total_tokens))),
      createElement('div', { className: 'dsh-kvrow' }, createElement('span', null, '输入'), createElement('span', { className: 'dsh-mono' }, fmtTokens(ledger.tokens_in))),
      createElement('div', { className: 'dsh-kvrow' }, createElement('span', null, '输出'), createElement('span', { className: 'dsh-mono' }, fmtTokens(ledger.tokens_out))),
      Object.keys(ledgerByStage).length > 0
        ? createElement('div', { style: { marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }, key: 'stage' },
            createElement('div', { className: 'dsh-kvrow', style: { marginTop: 0, color: 'var(--ink-3)' } }, createElement('span', null, '阶段归因')),
            Object.entries(ledgerByStage).sort((a, b) => b[1].tokens - a[1].tokens).map(([stage, v]) =>
              createElement('div', { className: 'dsh-kvrow', key: stage },
                createElement('span', null, TASK_TYPE_LABEL[stage] ?? stage),
                createElement('span', { className: 'dsh-mono' }, `${fmtTokens(v.tokens)} · $${v.equiv_usd.toFixed(4)}`))))
        : null),
    createElement('div', null,
      createElement('div', { className: 'dsh-side-title' }, `代理槽位（${slots.length}）`),
      slots.length === 0
        ? createElement('div', { className: 'dsh-hint' }, '（无名册）')
        : slots.map((s) => {
            const busy = s.status === 'working' || s.status === 'running' || s.status === 'dispatched'
            const cur = currentTaskOf(s.id)
            const tool = lastTool.get(s.id)
            const startTs = cur !== undefined ? startedAt.get(cur.id) : undefined
            const elapsed = startTs !== undefined ? Date.now() - startTs : 0
            const ctxBtn = cur !== undefined
              ? createElement('span', {
                  className: 'ctx', role: 'button', tabIndex: 0,
                  onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); onOpenContext(cur.id) },
                  title: '查看发给该 agent 的完整上下文（Context Builder）',
                }, '上下文')
              : null
            return createElement('button', {
              key: s.id, className: selectedSlot === s.id ? 'dsh-slotrow on' : 'dsh-slotrow', type: 'button',
              onClick: () => onSelectSlot(s.id), title: live ? '点选为指令目标' : undefined,
            },
              Avatar(s.avatar, s.status, 26),
              createElement('span', { className: busy ? 'dsh-dot on' : s.status === 'error' ? 'dsh-dot err' : 'dsh-dot' }),
              createElement('span', { className: 'grow' },
                createElement('div', { className: 't1' }, `${shortSlotId(s.id)} · ${s.vendor} · ${s.role}`),
                createElement('div', { className: 't2' }, `${SLOT_LABEL[s.status] ?? s.status}${cur !== undefined ? ` · ${cur.id} ${cur.title.slice(0, 14)}` : ''}`),
                cur !== undefined
                  ? createElement('span', { className: 'dsh-actline' },
                      busy && tool !== undefined ? createElement('span', { className: 'tool' }, `⚒ ${tool.tool}`) : null,
                      createElement('span', { className: 'el' }, fmtElapsed(elapsed)),
                      ctxBtn)
                  : null))
          })),
    live && mission !== null
      ? createElement('div', null,
          createElement('div', { className: 'dsh-side-title' }, '快捷操作'),
          createElement('div', { className: 'dsh-quickactions' },
            createElement('button', { className: 'dsh-quickaction', type: 'button', onClick: () => inputRef.current?.focus() },
              Icon('navigation', 14), '引导方向'),
            createElement('button', { className: 'dsh-quickaction', type: 'button', onClick: onDispatch },
              Icon('play', 14), '派发任务'),
            createElement('button', {
              className: 'dsh-quickaction', type: 'button',
              onClick: isPaused ? onResume : onPause,
              disabled: !canPause && !isPaused,
              title: isPaused ? '恢复会话' : '暂停会话（状态落盘，可恢复）',
            }, Icon(isPaused ? 'play' : 'pause', 14), isPaused ? '恢复任务' : '暂停任务'),
            createElement('button', { className: 'dsh-quickaction danger', type: 'button', onClick: onAbort },
              Icon('square', 14), '中止任务')))
      : null)

  return createElement('div', { className: 'dsh-chat-grid', style: sideOpen ? { gridTemplateColumns: `minmax(0,1fr) ${sideWidth}px` } : { gridTemplateColumns: 'minmax(0,1fr)' } },
    createElement('div', { className: 'dsh-chat-main' },
      createElement('div', { className: 'dsh-thread' },
        createElement('div', { className: 'dsh-thread-inner' },
          threadChildren,
          createElement('div', { ref: bottomRef }))),
      modal,
      createElement('div', { className: 'dsh-composer' },
        !sideOpen
          ? createElement('button', {
              className: 'dsh-side-reopen', type: 'button', 'aria-label': '展开任务面板', title: '展开任务面板',
              onClick: () => setSideOpen(true),
            }, Icon('activity', 14))
          : null,
        createElement('div', { className: 'dsh-composer-inner' },
          createElement('textarea', {
            ref: inputRef,
            className: 'dsh-input dsh-composer-ta', rows: 1, 'aria-label': '消息输入', value: draft,
            disabled: !live,
            placeholder: !live
              ? '会话已结束（只读回放）'
              : mission === null
                ? '描述要完成的目标…（Enter = 组队发射）'
                : `给 ${shortSlotId(target)} 发指令（下次派单注入）…`,
            onChange: (e: { target: HTMLTextAreaElement }) => {
              setDraft(e.target.value)
              // 自动长高（用户手动 resize 后交还控制权；上限 180px 内滚动）
              const el = e.target
              if (el.style.height === '' || el.style.height === 'auto') {
                el.style.height = 'auto'
                el.style.height = `${Math.min(180, el.scrollHeight)}px`
              }
            },
            onKeyDown: (e: { key: string; shiftKey: boolean; preventDefault: () => void }) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
            },
          }),
          !live
            ? createElement('button', { className: 'dsh-composer-send', type: 'button', onClick: onNewSession, 'aria-label': '新建会话' }, Icon('plus', 17))
            : createElement('button', { className: 'dsh-composer-send', type: 'button', disabled: draft.trim().length === 0, onClick: send, 'aria-label': '发送' }, Icon('send', 16))))),
    sideOpen
      ? createElement('div', { style: { position: 'relative', flex: 'none', display: 'flex', minWidth: 0, overflow: 'hidden' } },
          createElement('div', {
            className: 'dsh-side-resize', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': '拖拽调整任务面板宽度',
            onPointerDown: (e: { clientX: number }) => { drag.current = { startX: e.clientX, startW: sideWidth } },
          }),
          sideBody)
      : null)
}
