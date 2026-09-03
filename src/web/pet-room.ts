/**
 * 桌宠房间视图（学习 dsh-web/dsh-pet 的桌宠设计，2026-09-02 用户预设）：
 * 一个大房间里有很多桌宠，每个桌宠 = 一个 harness（dsh/claude/codex/ark/opencode），
 * 实时显示工作状态动画 + 任务气泡。
 *
 * 状态映射（dsh-pod 语义 → PetPhase，学习 dsh-pet 的 phase→animation 契约）：
 *   slot idle/无任务 → idle（房间内悠闲呼吸/挥手）
 *   任务 negotiating/accepted → waiting（期待观望）
 *   任务 running + review 类型 → review（翻阅审查）
 *   任务 running + 最新事件 tool_call → tool（工具跑动）
 *   任务 running（其余）→ thinking（来回踱步思考）
 *   任务 ready/blocked 前的等待 → waiting
 *   任务 blocked/escalated、slot error → failed（趴下）
 *   mission awaiting_approval → waiting（全员等主人指令）
 *
 * 桌宠外观：同一鲸鱼娘 atlas + vendor 品牌色滤镜（hue-rotate 变体）区分 harness；
 * 名牌显示 vendor/role/model；气泡显示当前任务与最新进度（成本可见）。
 */
import { createElement, useState, type ReactElement } from 'react'
import { PetSprite, type PetPhase } from './pet-sprite.js'
import type { PodEvent, StatusResponse, StatusSlot, StatusTask } from './api.js'
import { fmtTokens, shortSlotId } from './view-helpers.js'

/** vendor → 桌宠色滤镜（品牌区分：同一鲸鱼娘的配色变体）。 */
const VENDOR_FILTER: Record<string, string> = {
  claude: 'none',
  codex: 'hue-rotate(200deg)',
  ark: 'hue-rotate(90deg) saturate(1.25)',
  opencode: 'hue-rotate(300deg)',
  dsh: 'hue-rotate(45deg) saturate(1.1)',
}

const VENDOR_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  ark: 'Ark',
  opencode: 'OpenCode',
  dsh: 'DSH',
}

const PHASE_LABEL: Record<PetPhase, string> = {
  idle: '休息中',
  thinking: '思考中',
  tool: '调用工具',
  review: '审查中',
  waiting: '等待中',
  done: '完成啦',
  failed: '出状况了',
}

/**
 * 槽位 → 桌宠 phase（纯函数，单测覆盖）。
 * @param latestEventKind 该槽位当前任务的最新 worker_progress kind（'tool_call' | 'text' | undefined）
 */
export function slotPhase(
  slot: StatusSlot,
  task: StatusTask | undefined,
  missionStatus: string | null,
  latestEventKind?: string,
): PetPhase {
  if (slot.status === 'error') return 'failed'
  if (slot.status === 'rate_limited') return 'waiting'
  if (task === undefined) {
    // 无任务：等审批时全员「等待主人」，否则悠闲
    return missionStatus === 'awaiting_approval' ? 'waiting' : 'idle'
  }
  switch (task.status) {
    case 'running':
      if (task.type === 'review') return 'review'
      return latestEventKind === 'tool_call' ? 'tool' : 'thinking'
    case 'negotiating':
    case 'accepted':
    case 'dispatched':
      return 'waiting'
    case 'ready':
    case 'paused':
      return 'waiting'
    case 'blocked':
    case 'escalated':
      return 'failed'
    default:
      return 'idle'
  }
}

/** 从事件流提取每任务最新的 worker_progress kind + 文本（气泡内容）。 */
export function latestProgressByTask(events: PodEvent[]): Map<string, { kind: string; text: string }> {
  const map = new Map<string, { kind: string; text: string }>()
  for (const e of events) {
    if (e.kind !== 'worker_progress' || e.task_id === undefined) continue
    const p = (e.payload ?? {}) as { kind?: string; text?: string; tool?: string }
    map.set(e.task_id, {
      kind: p.kind ?? '',
      text: p.kind === 'tool_call' ? '🛠 ' + (p.tool ?? '') : (p.text ?? '').slice(0, 120),
    })
  }
  return map
}

function taskOfSlot(status: StatusResponse, slot: StatusSlot): StatusTask | undefined {
  // 槽位当前任务：owner 精确匹配；否则该 slot 的活任务（协商/派发中的 owner 可能在途）
  return (
    status.tasks.find((t) => t.owner === slot.id && ['running', 'negotiating', 'accepted', 'dispatched'].includes(t.status)) ??
    status.tasks.find((t) => t.owner === slot.id && ['blocked', 'escalated', 'ready'].includes(t.status))
  )
}

function bubbleText(task: StatusTask | undefined, progress: { kind: string; text: string } | undefined, phase: PetPhase): string {
  if (task === undefined) return phase === 'waiting' ? '等主人下令…' : '空闲'
  const head = task.title.length > 24 ? task.title.slice(0, 24) + '…' : task.title
  if (progress !== undefined && progress.text.length > 0 && (phase === 'thinking' || phase === 'tool' || phase === 'review')) {
    const body = progress.text.length > 60 ? progress.text.slice(0, 60) + '…' : progress.text
    return head + '\n' + body
  }
  if (phase === 'failed' && task.last_error !== undefined && task.last_error !== null) {
    return head + '\n⚠ ' + task.last_error.slice(0, 60)
  }
  return head
}

export interface PetRoomViewProps {
  status: StatusResponse | null
  events: PodEvent[]
  /** steer 指令注入（戳桌宠 → 详情卡 → 输入答复/指令，员工下次派单必带）。 */
  onSteer?: (slotId: string, instruction: string) => void
}

/** 桌宠分区：出状况（最显眼）→ 忙碌 → 待命。返回分区 key。 */
export function zoneOf(phase: PetPhase): 'alert' | 'busy' | 'rest' {
  if (phase === 'failed') return 'alert'
  if (phase === 'thinking' || phase === 'tool' || phase === 'review') return 'busy'
  return 'rest'
}

const ZONE_LABEL: Record<'alert' | 'busy' | 'rest', string> = {
  alert: '⚠ 出状况（需主人关照）',
  busy: '🐾 工作中',
  rest: '☁ 休息 / 待命',
}
const ZONE_ORDER: ReadonlyArray<'alert' | 'busy' | 'rest'> = ['alert', 'busy', 'rest']

/** 桌宠房间：每个 harness 槽位一只鲸鱼娘桌宠，戳一下看详情并可发 steer 指令。 */
export function PetRoomView(props: PetRoomViewProps): ReactElement {
  const { status, events, onSteer } = props
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null)
  const [steerText, setSteerText] = useState('')
  const progress = latestProgressByTask(events)

  // 多房间分区：出状况的排最前（最需要主人关注），空区不渲染
  const zones = new Map<'alert' | 'busy' | 'rest', ReactElement[]>()
  if (status !== null && status.slots.length > 0) {
    for (const slot of status.slots) {
      const task = taskOfSlot(status, slot)
      const latest = task !== undefined ? progress.get(task.id) : undefined
      const phase = slotPhase(slot, task, status.mission?.status ?? null, latest?.kind)
      const filter = VENDOR_FILTER[slot.vendor] ?? 'grayscale(0.4)'
      const vendor = VENDOR_LABEL[slot.vendor] ?? slot.vendor
      const tokens = (slot.tokens_in ?? 0) + (slot.tokens_out ?? 0)
      const selected = selectedSlotId === slot.id
      const station = createElement(
        'div',
        {
          key: slot.id,
          className: 'dsh-pet-station' + (selected ? ' selected' : ''),
          onClick: () => {
            setSelectedSlotId(selected ? null : slot.id)
            setSteerText('')
          },
          title: '戳一下看详情 / 发指令',
        },
        createElement(
          'div',
          { className: 'dsh-pet-bubble' + (phase === 'failed' ? ' bad' : phase === 'tool' || phase === 'thinking' ? ' busy' : '') },
          createElement('pre', null, bubbleText(task, latest, phase)),
        ),
        createElement(PetSprite, { phase, size: 128, filter, className: 'dsh-pet-sprite' }),
        createElement('div', { className: 'dsh-pet-shadow' }),
        createElement(
          'div',
          { className: 'dsh-pet-nameplate' },
          createElement('span', { className: 'dsh-pet-vendor' }, vendor),
          createElement('span', { className: 'dsh-pet-role' }, slot.role),
          createElement('span', { className: 'dsh-pet-meta' }, PHASE_LABEL[phase] + (tokens > 0 ? ' · ' + fmtTokens(tokens) : '')),
        ),
        selected ? petDetailCard(slot, task, latest, phase, tokens, steerText, setSteerText, onSteer) : null,
      )
      const zone = zoneOf(phase)
      const list = zones.get(zone) ?? []
      list.push(station)
      zones.set(zone, list)
    }
  }

  const empty =
    status === null
      ? '连接中…'
      : status.slots.length === 0
        ? '还没有员工入队——发起一个 mission，桌宠们就会搬进来住啦'
        : ''

  return createElement(
    'div',
    { className: 'dsh-pet-room' },
    createElement('div', { className: 'dsh-pet-room-wall' }),
    createElement('div', { className: 'dsh-pet-room-floor' }),
    createElement('div', { className: 'dsh-pet-room-title' }, status?.mission?.name ?? 'Pod 鲸群 · 桌宠房间'),
    ...ZONE_ORDER.filter((z) => (zones.get(z)?.length ?? 0) > 0).map((z) =>
      createElement(
        'div',
        { key: z, className: 'dsh-pet-zone' },
        createElement('div', { className: 'dsh-pet-zone-title ' + z }, ZONE_LABEL[z]),
        createElement('div', { className: 'dsh-pet-room-grid' }, ...(zones.get(z) ?? [])),
      ),
    ),
    empty.length > 0 ? createElement('div', { className: 'dsh-pet-room-empty' }, empty) : null,
    createElement(
      'div',
      { className: 'dsh-pet-room-legend' },
      '桌宠 = harness 员工 · 戳一下看详情/发指令 · ' + (status !== null ? shortSlotId(String(status.slots.length)) + ' 只在住' : ''),
    ),
  )
}

/** 选中桌宠展开的详情卡：任务/进度/成本 + steer 指令输入（学习 dsh-pet 的点击交互，09-02 待办）。 */
function petDetailCard(
  slot: StatusSlot,
  task: StatusTask | undefined,
  latest: { kind: string; text: string } | undefined,
  phase: PetPhase,
  tokens: number,
  steerText: string,
  setSteerText: (t: string) => void,
  onSteer?: (slotId: string, instruction: string) => void,
): ReactElement {
  const rows: Array<{ label: string; value: string }> = [
    { label: '角色', value: slot.role + (slot.model !== undefined && slot.model.length > 0 ? ' · ' + slot.model : '') },
    { label: '状态', value: PHASE_LABEL[phase] },
    { label: '成本', value: tokens > 0 ? fmtTokens(tokens) + ' tokens' : '—' },
  ]
  if (task !== undefined) {
    rows.push({ label: '任务', value: task.title })
    rows.push({ label: '任务态', value: task.status + (task.attempts > 0 ? ` · 第 ${task.attempts + 1} 次尝试` : '') })
    if (task.commit !== null && task.commit !== undefined && task.commit.length > 0) rows.push({ label: 'commit', value: task.commit.slice(0, 7) })
    if (task.last_error !== undefined && task.last_error !== null && String(task.last_error).length > 0) {
      rows.push({ label: '最近故障', value: String(task.last_error).slice(0, 120) })
    }
    if (latest !== undefined && latest.text.length > 0) rows.push({ label: '最新进度', value: latest.text })
  }
  return createElement(
    'div',
    {
      className: 'dsh-pet-detail',
      // 阻止冒泡：点卡片内部（输入框/按钮）不收起卡片
      onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
    },
    createElement(
      'div',
      { className: 'dsh-pet-detail-rows' },
      ...rows.map((r) =>
        createElement('div', { key: r.label, className: 'dsh-pet-detail-row' },
          createElement('span', { className: 'dsh-pet-detail-label' }, r.label),
          createElement('span', { className: 'dsh-pet-detail-value' }, r.value),
        ),
      ),
    ),
    createElement(
      'div',
      { className: 'dsh-pet-detail-steer' },
      createElement('input', {
        className: 'dsh-pet-detail-input',
        placeholder: '给这位员工发指令/答复（下次派单必带）…',
        value: steerText,
        onChange: (e: { target: { value: string } }) => setSteerText(e.target.value),
        onKeyDown: (e: { key: string; preventDefault: () => void }) => {
          if (e.key !== 'Enter' || steerText.trim().length === 0) return
          e.preventDefault()
          onSteer?.(slot.id, steerText.trim())
          setSteerText('')
        },
      }),
      createElement(
        'button',
        {
          className: 'dsh-pet-detail-send',
          disabled: steerText.trim().length === 0,
          onClick: () => {
            if (steerText.trim().length === 0) return
            onSteer?.(slot.id, steerText.trim())
            setSteerText('')
          },
        },
        '发送',
      ),
    ),
  )
}
