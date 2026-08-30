/**
 * 任务看板视图（设计稿「任务看板」屏）：5 列看板 + 搜索/手动分派 + 右侧 Agent 槽位栏。
 */
import { createElement, useState, type ReactElement } from 'react'
import type { StatusSlot, StatusTask } from './api.js'
import { Icon } from './icons.js'
import { Avatar } from './avatars.js'
import { SLOT_LABEL, TASK_STATUS_LABEL, TASK_TYPE_LABEL, shortSlotId } from './view-helpers.js'

const BOARD_COLS: Array<{ key: string; label: string; dot: string; statuses: string[] }> = [
  { key: 'todo', label: '待办', dot: 'var(--info)', statuses: ['ready'] },
  { key: 'negotiating', label: '协商中', dot: '#8b5cf6', statuses: ['negotiating', 'accepted'] },
  { key: 'doing', label: '执行中', dot: 'var(--primary)', statuses: ['dispatched', 'running'] },
  { key: 'paused', label: '已暂停', dot: '#64748b', statuses: ['paused'] },
  { key: 'blocked', label: '受阻', dot: 'var(--error)', statuses: ['blocked'] },
  { key: 'done', label: '完成', dot: 'var(--success)', statuses: ['done'] },
  { key: 'escalated', label: '转人工', dot: 'var(--warning)', statuses: ['escalated', 'rejected'] },
]

export interface BoardViewProps {
  missionLive: boolean
  tasks: StatusTask[]
  slots: StatusSlot[]
  onDispatch: () => void
  onRefresh: () => void
  onAddTask: (title: string, type: string) => void
  /** 点任务卡 → 上下文查看器。 */
  onOpenContext: (taskId: string) => void
  /** 任务级暂停 / 恢复（任务生命周期 InProgress⇄Paused）。 */
  onPauseTask: (taskId: string) => void
  onResumeTask: (taskId: string) => void
  /** 任务换人：kill 旧进程 + 交接四件套 + 事件审计，任务置 ready 重派。 */
  onReassign: (taskId: string) => void
  /** 当前选中的槽位 id（换人目标）；null = 未选。 */
  reassignTarget: string | null
  /** 目标槽位的短标签（用于按钮提示文案）。 */
  reassignTargetLabel: string
  /**
   * 选中槽位。此前看板的槽位卡片是纯 div、不可点，用户要换人得先切到对话视图
   * 选槽位再切回来——这条路径没有任何提示，等于换人功能不可达。
   */
  onSelectSlot: (slotId: string) => void
}

function TaskCard(props: {
  task: StatusTask
  onOpen: (id: string) => void
  onPauseTask: (id: string) => void
  onResumeTask: (id: string) => void
  /** 换人（v0.2 工具面早就有，UI 一直没入口）：目标 = 当前选中的槽位。 */
  onReassign: (taskId: string) => void
  /** 当前选中的槽位 id（null = 没选，此时换人按钮给出指引而非直接禁用无解释）。 */
  reassignTarget: string | null
  reassignTargetLabel: string
}): ReactElement {
  const { task } = props
  const cls = task.status === 'blocked' ? 'dsh-task-card blocked' : task.status === 'escalated' || task.status === 'rejected' ? 'dsh-task-card escalated' : task.status === 'done' ? 'dsh-task-card done' : task.status === 'paused' ? 'dsh-task-card paused' : 'dsh-task-card'
  const typeCls = `dsh-type-badge ${task.type}`
  const pausable = task.status === 'negotiating' || task.status === 'accepted' || task.status === 'dispatched' || task.status === 'running'
  return createElement('article', { className: cls, onClick: () => props.onOpen(task.id), title: '点击查看任务上下文（Context Builder）', style: { cursor: 'pointer' } },
    createElement('div', { className: 'dsh-task-head' },
      createElement('span', { className: 'dsh-task-id' }, task.id),
      createElement('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
        pausable
          ? createElement('button', {
              className: 'dsh-btn sm icon', type: 'button', 'aria-label': '暂停任务', title: '暂停该任务（终止在途进程，不计故障）',
              onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); props.onPauseTask(task.id) },
            }, Icon('pause', 12))
          : null,
        task.status === 'paused'
          ? createElement('button', {
              className: 'dsh-btn sm icon', type: 'button', 'aria-label': '恢复任务', title: '恢复该任务（重新协商派发）',
              onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); props.onResumeTask(task.id) },
            }, Icon('play', 12))
          : null,
        (() => {
          const terminal = task.status === 'done' || task.status === 'rejected'
          const target = props.reassignTarget
          const sameOwner = target !== null && target === task.owner
          const canReassign = !terminal && target !== null && !sameOwner
          if (terminal) return null
          return createElement('button', {
            className: 'dsh-btn sm icon', type: 'button', 'aria-label': '换人',
            disabled: !canReassign,
            // 禁用时也要说清为什么——不给解释的禁用按钮是最常见的 UX 陷阱
            title: canReassign
              ? `把任务转给 ${props.reassignTargetLabel}（kill 在途进程 + 交接四件套 + 事件审计）`
              : sameOwner
                ? '该任务已由这个槽位负责'
                : '先在下方代理槽位里选中一个目标，再点此换人',
            onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); props.onReassign(task.id) },
          }, Icon('users', 12))
        })(),
        createElement('span', { className: typeCls }, TASK_TYPE_LABEL[task.type] ?? task.type))),
    createElement('h3', { className: 'dsh-task-title' }, task.title),
    createElement('div', { className: 'dsh-task-meta' },
      createElement('span', null, TASK_STATUS_LABEL[task.status] ?? task.status),
      createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--ink-3)' } },
        Icon('rotate', 11), `${task.attempts} 次`)),
    task.fault !== null || task.last_error != null
      ? createElement('div', { className: task.status === 'escalated' ? 'dsh-task-callout warn' : 'dsh-task-callout err', title: task.last_error ?? task.fault ?? '' },
          Icon(task.status === 'escalated' ? 'userCheck' : 'alertTriangle', 13),
          createElement('span', null, task.fault ?? task.last_error ?? ''))
      : null,
    createElement('div', { className: 'dsh-task-fields' },
      createElement('div', { className: 'dsh-task-field' },
        createElement('span', { className: 'k' }, 'Slot'),
        createElement('span', { className: 'v' }, task.owner !== null ? shortSlotId(task.owner) : '—')),
      createElement('div', { className: 'dsh-task-field' },
        createElement('span', { className: 'k' }, 'Commit'),
        createElement('span', { className: 'v dsh-mono' }, task.commit ?? '—')),
      createElement('div', { className: 'dsh-task-field' },
        createElement('span', { className: 'k' }, '依赖'),
        createElement('span', { className: 'v' }, task.depends_on.length > 0 ? task.depends_on.join(',') : '—'))))
}

export function BoardView(props: BoardViewProps): ReactElement {
  const { missionLive, tasks, slots, onDispatch, onRefresh, onAddTask, onOpenContext, onPauseTask, onResumeTask, onReassign, reassignTarget, reassignTargetLabel, onSelectSlot } = props
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [addTitle, setAddTitle] = useState('')
  const [addType, setAddType] = useState('implement')

  const q = query.trim().toLowerCase()
  const filtered = q.length === 0 ? tasks : tasks.filter((t) => t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q))
  const taskCount = (statuses: string[]): number => tasks.filter((t) => statuses.includes(t.status)).length

  return createElement('div', { className: 'dsh-view' },
    createElement('div', { className: 'dsh-board-bar' },
      createElement('div', { className: 'dsh-search' },
        Icon('search', 14),
        createElement('input', { type: 'text', placeholder: '搜索任务 ID / 标题', 'aria-label': '搜索任务', value: query, onChange: (e: { target: { value: string } }) => setQuery(e.target.value) })),
      createElement('span', { style: { flex: 1 } }),
      missionLive
        ? createElement('button', { className: 'dsh-btn sm', type: 'button', onClick: onDispatch }, Icon('send', 13), '手动分派')
        : null,
      createElement('button', { className: 'dsh-btn sm icon', type: 'button', 'aria-label': '刷新', onClick: onRefresh }, Icon('refresh', 14))),
    createElement('div', { className: 'dsh-board-wrap' },
      createElement('div', { className: 'dsh-board-cols', role: 'region', 'aria-label': '看板区域' },
        BOARD_COLS.map((col) => createElement('section', { className: 'dsh-kcol', key: col.key },
          createElement('div', { className: 'dsh-kcol-head' },
            createElement('span', { className: 'dsh-dot', style: { background: col.dot } }),
            createElement('span', { className: 'dsh-kcol-title' }, col.label),
            createElement('span', { className: 'dsh-kcol-count' }, String(taskCount(col.statuses))),
            missionLive && col.key === 'todo'
              ? createElement('button', { className: 'dsh-btn sm icon', type: 'button', 'aria-label': '添加任务', onClick: () => setAdding(true) }, Icon('plus', 13))
              : null),
          createElement('div', { className: 'dsh-kcol-cards' },
            filtered.filter((t) => col.statuses.includes(t.status)).map((t) => createElement(TaskCard, {
              key: t.id, task: t, onOpen: onOpenContext, onPauseTask, onResumeTask,
              onReassign, reassignTarget, reassignTargetLabel,
            }))))),
      createElement('aside', { className: 'dsh-agent-rail', 'aria-label': '智能体槽位' },
        createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
          createElement('span', { style: { fontSize: 13.5, fontWeight: 600 } }, 'Agent 槽位'),
          createElement('span', { className: 'dsh-kcol-count' }, String(slots.length))),
        slots.length === 0
          ? createElement('div', { className: 'dsh-hint' }, '（无名册）')
          : slots.map((s) => {
              const busy = s.status === 'working' || s.status === 'running' || s.status === 'dispatched'
              const selected = s.id === reassignTarget
              // 可点选 = 换人目标。用 div + role=button（卡片内含结构化内容，
              // 用 <button> 包裹 div 不合 HTML 内容模型）
              return createElement('div', {
                className: `dsh-agent-slot clickable${selected ? ' selected' : ''}`,
                key: s.id,
                role: 'button',
                tabIndex: 0,
                'aria-pressed': selected,
                'aria-label': `槽位 ${shortSlotId(s.id)}`,
                title: selected ? '已选为换人目标（点任务卡的换人按钮即可转派）' : '点击选为换人目标',
                onClick: () => onSelectSlot(s.id),
                onKeyDown: (e: { key: string; preventDefault: () => void }) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectSlot(s.id) }
                },
              },
                createElement('div', { className: 'dsh-agent-slot-head' },
                  createElement('span', { className: 'dsh-agent-avatar' }, Avatar(s.avatar, s.status, 24, false)),
                  createElement('div', { style: { flex: 1, minWidth: 0 } },
                    createElement('div', { className: 'dsh-agent-name' }, `${shortSlotId(s.id)} · ${s.vendor}`),
                    createElement('div', { className: 'dsh-agent-role' }, `${s.role} · ${SLOT_LABEL[s.status] ?? s.status}`)),
                  createElement('span', { className: busy ? 'dsh-dot on' : s.status === 'error' ? 'dsh-dot err' : 'dsh-dot' })),
                (s.capabilities ?? []).length > 0
                  ? createElement('div', { className: 'dsh-agent-tags' },
                      (s.capabilities ?? []).map((c) => createElement('span', { className: 'dsh-tag', key: c, style: { cursor: 'default' } }, c)))
                  : null,
                createElement('div', { className: 'dsh-agent-ctx' },
                  createElement('div', { className: 'row' },
                    createElement('span', null, '上下文占用'),
                    createElement('span', { className: 'val' }, `${s.ctx_usage_pct}%`)),
                  createElement('div', { className: 'dsh-meter' },
                    createElement('span', {
                      className: s.ctx_usage_pct >= 85 ? 'dsh-meter-fill hot' : s.ctx_usage_pct >= 70 ? 'dsh-meter-fill warn' : 'dsh-meter-fill',
                      style: { width: `${Math.min(100, Math.max(0, s.ctx_usage_pct))}%` },
                    }))))
            }))),
    adding
      ? createElement('div', { className: 'dsh-overlay', role: 'dialog', 'aria-modal': 'true' },
          createElement('div', { className: 'dsh-modal' },
            createElement('div', { className: 'dsh-modal-header' },
              createElement('div', { className: 'dsh-modal-badge' }, Icon('plus', 19)),
              createElement('div', { className: 'dsh-modal-title' }, '添加任务节点')),
            createElement('div', { className: 'dsh-modal-body' },
              createElement('div', { className: 'dsh-form-row' },
                createElement('label', { className: 'dsh-label', htmlFor: 'add-task-title' }, '任务标题'),
                createElement('input', { id: 'add-task-title', className: 'dsh-input', value: addTitle, autoFocus: true, onChange: (e: { target: { value: string } }) => setAddTitle(e.target.value), placeholder: '例如：补充安装失败的排查章节' })),
              createElement('div', { className: 'dsh-form-row' },
                createElement('span', { className: 'dsh-label' }, '类型'),
                createElement('div', { className: 'dsh-seg' },
                  ['implement', 'review', 'test', 'doc', 'research'].map((t) => createElement('button', {
                    key: t, type: 'button', className: addType === t ? 'on' : '', onClick: () => setAddType(t),
                  }, TASK_TYPE_LABEL[t] ?? t)))),
              createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 } },
                createElement('button', { className: 'dsh-btn ghost', type: 'button', onClick: () => setAdding(false) }, '取消'),
                createElement('button', {
                  className: 'dsh-btn primary', type: 'button', disabled: addTitle.trim().length === 0,
                  onClick: () => { onAddTask(addTitle.trim(), addType); setAddTitle(''); setAddType('implement'); setAdding(false) },
                }, '加入待办')))))
      : null))
}
