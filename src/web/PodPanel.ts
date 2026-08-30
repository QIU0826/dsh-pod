/**
 * 控制台壳（2026-08-29 重设计）：64px 图标导航轨 + 顶栏（当前任务/预算）+ 视图切换。
 *
 * 视图：会话列表（master-detail）/ 对话（chat-first）/ 看板 / DAG / 合并审批 / 设置。
 * 会话语义：mission = 会话；选中历史会话 → 归档快照回放（只读）；未选中 → 活跃会话
 * 实时数据（2s status 轮询 + SSE 事件流）。新建会话：活跃 mission 未终结时确认后中止。
 */
import { createElement, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  fetchEvents,
  fetchMissionArchive,
  fetchMissions,
  fetchStatus,
  postAbort,
  postApprove,
  postDeny,
  postDispatch,
  postLaunch,
  postPause,
  postResolve,
  postResume,
  postSteer,
  type MissionArchive,
  type MissionSummary,
  type PodEvent,
  type StatusResponse,
} from './api.js'
import { openEventStream } from './event-stream.js'
import { fmtTokens } from './view-helpers.js'
import { CONSOLE_CSS } from './console-css.js'
import { loadSettings, saveSettings, type ConsoleSettings } from './console-settings.js'
import { Icon, type IconName } from './icons.js'
import { ChatView } from './chat-view.js'
import { SessionsView } from './sessions-view.js'
import { BoardView } from './board-view.js'
import { DagView } from './dag-view.js'
import { ApprovalView } from './approval-view.js'
import { SettingsView } from './settings-view.js'
import { MISSION_LABEL, MISSION_TONE, tokenBudgetPct, rosterToSlots } from './view-helpers.js'

const POLL_MS = 2000
const MISSIONS_POLL_MS = 5000
/** 单次轮询最多续读的批数（防 has_more 异常时死循环拖垮主线程）。 */
const MAX_EVENT_PAGES = 10

type ViewKey = 'sessions' | 'chat' | 'board' | 'dag' | 'approval' | 'settings'

export function PodPanel(): ReactElement {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [events, setEvents] = useState<PodEvent[]>([])
  const [missions, setMissions] = useState<MissionSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState<ConsoleSettings>(loadSettings)
  const [view, setView] = useState<ViewKey>(loadSettings().defaultView === 'board' ? 'board' : loadSettings().defaultView === 'dag' ? 'dag' : 'chat')
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [archive, setArchive] = useState<MissionArchive | null>(null)
  const [userMessages, setUserMessages] = useState<Array<{ id: string; ts: number; text: string }>>([])
  const [answered, setAnswered] = useState<Set<string>>(new Set())
  const [selectedSlot, setSelectedSlot] = useState('')
  const [approvalId, setApprovalId] = useState('')
  const lastEventId = useRef('')

  const activeId = status?.mission?.id ?? ''
  const isLive = selectedSessionId === null || selectedSessionId === activeId

  const updateSettings = (next: ConsoleSettings): void => {
    setSettings(next)
    saveSettings(next)
  }

  const mergeEvents = (incoming: PodEvent[], cursor?: string): void => {
    if (incoming.length === 0) return
    // 游标优先取服务端批次游标（轮询）；SSE 逐帧推送没有批次游标，取该帧自身的 id。
    // 用 id 而非 ts：同毫秒产生的多个事件不会被 `ts > after` 的严格比较整批跳过。
    const last = incoming[incoming.length - 1]!
    lastEventId.current = cursor !== undefined && cursor.length > 0 ? cursor : last.id
    setEvents((prev) => {
      const seen = new Set(prev.map((e) => e.id))
      return [...prev, ...incoming.filter((e) => !seen.has(e.id))].slice(-400)
    })
  }

  const poll = async (): Promise<void> => {
    try {
      setStatus(await fetchStatus())
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const pollMissions = async (): Promise<void> => {
    try { setMissions(await fetchMissions()) } catch { /* 会话列表失败不打断主轮询 */ }
  }

  const pollEvents = async (): Promise<void> => {
    try {
      // has_more：本批取完还有 → 立即续读，不等下个周期（高吞吐时避免持续落后并丢事件）
      for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
        const batch = await fetchEvents(lastEventId.current)
        mergeEvents(batch.events, batch.cursor)
        if (!batch.has_more || batch.events.length === 0) break
      }
    } catch { /* SSE 兜底轮询失败静默 */ }
  }

  useEffect(() => {
    if (document.getElementById('pod-console-css') === null) {
      const style = document.createElement('style')
      style.id = 'pod-console-css'
      style.textContent = CONSOLE_CSS
      document.head.appendChild(style)
    }
    void poll()
    void pollMissions()
    const statusTimer = setInterval(() => void poll(), POLL_MS)
    const missionsTimer = setInterval(() => void pollMissions(), MISSIONS_POLL_MS)
    // EV-2：优先 SSE（replay + live）；失败回退 2s 事件轮询
    let eventsTimer: ReturnType<typeof setInterval> | undefined
    const stopStream = openEventStream(
      (event) => mergeEvents([event]),
      () => {
        if (eventsTimer === undefined) eventsTimer = setInterval(() => void pollEvents(), POLL_MS)
      },
    )
    void pollEvents()
    return () => {
      clearInterval(statusTimer)
      clearInterval(missionsTimer)
      if (eventsTimer !== undefined) clearInterval(eventsTimer)
      stopStream()
    }
  }, [])

  // 历史会话 → 归档快照（活跃会话走实时数据，不取归档）
  useEffect(() => {
    if (isLive || selectedSessionId === null) {
      setArchive(null)
      return
    }
    let cancelled = false
    fetchMissionArchive(selectedSessionId)
      .then((snapshot) => { if (!cancelled) setArchive(snapshot) })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true }
  }, [selectedSessionId, isLive])

  const mission = isLive ? (status?.mission ?? null) : archive?.mission ?? null
  const tasks = isLive ? status?.tasks ?? [] : archive?.tasks ?? []
  const slots = isLive ? status?.slots ?? [] : archive?.slots ?? []
  const threadEvents = isLive ? events : archive?.events ?? []
  const ledgerEntries = isLive ? status?.ledger?.entries ?? [] : archive?.ledger.entries ?? []
  const ledger = {
    total_tokens: isLive ? status?.ledger?.total_tokens ?? 0 : archive?.ledger.total_tokens ?? 0,
    total_equiv_usd: isLive ? status?.ledger?.total_equiv_usd ?? 0 : archive?.ledger.total_equiv_usd ?? 0,
    tokens_in: ledgerEntries.reduce((sum, e) => sum + e.tokens_in, 0),
    tokens_out: ledgerEntries.reduce((sum, e) => sum + e.tokens_out, 0),
  }
  const pendingApprovals = isLive ? status?.pending_approvals ?? [] : []

  // 指令目标默认值：优先在岗槽位
  useEffect(() => {
    if (slots.length === 0) return
    if (slots.some((s) => s.id === selectedSlot)) return
    const busy = slots.find((s) => s.status === 'working' || s.status === 'running' || s.status === 'dispatched')
    setSelectedSlot((busy ?? slots[0]!).id)
  }, [slots, selectedSlot])

  const runAction = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action()
      setError(null)
      setTimeout(() => { void poll(); void pollMissions() }, 300)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  /** 对话发送：无 mission = 组队发射；有 mission = 给目标 agent 排队指令。 */
  const handleSend = (text: string): void => {
    if (!isLive) return
    setUserMessages((prev) => [...prev, { id: `u-${Date.now()}`, ts: Date.now(), text }])
    if (mission === null) {
      if (settings.cwd.trim().length === 0) {
        setError('尚未设置本地仓库路径——已为你打开设置')
        setView('settings')
        return
      }
      if (settings.roster.length === 0) {
        setError('默认名册为空——请在设置里添加员工')
        setView('settings')
        return
      }
      void runAction(() => postLaunch({
        name: `会话 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
        goal: text,
        cwd: settings.cwd.trim(),
        // token 主计价：两种模式美元闸都放开（0 = 不限语义），token 模式另设 token 闸
        budget_usd: 0,
        budget_tokens: settings.budgetMode === 'tokens' && Number(settings.budgetTokens) > 0 ? Number(settings.budgetTokens) : undefined,
        slots: rosterToSlots(settings.roster),
      }))
      return
    }
    const target = selectedSlot.length > 0 ? selectedSlot : slots[0]?.id ?? ''
    if (target.length === 0) {
      setError('无名册可选目标，指令未发送')
      return
    }
    void runAction(() => postSteer(target, text))
  }

  /** 问题应答：答案经 steer 注入；任务已转人工时一并 resolve 重派。 */
  const handleAnswer = (ev: PodEvent, action: 'continue' | 'answer' | 'hold', text: string): void => {
    setAnswered((prev) => new Set(prev).add(ev.id))
    if (action === 'hold') return
    void runAction(async () => {
      if (ev.slot_id !== undefined && text.length > 0) await postSteer(ev.slot_id, `[人工答复] ${text}`)
      const escalated = tasks.some((t) => t.id === ev.task_id && t.status === 'escalated')
      if (escalated) await postResolve(ev.task_id ?? '', 'blocked', text.length > 0 ? text : '人工答复，继续执行')
    })
  }

  const handleApprove = (id: string): void => {
    void runAction(() => postApprove(id, undefined, true))
  }

  const handleDeny = (id: string, reason: string): void => {
    void runAction(() => postDeny(id, reason))
    setView('chat')
  }

  /** 新建会话：活跃会话未终结 → 确认中止；然后回到空对话（发射即新会话）。 */
  const handleNewSession = (): void => {
    if (activeId.length > 0 && status?.mission !== null && status?.mission !== undefined && status.mission.status !== 'done' && status.mission.status !== 'aborted') {
      if (!window.confirm('当前会话仍在运行。中止它并开始新会话？（中止不可恢复）')) return
      void runAction(() => postAbort('aborted for new session'))
    }
    setSelectedSessionId(null)
    setUserMessages([])
    setAnswered(new Set())
    setView('chat')
  }

  const openSession = (id: string, target: ViewKey): void => {
    setSelectedSessionId(id)
    setView(target)
  }

  const navItem = (key: ViewKey, label: string, icon: IconName, badge?: number): ReactElement =>
    createElement('button', {
      className: view === key ? 'dsh-rail-item active' : 'dsh-rail-item', type: 'button',
      onClick: () => {
        if (key === 'chat' || key === 'board' || key === 'dag') {
          // 主视图回到当前上下文：选中态归位到活跃会话（未选中时本来就跟随活跃）
          if (selectedSessionId !== null && selectedSessionId !== activeId) { /* 保留历史会话上下文浏览 */ }
        }
        setView(key)
      },
      'aria-label': label, title: label,
    },
      Icon(icon, 19),
      badge !== undefined && badge > 0 ? createElement('span', { className: 'dsh-rail-badge' }, String(badge)) : null)

  const budgetTokens = mission?.budget_tokens ?? null
  const tokenPct = mission !== null ? tokenBudgetPct(mission.spent_tokens, budgetTokens) : null
  const missionStatus = mission?.status ?? ''

  return createElement('div', { className: 'dsh-root' },
    createElement('div', { className: 'dsh-shell' },
      createElement('nav', { className: 'dsh-rail', 'aria-label': '主导航' },
        createElement('span', { className: 'dsh-rail-brand', 'aria-hidden': 'true' }, Icon('hexagon', 26)),
        navItem('sessions', '会话列表', 'messageSquare'),
        navItem('chat', '对话视图', 'bot', pendingApprovals.length),
        navItem('board', '任务看板', 'kanban'),
        navItem('dag', 'DAG 拓扑', 'network'),
        createElement('span', { className: 'dsh-rail-spacer' }),
        navItem('settings', '设置', 'settings')),
      createElement('div', { className: 'dsh-main-col' },
        error !== null ? createElement('div', { className: 'dsh-note error', role: 'alert' }, error) : null,
        status?.demo === true
          ? createElement('div', { className: 'dsh-note demo', title: 'standalone --demo 启动' },
              createElement('strong', null, '演示模式'),
              createElement('span', null, '—— agent 是脚本演员（固定剧本，不执行你的真实目标，也不花一分钱）。要真跑请不带 --demo 重启并用已装好的 claude/codex CLI。'))
          : null,
        createElement('header', { className: 'dsh-topbar' },
          createElement('div', { className: 'dsh-topbar-left' },
            createElement('div', { className: 'dsh-topbar-title' },
              createElement('span', { className: 'dsh-topbar-kicker' },
                isLive ? '当前任务' : '历史会话（只读）'),
              createElement('span', { className: 'dsh-topbar-goal', title: mission?.goal ?? '' },
                mission !== null ? mission.goal : '无进行中的会话')),
            missionStatus.length > 0
              ? createElement('span', { className: `dsh-pill ${MISSION_TONE[missionStatus] ?? 'idle'}` }, MISSION_LABEL[missionStatus] ?? missionStatus)
              : null),
          createElement('div', { className: 'dsh-topbar-right' },
            createElement('div', { className: 'dsh-budget-inline' },
              createElement('span', { className: 'dsh-topbar-kicker' }, tokenPct !== null ? 'Token 预算' : 'Token 消耗'),
              createElement('div', { className: 'row' },
                createElement('span', { className: 'dsh-mono', style: { fontSize: 12.5 } }, tokenPct !== null ? `${tokenPct}%` : `${fmtTokens(mission?.spent_tokens ?? 0)}`),
                tokenPct !== null
                  ? createElement('div', { className: 'dsh-meter', style: { width: 110 } },
                      createElement('span', {
                        className: tokenPct >= 90 ? 'dsh-meter-fill hot' : tokenPct >= 60 ? 'dsh-meter-fill warn' : 'dsh-meter-fill',
                        style: { width: `${tokenPct}%` },
                      }))
                  : createElement('span', { style: { fontSize: 11, color: 'var(--ink-3)' } }, '不限')))),
            mission !== null
              ? createElement('span', { className: 'dsh-mono', style: { fontSize: 11.5, color: 'var(--ink-3)' } }, mission.id)
              : null),
        view === 'sessions'
          ? createElement(SessionsView, {
              missions, selectedId: selectedSessionId ?? missions[0]?.id ?? '',
              onSelect: (id) => setSelectedSessionId(id),
              onOpen: openSession,
              onNew: handleNewSession,
            })
          : view === 'chat'
            ? createElement(ChatView, {
                live: isLive,
                mission, tasks, slots, events: threadEvents, ledger, ledgerByStage: isLive ? status?.ledger?.by_stage ?? {} : archive?.ledger.by_stage ?? {}, pendingApprovals,
                userMessages, answered, settings, selectedSlot,
                onSelectSlot: setSelectedSlot,
                onSend: handleSend,
                onAnswer: handleAnswer,
                onApprove: handleApprove,
                onViewApproval: (id) => { setApprovalId(id); setView('approval') },
                onDispatch: () => void runAction(() => postDispatch()),
                // 暂停/恢复只对活跃会话有意义（历史回放时编排器已释放）
                canPause: isLive && mission !== null && mission.status !== 'done' && mission.status !== 'aborted',
                isPaused: mission?.status === 'paused',
                onPause: () => void runAction(() => postPause()),
                onResume: () => void runAction(() => postResume()),
                onAbort: () => { if (window.confirm('中止当前会话？（终态，不可恢复）')) void runAction(() => postAbort('aborted via console')) },
                onNewSession: handleNewSession,
              })
            : view === 'board'
              ? createElement(BoardView, {
                  missionLive: isLive && mission !== null,
                  tasks, slots,
                  onDispatch: () => void runAction(() => postDispatch()),
                  onRefresh: () => { void poll(); void pollMissions() },
                  onAddTask: (title, type) => void runAction(async () => {
                    await fetch('/api/dsh-pod/plan', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ action: 'add', tasks: [{ id: `T-${Date.now().toString(36).slice(-5).toUpperCase()}`, title, spec: title, type, skill_tags: [], depends_on: [] }] }),
                    })
                  }),
                })
              : view === 'dag'
                ? createElement(DagView, { tasks })
                : view === 'approval'
                  ? createElement(ApprovalView, {
                      approvalId,
                      onBack: () => setView('chat'),
                      onApprove: (id, remember) => { void runAction(() => postApprove(id, undefined, remember)); setView('chat') },
                      onDeny: handleDeny,
                    })
                  : createElement(SettingsView, { settings, onSave: updateSettings }))))
}
