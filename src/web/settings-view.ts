/**
 * 设置视图（设计稿「设置」屏）：卡片式表单 + 显式保存栏。
 * 仓库路径 = 只读 + 点选目录（本地目录点选器）；预算 = 输入 + 滑杆联动；
 * 名册 = 表格点选（供应商/角色下拉 + 能力标签多选）；密度三档；默认视图三选。
 */
import { createElement, useEffect, useState, type ReactElement } from 'react'
import { fetchBrowse, type BrowseResponse } from './api.js'
import { Icon } from './icons.js'
import { AVATAR_OPTIONS, Avatar, avatarLabel } from './avatars.js'
import {
  CAPABILITY_OPTIONS,
  ROLE_OPTIONS,
  VENDOR_OPTIONS,
  type ConsoleSettings,
  type RosterMember,
} from './console-settings.js'

export interface SettingsViewProps {
  settings: ConsoleSettings
  onSave: (next: ConsoleSettings) => void
}

/** 本地目录点选器（只读 loopback 服务端列目录，点选代替打字）。 */
function DirectoryPicker(props: { current: string; onPick: (path: string) => void; onClose: () => void }): ReactElement {
  const [data, setData] = useState<BrowseResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = (path: string): void => {
    setLoading(true)
    setError(null)
    fetchBrowse(path)
      .then((result) => { setData(result); setLoading(false) })
      .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false) })
  }
  useEffect(() => { load(props.current.trim().length > 0 ? props.current : '') }, [])

  const atRoot = data !== null && data.path.length === 0
  const child = (name: string): string =>
    data === null || data.path.length === 0
      ? ''
      : `${data.path}${/[\\/]$/.test(data.path) ? '' : data.path.includes('\\') ? '\\' : '/'}${name}`

  return createElement('div', { className: 'dsh-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': '选择仓库目录' },
    createElement('div', { className: 'dsh-modal' },
      createElement('div', { className: 'dsh-modal-header' },
        createElement('div', { className: 'dsh-modal-badge' }, Icon('folderOpen', 19)),
        createElement('div', { className: 'dsh-modal-title' }, '选择目标仓库目录')),
      createElement('div', { className: 'dsh-modal-body' },
        createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          createElement('div', { className: 'dsh-crumb' }, loading ? '读取中…' : atRoot ? '此电脑（选择盘符）' : data?.path ?? '—'),
          data !== null && data.parent !== null
            ? createElement('button', { className: 'dsh-btn sm', type: 'button', onClick: () => load(data.parent as string) }, '↑ 上一级')
            : null,
          data !== null && data.home.length > 0
            ? createElement('button', { className: 'dsh-btn sm', type: 'button', onClick: () => load(data.home), title: data.home }, '⌂ 主目录')
            : null),
        error !== null
          ? createElement('div', { className: 'dsh-task-callout err' }, Icon('alertTriangle', 13), `无法读取：${error}`)
          : createElement('div', { className: 'dsh-dirlist' },
              atRoot && (data?.roots ?? []).length > 0
                ? (data?.roots ?? []).map((drive) => createElement('button', {
                    key: drive, className: 'dsh-diritem', type: 'button', onClick: () => load(drive),
                  }, Icon('hexagon', 14), drive))
                : (data?.entries ?? []).length === 0
                  ? createElement('span', { className: 'dsh-hint', style: { padding: 10 } }, loading ? '读取中…' : '（没有可见的子目录）')
                  : (data?.entries ?? []).map((name) => createElement('button', {
                      key: name, className: 'dsh-diritem', type: 'button', onClick: () => load(child(name)),
                    }, Icon('folderOpen', 14), name)))),
      createElement('div', { className: 'dsh-modal-footer', style: { display: 'flex', gap: 8 } },
        createElement('button', { className: 'dsh-btn ghost', type: 'button', style: { width: 'auto', flex: 1 }, onClick: props.onClose }, '取消'),
        createElement('button', {
          className: 'dsh-btn primary', type: 'button', style: { width: 'auto', flex: 1 },
          disabled: data === null || data.path.length === 0,
          onClick: () => { if (data !== null && data.path.length > 0) props.onPick(data.path) },
        }, '选择此目录'))))
}

export function SettingsView(props: SettingsViewProps): ReactElement {
  const { settings, onSave } = props
  const [draft, setDraft] = useState<ConsoleSettings>({ ...settings, roster: settings.roster.map((m) => ({ ...m, capabilities: [...m.capabilities] })) })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickingAvatar, setPickingAvatar] = useState(-1)
  const [saved, setSaved] = useState(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)

  const patch = (p: Partial<ConsoleSettings>): void => { setDraft((prev) => ({ ...prev, ...p })); setSaved(false) }
  const patchRoster = (fn: (roster: RosterMember[]) => RosterMember[]): void => {
    setDraft((prev) => ({ ...prev, roster: fn(prev.roster.map((m) => ({ ...m, capabilities: [...m.capabilities] }))) }))
    setSaved(false)
  }

  const setSlot = (i: number, p: Partial<RosterMember>): void => {
    patchRoster((roster) => roster.map((m, idx) => (idx === i ? { ...m, ...p } : m)))
  }


  return createElement('div', { className: 'dsh-view' },
    createElement('div', { className: 'dsh-settings-wrap' },
      createElement('div', { className: 'dsh-settings-inner' },
        createElement('div', { className: 'dsh-card' },
          createElement('div', { className: 'dsh-card-header' },
            createElement('span', { className: 'dsh-card-title' }, '发射默认值'),
            createElement('span', { className: 'dsh-hint' }, '新会话发射时使用')),
          createElement('div', { className: 'dsh-form-row' },
            createElement('label', { className: 'dsh-label', htmlFor: 'set-cwd' }, '本地仓库路径'),
            createElement('div', { style: { display: 'flex', gap: 8 } },
              createElement('input', {
                id: 'set-cwd', className: 'dsh-input dsh-mono', readOnly: true,
                placeholder: '未选择（点右侧按钮挑选本地 git 仓库目录）',
                value: draft.cwd, onFocus: (e: { target: HTMLInputElement }) => e.target.blur(),
              }),
              createElement('button', { className: 'dsh-btn', type: 'button', style: { flex: 'none' }, onClick: () => setPickerOpen(true) },
                Icon('folderOpen', 15), '点选目录')),
            createElement('span', { className: 'dsh-hint' }, '任务将在此目录下执行文件操作。')),
          createElement('div', { className: 'dsh-form-row' },
            createElement('span', { className: 'dsh-label' }, '预算方式（按 Token 计）'),
            createElement('div', { className: 'dsh-seg', role: 'group', 'aria-label': '预算方式' },
              createElement('button', {
                type: 'button', className: draft.budgetMode === 'unlimited' ? 'on' : '',
                onClick: () => patch({ budgetMode: 'unlimited' }),
              }, '无需关注预算'),
              createElement('button', {
                type: 'button', className: draft.budgetMode === 'tokens' ? 'on' : '',
                onClick: () => patch({ budgetMode: 'tokens' }),
              }, 'Token 上限'))),
          draft.budgetMode === 'tokens'
            ? createElement('div', { className: 'dsh-form-row', key: 'tokens' },
                createElement('label', { className: 'dsh-label', htmlFor: 'set-tokens' }, '会话 Token 上限'),
                createElement('input', {
                  id: 'set-tokens', className: 'dsh-input dsh-mono', inputMode: 'numeric', type: 'number', min: 1, step: 1000,
                  value: draft.budgetTokens,
                  onChange: (e: { target: { value: string } }) => patch({ budgetTokens: e.target.value }),
                }),
                createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  [500_000, 1_000_000, 2_000_000, 5_000_000].map((n) => createElement('button', {
                    key: n, className: Number(draft.budgetTokens) === n ? 'dsh-tag on' : 'dsh-tag', type: 'button',
                    onClick: () => patch({ budgetTokens: String(n) }),
                  }, n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1000}k`))),
                createElement('span', { className: 'dsh-hint' }, '按 token 消耗熔断（输入/输出合计）；达到上限会在继续前请求确认。'))
            : createElement('div', { className: 'dsh-form-row', key: 'unlimited' },
                createElement('span', { className: 'dsh-hint' }, '不限预算：会话只显示已消耗 token，不做熔断（本地运行自己把关）。')))),
        createElement('div', { className: 'dsh-card' },
          createElement('div', { className: 'dsh-card-header' },
            createElement('span', { className: 'dsh-card-title' }, '默认员工名册'),
            createElement('button', {
              className: 'dsh-btn sm', type: 'button',
              onClick: () => patchRoster((roster) => [...roster, { vendor: 'claude', role: 'implementer', capabilities: ['编码'], avatar: 'bear' }]),
            }, Icon('plus', 13), '添加员工')),
          createElement('table', { className: 'dsh-roster-table', 'aria-label': '员工槽位列表' },
            createElement('thead', null,
              createElement('tr', null,
                createElement('th', { scope: 'col' }, '槽位'),
                createElement('th', { scope: 'col' }, '供应商'),
                createElement('th', { scope: 'col' }, '角色'),
                createElement('th', { scope: 'col' }, '形象'),
                createElement('th', { scope: 'col' }, '能力标签'),
                createElement('th', { scope: 'col', style: { width: 44 } }))),
            createElement('tbody', null,
              draft.roster.length === 0
                ? createElement('tr', null, createElement('td', { colSpan: 5 }, createElement('span', { className: 'dsh-hint' }, '（空名册——点「添加员工」）')))
                : draft.roster.map((m, i) => createElement('tr', { key: `${m.vendor}-${m.role}-${i}` },
                    createElement('td', { className: 'dsh-mono' }, `S-${i + 1}`),
                    createElement('td', null,
                      createElement('select', {
                        className: 'dsh-select', 'aria-label': `S-${i + 1} 供应商`, value: m.vendor,
                        onChange: (e: { target: { value: string } }) => setSlot(i, { vendor: e.target.value as RosterMember['vendor'] }),
                      }, VENDOR_OPTIONS.map((v) => createElement('option', { key: v.id, value: v.id }, v.label)))),
                    createElement('td', null,
                      createElement('select', {
                        className: 'dsh-select', 'aria-label': `S-${i + 1} 角色`, value: m.role,
                        onChange: (e: { target: { value: string } }) => {
                          const role = ROLE_OPTIONS.find((r) => r.id === e.target.value)
                          setSlot(i, { role: e.target.value, capabilities: role !== undefined ? [...role.caps] : m.capabilities })
                        },
                      }, ROLE_OPTIONS.map((r) => createElement('option', { key: r.id, value: r.id }, r.label)))),
                    createElement('td', null,
                      createElement('button', {
                        className: 'dsh-btn sm ghost', type: 'button', title: '点选形象',
                        style: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px' },
                        onClick: () => setPickingAvatar(pickingAvatar === i ? -1 : i),
                      },
                        Avatar(m.avatar, 'idle', 26),
                        createElement('span', null, avatarLabel(m.avatar)))),
                    pickingAvatar === i
                      ? createElement('td', { colSpan: 6, style: { background: 'var(--surface-2)', borderBottom: '1px solid var(--line)' } },
                          createElement('div', { className: 'dsh-avatar-grid', role: 'group', 'aria-label': '形象选择' + `S-${i + 1}` },
                            AVATAR_OPTIONS.map((a) => createElement('button', {
                              key: a.id,
                              className: m.avatar === a.id ? 'dsh-avatar-cell on' : 'dsh-avatar-cell',
                              type: 'button', onClick: () => { setSlot(i, { avatar: a.id }); setPickingAvatar(-1) },
                            },
                              Avatar(a.id, 'idle', 34, false),
                              createElement('span', { className: 'nm' }, a.label)))))
                      : null,
                    createElement('td', null,
                      createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
                        CAPABILITY_OPTIONS.map((cap) => {
                          const on = m.capabilities.includes(cap)
                          return createElement('button', {
                            key: cap, className: on ? 'dsh-tag on' : 'dsh-tag', type: 'button',
                            'aria-pressed': on, title: on ? '点击移除' : '点击添加',
                            onClick: () => setSlot(i, {
                              capabilities: on ? m.capabilities.filter((c) => c !== cap) : [...m.capabilities, cap],
                            }),
                          }, cap)
                        }))),
                    createElement('td', null,
                      createElement('button', {
                        className: 'dsh-btn sm icon', type: 'button', 'aria-label': `删除 S-${i + 1}`,
                        onClick: () => patchRoster((roster) => roster.filter((_, idx) => idx !== i)),
                      }, Icon('trash', 13))))))),
          createElement('span', { className: 'dsh-hint', style: { display: 'block', marginTop: 8 } }, '全部点选配置；含「规划」能力的槽位发射后先做任务分解。')),
        createElement('div', { className: 'dsh-card' },
          createElement('div', { className: 'dsh-card-header' }, createElement('span', { className: 'dsh-card-title' }, '对话行为')),
          createElement('div', { className: 'dsh-form-row' },
            createElement('span', { className: 'dsh-label' }, '时间线密度'),
            createElement('div', { className: 'dsh-seg', role: 'group', 'aria-label': '事件密度' },
              [{ v: 'compact', label: '紧凑' }, { v: 'standard', label: '标准' }, { v: 'verbose', label: '详细' }].map((o) => createElement('button', {
                key: o.v, type: 'button', className: draft.density === o.v ? 'on' : '',
                onClick: () => patch({ density: o.v as ConsoleSettings['density'] }),
              }, o.label)))),
          createElement('div', { className: 'dsh-form-row' },
            createElement('span', { className: 'dsh-label' }, 'Agent 消息截断'),
            createElement('div', { className: 'dsh-seg', role: 'group', 'aria-label': '消息截断' },
              [400, 600, 1200].map((n) => createElement('button', {
                key: n, type: 'button', className: draft.agentMsgMax === n ? 'on' : '',
                onClick: () => patch({ agentMsgMax: n }),
              }, `${n} 字`)))),
          createElement('div', { className: 'dsh-form-row' },
            createElement('label', { className: 'dsh-label', htmlFor: 'set-view' }, '任务启动后默认进入的视图'),
            createElement('select', {
              id: 'set-view', className: 'dsh-select', style: { maxWidth: 220 },
              value: draft.defaultView,
              onChange: (e: { target: { value: string } }) => patch({ defaultView: e.target.value as ConsoleSettings['defaultView'] }),
            },
              createElement('option', { value: 'chat' }, '对话'),
              createElement('option', { value: 'board' }, '看板'),
              createElement('option', { value: 'dag' }, 'DAG')))),
        createElement('div', { className: 'dsh-savebar' },
          saved ? createElement('span', { className: 'dsh-hint', style: { alignSelf: 'center' } }, '✓ 已保存') : null,
          createElement('button', {
            className: 'dsh-btn', type: 'button', disabled: !dirty,
            onClick: () => { setDraft({ ...settings, roster: settings.roster.map((m) => ({ ...m, capabilities: [...m.capabilities] })) }); setSaved(false) },
          }, '重置'),
          createElement('button', {
            className: 'dsh-btn primary', type: 'button', disabled: !dirty,
            onClick: () => { onSave(draft); setSaved(true) },
          }, Icon('save', 14), '保存设置'))),
    pickerOpen
      ? createElement(DirectoryPicker, {
          current: draft.cwd,
          onPick: (path) => { patch({ cwd: path }); setPickerOpen(false) },
          onClose: () => setPickerOpen(false),
        })
      : null)
}
