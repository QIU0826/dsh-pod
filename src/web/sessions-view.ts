/**
 * 会话列表视图（设计稿「会话列表」屏）：master-detail。
 * 左：全部会话行（目标/状态/预算%/Tokens/创建时间）；右：选中会话详情
 * （预算、槽位、最新事件、进入对话/看板/DAG）。新建会话 → 对话视图发射。
 */
import { createElement, type ReactElement } from 'react'
import type { MissionSummary } from './api.js'
import { Icon } from './icons.js'
import { MISSION_LABEL, MISSION_TONE, tokenBudgetPct, fmtDateTime, fmtTokens } from './view-helpers.js'
import { Avatar } from './avatars.js'

export interface SessionsViewProps {
  missions: MissionSummary[]
  selectedId: string
  onSelect: (id: string) => void
  onOpen: (id: string, view: 'chat' | 'board' | 'dag') => void
  onNew: () => void
  /** 重命名会话（window.prompt 取新名）。 */
  onRename: (id: string) => void
  /** 删除会话（仅终态；调用方二次确认）。 */
  onDelete: (id: string) => void
}

function StatusPill({ status }: { status: string }): ReactElement {
  const tone = MISSION_TONE[status] ?? 'idle'
  return createElement('span', { className: `dsh-pill ${tone}` }, MISSION_LABEL[status] ?? status)
}

export function SessionsView(props: SessionsViewProps): ReactElement {
  const { missions, selectedId, onSelect, onOpen, onNew, onRename, onDelete } = props
  const selected = missions.find((m) => m.id === selectedId) ?? missions[0]

  return createElement('div', { className: 'dsh-view' },
    createElement('div', { className: 'dsh-page-head' },
      createElement('div', null,
        createElement('div', { className: 'dsh-page-title' }, '会话列表'),
        createElement('div', { className: 'dsh-page-sub' }, '全部会话历史与实时状态')),
      createElement('button', { className: 'dsh-btn primary', type: 'button', onClick: onNew },
        Icon('plus', 15), '新建会话')),
    createElement('div', { className: 'dsh-master-detail' },
      createElement('section', { className: 'dsh-list-region', 'aria-label': '会话列表' },
        createElement('div', { className: 'dsh-list-scroll' },
          createElement('div', { className: 'dsh-sess-grid dsh-sess-head', key: 'head' },
            createElement('span', null, '会话目标'),
            createElement('span', null, '状态'),
            createElement('span', { style: { textAlign: 'right' } }, '预算'),
            createElement('span', { style: { textAlign: 'right' } }, 'Tokens'),
            createElement('span', null, '创建时间'),
            createElement('span')),
          missions.length === 0
            ? createElement('div', { className: 'dsh-empty', key: 'empty' },
                Icon('inbox', 22),
                createElement('div', { className: 'dsh-empty-title' }, '还没有会话'),
                createElement('div', { className: 'dsh-empty-sub' }, '点击「新建会话」，一句话描述目标即可发射'))
            : missions.map((m) => {
                const tokens = m.tokens_in + m.tokens_out
                const tokenPct = tokenBudgetPct(m.spent_tokens, m.budget_tokens)
                return createElement('button', {
                  key: m.id,
                  className: selected !== undefined && selected.id === m.id ? 'dsh-sess-row on' : 'dsh-sess-row',
                  type: 'button', onClick: () => onSelect(m.id), onDoubleClick: () => onOpen(m.id, 'chat'),
                },
                  createElement('span', { className: 'dsh-sess-goal', title: m.goal }, m.goal),
                  createElement(StatusPill, { status: m.status }),
                  createElement('span', { className: 'dsh-mono', style: { textAlign: 'right', fontSize: 12.5 } }, tokenPct !== null ? `${tokenPct}%` : '∞'),
                  createElement('span', { className: 'dsh-mono', style: { textAlign: 'right', fontSize: 11.5, color: 'var(--ink-2)' } }, tokens > 0 ? fmtTokens(tokens) : '—'),
                  createElement('span', { style: { fontSize: 12, color: 'var(--ink-3)' } }, fmtDateTime(m.created_at)),
                  createElement('span', { style: { display: 'flex', justifyContent: 'flex-end', color: 'var(--ink-3)' } }, Icon('arrowRight', 15)))
              }))),
      selected !== undefined
        ? createElement('aside', { className: 'dsh-sess-detail', 'aria-label': '选中会话详情', key: selected.id },
            createElement('div', null,
              createElement('span', { className: 'dsh-kv-label' }, selected.active ? '当前进行' : '历史会话'),
              createElement('div', { className: 'dsh-kv-value', style: { marginTop: 4, lineHeight: 1.5 } }, selected.goal),
              createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 } },
                createElement(StatusPill, { status: selected.status }),
                createElement('span', { className: 'dsh-mono', style: { fontSize: 11.5, color: 'var(--ink-3)' } }, selected.id),
                selected.task_total > 0
                  ? createElement('span', { className: 'dsh-hint' }, `${selected.task_done}/${selected.task_total} 任务`)
                  : null)),
            createElement('div', null,
              createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 8 } },
                createElement('span', { style: { color: 'var(--ink-2)' } }, 'Token 预算'),
                (() => { const tp = tokenBudgetPct(selected.spent_tokens, selected.budget_tokens); return createElement('span', { className: 'dsh-mono' }, tp !== null ? `${tp}%` : '不限') })()),
              (() => { const tp = tokenBudgetPct(selected.spent_tokens, selected.budget_tokens); return tp === null ? null : createElement('div', { className: 'dsh-meter' },
                createElement('span', {
                  className: tp >= 90 ? 'dsh-meter-fill hot' : tp >= 60 ? 'dsh-meter-fill warn' : 'dsh-meter-fill',
                  style: { width: `${tp}%` },
                })) })(),
              createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--ink-3)', marginTop: 6 } },
                createElement('span', { className: 'dsh-mono' }, `${fmtTokens(selected.spent_tokens)} 已用`),
                (() => { return selected.budget_tokens !== null && selected.budget_tokens > 0 ? createElement('span', { className: 'dsh-mono' }, `/ ${fmtTokens(selected.budget_tokens)}`) : createElement('span', null, '不限预算') })())),
            createElement('div', null,
              createElement('span', { className: 'dsh-kv-label' }, `Agent 槽位（${selected.slots.length}）`),
              createElement('div', { className: 'dsh-slotchips', style: { marginTop: 8 } },
                selected.slots.length === 0
                  ? createElement('span', { className: 'dsh-hint' }, '（无）')
                  : selected.slots.map((s) => createElement('span', { className: 'dsh-slotchip', key: s.id },
                      Avatar(s.avatar, 'idle', 18, false),
                      `${s.id.includes('-S-') ? s.id.slice(s.id.indexOf('-S-') + 1) : s.id} · ${s.role}`)))),
            selected.last_event !== null
              ? createElement('div', { className: 'dsh-lastevent' },
                  Icon('clock', 15),
                  createElement('div', { style: { minWidth: 0 } },
                    createElement('div', { className: 'dsh-kv-label' }, '最新事件'),
                    createElement('div', { style: { fontSize: 13, marginTop: 2, wordBreak: 'break-all' } },
                      `${selected.last_event.kind}${selected.last_event.task_id !== undefined ? ` · ${selected.last_event.task_id}` : ''}`),
                    createElement('div', { className: 'dsh-hint', style: { marginTop: 2 } }, fmtDateTime(selected.last_event.ts))))
              : null,
            createElement('div', { style: { marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 12 } },
              createElement('button', { className: 'dsh-btn primary', type: 'button', onClick: () => onOpen(selected.id, 'chat') },
                Icon('messageSquare', 15), '进入对话'),
              createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
                createElement('button', { className: 'dsh-btn', type: 'button', onClick: () => onOpen(selected.id, 'board') },
                  Icon('kanban', 15), '看板'),
                createElement('button', { className: 'dsh-btn', type: 'button', onClick: () => onOpen(selected.id, 'dag') },
                  Icon('network', 15), 'DAG')),
              createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
                createElement('button', { className: 'dsh-btn ghost', type: 'button', onClick: () => onRename(selected.id) },
                  Icon('edit', 15), '重命名'),
                createElement('button', {
                  className: 'dsh-btn destructive',
                  type: 'button',
                  disabled: selected.active,
                  title: selected.active ? '当前会话仍在运行，先中止再删除' : '删除该会话及其全部历史（不可恢复）',
                  onClick: () => onDelete(selected.id),
                },
                  Icon('trash', 15), '删除'))))
        : null))
}
