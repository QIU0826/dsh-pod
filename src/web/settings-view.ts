/**
 * 设置视图（设计稿「设置」屏）：卡片式表单 + 显式保存栏。
 * 仓库路径 = 只读 + 点选目录（本地目录点选器）；预算 = 输入 + 滑杆联动；
 * 名册 = 表格点选（供应商/角色下拉 + 能力标签多选）；密度三档；默认视图三选。
 */
import { createElement, useEffect, useState, type ReactElement } from 'react'
import {
  deleteRule, fetchRules, fetchBrowse,
  fetchMemories, postMemory, postMemoryCorrect, fetchCron, saveCron,
  type ApprovalRuleView, type BrowseResponse,
  type MemoryRecordView, type MemoryType, type CronJobView, type CronFireView,
} from './api.js'
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

/**
 * 审批规则管理。
 *
 * 存在的理由：误建的规则（含「记住规则」自动沉淀的）此前只能手工改磁盘文件——
 * 用户一旦建错或被自动记住了不想要的规则，就会被自己建的规则持续卡住，
 * 而界面上没有任何撤收入口。
 */
function RulesPanel(): ReactElement {
  const [rules, setRules] = useState<ApprovalRuleView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = (): void => {
    fetchRules()
      .then((result) => { setRules(result.rules); setError(null) })
      .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setRules([]) })
  }

  useEffect(() => { load() }, [])

  const remove = (id: string): void => {
    setBusy(id)
    deleteRule(id)
      .then(() => load())
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(null))
  }

  const DECISION: Record<string, { label: string; color: string }> = {
    allow: { label: '放行', color: 'var(--success)' },
    deny: { label: '拒绝', color: 'var(--error)' },
    ask: { label: '询问', color: 'var(--warning)' },
  }

  return createElement('div', { className: 'dsh-card' },
    createElement('div', { className: 'dsh-card-header' },
      createElement('span', { className: 'dsh-card-title' }, '审批规则'),
      createElement('span', { className: 'dsh-hint' }, '命中优先于模式默认策略')),
    error !== null
      ? createElement('div', { className: 'dsh-task-callout err' }, Icon('alertTriangle', 13), error)
      : null,
    rules === null
      ? createElement('div', { className: 'dsh-hint' }, '读取中…')
      : rules.length === 0
        ? createElement('div', { className: 'dsh-hint' }, '（暂无规则——工具调用按当前审批模式弹卡）')
        : createElement('div', { className: 'dsh-rule-list' },
            rules.map((r) => {
              const d = DECISION[r.decision]
              return createElement('div', { className: 'dsh-rule-row', key: r.id },
                createElement('span', { className: 'dsh-mono', style: { fontSize: 12.5 } }, r.tool),
                r.pattern !== undefined && r.pattern.length > 0
                  ? createElement('span', { className: 'dsh-hint dsh-mono', title: r.pattern }, r.pattern)
                  : createElement('span', { className: 'dsh-hint' }, '全部调用'),
                createElement('span', {
                  style: { color: d !== undefined ? d.color : 'var(--ink-2)', fontSize: 12 },
                }, d !== undefined ? d.label : r.decision),
                createElement('span', { className: 'dsh-hint' }, r.scope === 'global' ? '全局' : '本次会话'),
                createElement('button', {
                  className: 'dsh-btn sm ghost', type: 'button', disabled: busy === r.id,
                  onClick: () => remove(r.id),
                  title: '撤销这条规则（同类调用恢复为按模式弹卡）',
                }, busy === r.id ? '撤销中…' : '撤销'))
            })))
}

const MEMORY_TYPE: Record<string, { label: string; color: string }> = {
  lesson: { label: '教训', color: 'var(--warning)' },
  pattern: { label: '模式', color: 'var(--info)' },
  decision: { label: '决策', color: 'var(--primary)' },
  fact: { label: '事实', color: 'var(--ink-2)' },
  episode: { label: '经历', color: '#a78bfa' },
}

/** 重要度圆点（1-5）；颜色随重要度加深，扫一眼能分出主次。 */
function ImportanceDots(props: { value: number }): ReactElement {
  const filled = Math.min(5, Math.max(0, props.value))
  return createElement('span', { className: 'dsh-mono', style: { fontSize: 12, letterSpacing: 1 }, title: `重要度 ${filled}/5` },
    '●'.repeat(filled) + '○'.repeat(5 - filled))
}

/**
 * 长期记忆面板（2.8.1 知识层）。
 * 此前这块只有工具面（pod_mem_*）能给 LLM 用，人完全够不着：agent 沉淀的经验
 * 看不到、也改不了。这里补上只读 + 重要度纠正。
 * 注意：MemoryStore 没有删除记录的接口（保留变更历史是可审计的前提），
 * 所以不提供删除——这一点在卡头如实写明，避免用户找“删不掉的按钮”。
 */
function MemoryPanel(): ReactElement {
  const [records, setRecords] = useState<MemoryRecordView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [ownerFilter, setOwnerFilter] = useState('')
  const [wf, setWf] = useState({ owner: '', type: 'fact' as MemoryType, importance: '3', tags: '', content_ref: '' })
  const [writing, setWriting] = useState(false)

  const load = (): void => {
    const owner = ownerFilter.trim()
    fetchMemories({ owner: owner.length > 0 ? owner : undefined, limit: 50 })
      .then((r) => { setRecords(r.records); setError(null) })
      .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setRecords([]) })
  }
  useEffect(() => { load() }, [ownerFilter])

  const write = (): void => {
    if (wf.owner.trim().length === 0) {
      setError('owner 必填：槽位 id 或 team:<mission_id>（团队复盘由 commander 收口）')
      return
    }
    setWriting(true)
    postMemory({
      owner_slot_id: wf.owner.trim(),
      type: wf.type,
      importance: Math.min(5, Math.max(1, Number(wf.importance) || 3)),
      tags: wf.tags.split(/[,，]/).map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 8),
      content_ref: wf.content_ref.trim() || undefined,
    })
      .then(() => { setWf({ owner: '', type: 'fact', importance: '3', tags: '', content_ref: '' }); load() })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setWriting(false))
  }

  const bump = (id: string, delta: number, current: number): void => {
    const next = Math.min(5, Math.max(1, current + delta))
    setBusy(id)
    postMemoryCorrect(id, { importance: next })
      .then(() => load())
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(null))
  }

  return createElement('div', { className: 'dsh-card' },
    createElement('div', { className: 'dsh-card-header' },
      createElement('span', { className: 'dsh-card-title' }, '长期记忆'),
      createElement('span', { className: 'dsh-hint' }, '可查看/写入/纠正；记录不可删除（保留变更历史）')),
    createElement('div', { className: 'dsh-mem-write', style: { display: 'grid', gap: 6, marginBottom: 10 } },
      createElement('div', { className: 'dsh-hint', style: { fontSize: 11 } }, '主动写入（不自动摘要）：owner 为槽位 id 或 team:<mission_id>（团队复盘由 commander 收口）'),
      createElement('div', { style: { display: 'flex', gap: 6 } },
        createElement('input', { className: 'dsh-input dsh-mono', placeholder: 'owner：S-1 或 team:M-1', value: wf.owner, onChange: (e: { target: { value: string } }) => setWf({ ...wf, owner: e.target.value }) }),
        createElement('select', { className: 'dsh-select', style: { flex: 'none' }, value: wf.type, onChange: (e: { target: { value: string } }) => setWf({ ...wf, type: e.target.value as MemoryType }) },
          (Object.entries(MEMORY_TYPE) as Array<[MemoryType, { label: string; color: string }]>).map(([k, v]) => createElement('option', { key: k, value: k }, v.label))),
        createElement('input', { className: 'dsh-input dsh-mono', style: { width: 64, flex: 'none' }, placeholder: '重要度', inputMode: 'numeric', value: wf.importance, onChange: (e: { target: { value: string } }) => setWf({ ...wf, importance: e.target.value }) }),
        createElement('button', { className: 'dsh-btn sm', type: 'button', disabled: writing, onClick: write }, writing ? '写入中…' : '写入')),
      createElement('input', { className: 'dsh-input dsh-mono', placeholder: '内容引用（文件/路径/摘要，非原始对话转录）', value: wf.content_ref, onChange: (e: { target: { value: string } }) => setWf({ ...wf, content_ref: e.target.value }) }),
      createElement('input', { className: 'dsh-input dsh-mono', placeholder: '标签（逗号分隔，≤8）', value: wf.tags, onChange: (e: { target: { value: string } }) => setWf({ ...wf, tags: e.target.value }) })),
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 } },
      createElement('span', { className: 'dsh-label', style: { flex: 'none' } }, '按 owner 筛选'),
      createElement('input', { className: 'dsh-input dsh-mono', style: { width: 240 }, placeholder: '槽位 id 或 team:<mission_id>（留空 = 全部）', value: ownerFilter, onChange: (e: { target: { value: string } }) => setOwnerFilter(e.target.value) })),
    error !== null
      ? createElement('div', { className: 'dsh-task-callout err' }, Icon('alertTriangle', 13), error)
      : null,
    records === null
      ? createElement('div', { className: 'dsh-hint' }, '读取中…')
      : records.length === 0
        ? createElement('div', { className: 'dsh-hint' }, '（暂无记忆——agent 走完反思后会自动沉淀）')
        : createElement('div', { className: 'dsh-mem-list' },
            records.map((r) => {
              const t = MEMORY_TYPE[r.type]
              return createElement('div', { className: 'dsh-mem-row', key: r.id },
                createElement('span', {
                  style: { color: t !== undefined ? t.color : 'var(--ink-2)', fontSize: 12, fontWeight: 500 },
                }, t !== undefined ? t.label : r.type),
                createElement(ImportanceDots, { value: r.importance }),
                createElement('div', { style: { minWidth: 0 } },
                  createElement('div', { className: 'dsh-mem-ref', title: r.content_ref }, r.content_ref),
                  createElement('div', { className: 'dsh-hint', style: { fontSize: 11 } },
                    `${r.owner_slot_id}　${r.tags.length > 0 ? r.tags.join(' / ') : '无标签'}`)),
                createElement('div', { style: { display: 'flex', gap: 4, flex: 'none' } },
                  createElement('button', {
                    className: 'dsh-btn sm ghost', type: 'button', title: '提高重要度',
                    disabled: busy === r.id || r.importance >= 5,
                    onClick: () => bump(r.id, 1, r.importance),
                  }, '+'),
                  createElement('button', {
                    className: 'dsh-btn sm ghost', type: 'button', title: '降低重要度',
                    disabled: busy === r.id || r.importance <= 1,
                    onClick: () => bump(r.id, -1, r.importance),
                  }, '−')))
            })))
}

/** 触发周期的人类可读形式（cron.json 里存的是 ms）。 */
function formatInterval(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min} 分钟`
  const hour = Math.round(min / 60)
  if (hour < 24) return `${hour} 小时`
  return `${Math.round(hour / 24)} 天`
}

/** 定时任务面板：此前只能靠 pod_cron_list 工具看，独立控制台上看不到下次何时触发。 */
function CronPanel(): ReactElement {
  const [jobs, setJobs] = useState<CronJobView[] | null>(null)
  const [recent, setRecent] = useState<CronFireView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const load = (): void => {
    fetchCron()
      .then((r) => { setJobs(r.jobs); setRecent(r.recent); setError(null) })
      .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setJobs([]) })
  }
  useEffect(() => { load() }, [])

  const startEdit = (): void => {
    const config = (jobs ?? []).map((j) => ({ id: j.id, intervalMs: j.intervalMs, enabled: j.enabled, label: j.label, command: j.command }))
    setDraft(JSON.stringify({ jobs: config }, null, 2))
    setEditing(true)
  }

  const save = (): void => {
    setSaving(true)
    try {
      const parsed = JSON.parse(draft) as { jobs?: unknown }
      saveCron(parsed.jobs)
        .then((r) => {
          if (!r.ok) { setError(r.message); return }
          setEditing(false)
          load()
        })
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setSaving(false))
    } catch (cause) {
      setError('JSON 解析失败：' + (cause instanceof Error ? cause.message : String(cause)))
      setSaving(false)
    }
  }

  return createElement('div', { className: 'dsh-card' },
    createElement('div', { className: 'dsh-card-header' },
      createElement('span', { className: 'dsh-card-title' }, '定时任务'),
      createElement('span', { className: 'dsh-hint' }, 'cron.json 改动后调用 pod_cron_list 即热加载'),
      createElement('button', {
        className: 'dsh-btn sm ghost', type: 'button', style: { marginLeft: 'auto' },
        onClick: startEdit,
      }, Icon('edit', 13), '编辑')),
    editing
      ? createElement('div', { style: { display: 'grid', gap: 8 } },
          createElement('textarea', {
            className: 'dsh-input dsh-mono', rows: 12,
            value: draft,
            onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
          }),
          createElement('div', { style: { display: 'flex', gap: 8 } },
            createElement('button', { className: 'dsh-btn primary sm', type: 'button', disabled: saving, onClick: save },
              saving ? '保存中…' : '保存并热加载'),
            createElement('button', { className: 'dsh-btn sm ghost', type: 'button', onClick: () => setEditing(false) }, '取消')),
          createElement('span', { className: 'dsh-hint' },
            'JSON 形状 { "jobs": [{ "id", "intervalMs"(毫秒), "enabled", "label"?, "command": { "kind": "status|launch|steer|approve|deny|pause|resume|abort", … } }] }；lastFiredAt 是运行态，保存时丢弃。'))
      : null,
    !editing && error !== null
      ? createElement('div', { className: 'dsh-task-callout err' }, Icon('alertTriangle', 13), error)
      : null,
    !editing && jobs === null
      ? createElement('div', { className: 'dsh-hint' }, '读取中…')
      : !editing && jobs !== null && jobs.length === 0
        ? createElement('div', { className: 'dsh-hint' }, '（暂无定时任务）')
        : !editing && jobs !== null
          ? createElement('div', { className: 'dsh-cron-list' },
              jobs.map((j) => createElement('div', { className: 'dsh-cron-row', key: j.id },
                createElement('div', { style: { minWidth: 0 } },
                  createElement('div', { style: { fontSize: 13, fontWeight: 500 } }, j.label ?? j.id),
                  createElement('div', { className: 'dsh-hint', style: { fontSize: 11 }, title: JSON.stringify(j.command) },
                    j.command.goal !== undefined ? `${j.command.kind}：${j.command.goal}` : j.command.kind)),
                createElement('span', { className: 'dsh-mono', style: { fontSize: 12, color: 'var(--ink-2)' } }, formatInterval(j.intervalMs)),
                createElement('span', { className: 'dsh-pill ' + (j.enabled ? 'done' : 'idle'), style: { fontSize: 11 } },
                  j.enabled ? '已启用' : '未启用'),
                createElement('span', { className: 'dsh-hint', style: { fontSize: 11 } },
                  j.lastFiredAt !== undefined ? '上次 ' + new Date(j.lastFiredAt).toLocaleString('zh-CN') : '尚未触发'))))
          : null,
    !editing && recent.length > 0
      ? createElement('div', { style: { marginTop: 12 } },
          createElement('div', { className: 'dsh-label', style: { marginBottom: 6 } }, '最近触发'),
          recent.map((f, i) => createElement('div', { className: 'dsh-cron-fire', key: i },
            createElement('span', { style: { color: f.fired ? 'var(--success)' : 'var(--ink-3)', flex: 'none' } }, f.fired ? '●' : '○'),
            createElement('span', { className: 'dsh-mono', style: { fontSize: 11.5, flex: 'none' } }, f.job_id),
            createElement('span', { className: 'dsh-hint', style: { fontSize: 11 } }, f.reason))))
      : null)
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
          createElement('div', { className: 'dsh-form-row', key: 'parallel' },
            createElement('span', { className: 'dsh-label' }, '并行执行上限（速度 × 成本）'),
            createElement('div', { className: 'dsh-seg', role: 'group', 'aria-label': '并行执行上限' },
              ['1', '2', '4', '8'].map((n) => createElement('button', {
                key: n, type: 'button', className: draft.parallel === n ? 'on' : '',
                onClick: () => patch({ parallel: n }),
              }, `${n} 路`))),
            createElement('span', { className: 'dsh-hint' }, '同时执行的 agent 任务数。并行越高墙钟越快，但 token 消耗与出错重试成本同步上升；2-4 适合多数仓库。')),
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
            createElement('span', { className: 'dsh-card-title' }, '团队宗旨'),
            createElement('span', { className: 'dsh-hint' }, 'mission 价值观锚点——派发时注入每个任务 spec 顶部，给 agent 取舍方向（缺省不注入）')),
          createElement('div', { className: 'dsh-form-row' },
            createElement('label', { className: 'dsh-label', htmlFor: 'set-tenets' }, '宗旨（每行一条，≤8 条）'),
            createElement('textarea', {
              id: 'set-tenets', className: 'dsh-input dsh-mono', rows: 4,
              placeholder: '优先可维护性：宁可多写两行说明，也别埋坑；先跑通再优化',
              value: draft.tenets.join('\n'),
              onChange: (e: { target: { value: string } }) =>
                patch({ tenets: e.target.value.split('\n').map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 8) }),
            }),
            createElement('span', { className: 'dsh-hint' }, '安全纪律由引擎三道防线保证，不靠口头；留空则不注入。')),
        ),
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
        createElement(RulesPanel),
        createElement(MemoryPanel),
        createElement(CronPanel),
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
