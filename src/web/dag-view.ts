/**
 * DAG 拓扑视图（设计稿「DAG 拓扑图」屏）：分层自动布局 + 箭头边 + 状态描边节点 +
 * 右上图例 + 右下检查器（点选节点看详情）。SVG innerHTML 注入 + 事件委托。
 */
import { createElement, useMemo, useState, type ReactElement } from 'react'
import type { StatusTask } from './api.js'
import { Icon } from './icons.js'
import { TASK_STATUS_LABEL, TASK_TYPE_LABEL, shortSlotId } from './view-helpers.js'

const NODE_W = 150
const NODE_H = 64
const GAP_X = 74
const GAP_Y = 36

const STROKE: Record<string, string> = {
  done: 'var(--success)',
  running: 'var(--primary)',
  dispatched: 'var(--primary)',
  negotiating: '#8b5cf6',
  accepted: '#8b5cf6',
  paused: '#64748b',
  blocked: 'var(--error)',
  rejected: 'var(--error)',
  escalated: 'var(--warning)',
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] as string)
}

/** 分层（最长路径深度），依赖缺失节点不炸。 */
function layerOf(tasks: StatusTask[], id: string, seen: Set<string> = new Set()): number {
  if (seen.has(id)) return 0
  seen.add(id)
  const task = tasks.find((t) => t.id === id)
  if (task === undefined || task.depends_on.length === 0) return 0
  return 1 + Math.max(...task.depends_on.map((dep) => layerOf(tasks, dep, seen)))
}

export function DagView(props: { tasks: StatusTask[] }): ReactElement {
  const { tasks } = props
  const [selectedId, setSelectedId] = useState('')
  const selected = tasks.find((t) => t.id === selectedId)

  const { inner, width, height } = useMemo(() => {
    if (tasks.length === 0) return { inner: '', width: 800, height: 400 }
    const layers = new Map<number, StatusTask[]>()
    for (const t of tasks) {
      const depth = layerOf(tasks, t.id)
      const bucket = layers.get(depth) ?? []
      bucket.push(t)
      layers.set(depth, bucket)
    }
    const maxLayer = Math.max(...layers.keys())
    const byId = new Map(tasks.map((t) => [t.id, { x: 0, y: 0 }]))
    for (const [depth, bucket] of layers) {
      bucket.forEach((t, i) => {
        byId.set(t.id, { x: 40 + depth * (NODE_W + GAP_X), y: 40 + i * (NODE_H + GAP_Y) })
      })
    }
    let maxBottom = 0
    for (const pos of byId.values()) maxBottom = Math.max(maxBottom, pos.y + NODE_H)
    const svgHeight = maxBottom + 40
    const svgWidth = 40 + (maxLayer + 1) * (NODE_W + GAP_X) + 40

    const edges: string[] = []
    for (const t of tasks) {
      const from = byId.get(t.id)
      if (from === undefined) continue
      for (const dep of t.depends_on) {
        const to = byId.get(dep)
        if (to === undefined) continue
        const x1 = to.x + NODE_W
        const y1 = to.y + NODE_H / 2
        const x2 = from.x
        const y2 = from.y + NODE_H / 2
        const mx = (x1 + x2) / 2
        edges.push(`<path class="dag-edge" d="M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" marker-end="url(#dsh-arrow)"/>`)
      }
    }
    const nodes = tasks.map((t) => {
      const pos = byId.get(t.id)!
      const st = STROKE[t.status] ?? 'var(--line)'
      const pulse = t.status === 'running' || t.status === 'dispatched' ? ' pulse' : ''
      const dot = t.status === 'done' ? 'var(--success)' : t.status === 'blocked' ? 'var(--error)' : t.status === 'escalated' ? 'var(--warning)' : STROKE[t.status] ?? 'var(--ink-3)'
      const check = t.status === 'done' ? `<path d="M${NODE_W - 34} 26 l6 6 12-12" fill="none" stroke="var(--success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` : ''
      const title = t.title.length > 12 ? `${t.title.slice(0, 11)}…` : t.title
      return `<g class="dsh-dag-node${pulse}" data-id="${escapeXml(t.id)}" transform="translate(${pos.x},${pos.y})" role="button" tabindex="0" aria-label="${escapeXml(t.id)} ${escapeXml(title)}">
        <rect class="node-bg st-${t.status}" width="${NODE_W}" height="${NODE_H}" rx="8" style="stroke:${st}"/>
        <circle cx="12" cy="12" r="4" style="fill:${dot}"/>
        <text class="node-id" x="24" y="16">${escapeXml(t.id)}</text>
        <text class="node-title" x="12" y="36">${escapeXml(title)}</text>
        <text class="node-agent" x="12" y="52">${escapeXml(t.owner !== null ? shortSlotId(t.owner) : TASK_TYPE_LABEL[t.type] ?? t.type)}</text>
        ${check}
      </g>`
    })
    return {
      inner: `<defs><marker id="dsh-arrow" markerWidth="10" markerHeight="8" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="var(--ink-3)"/></marker></defs>${edges.join('')}${nodes.join('')}`,
      width: Math.max(800, svgWidth),
      height: svgHeight,
    }
  }, [tasks])

  if (tasks.length === 0) {
    return createElement('div', { className: 'dsh-view' },
      createElement('div', { className: 'dsh-empty' },
        Icon('network', 24),
        createElement('div', { className: 'dsh-empty-title' }, '暂无任务 DAG'),
        createElement('div', { className: 'dsh-empty-sub' }, '发射会话后，planner 分解出的任务图会在这里渲染')))
  }

  return createElement('div', { className: 'dsh-dag-wrap' },
    createElement('svg', {
      className: 'dsh-dag-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img',
      'aria-label': '任务依赖拓扑图',
      dangerouslySetInnerHTML: { __html: inner },
      onClick: (e: { target: Element }) => {
        const g = (e.target as Element).closest('.dsh-dag-node')
        setSelectedId(g !== null ? g.getAttribute('data-id') ?? '' : '')
      },
    }),
    createElement('div', { className: 'dsh-float dsh-legend' },
      createElement('div', { style: { fontSize: 12, fontWeight: 600 } }, '图例'),
      ['done|完成', 'running|执行中', 'negotiating|协商中', 'paused|已暂停', 'blocked|受阻', 'escalated|转人工', 'ready|待办'].map((pair) => {
        const parts = pair.split('|')
        const st = parts[0] ?? ''
        const label = parts[1] ?? ''
        return createElement('div', { className: 'row', key: st },
          createElement('span', { className: 'dsh-dot', style: { background: STROKE[st] ?? 'var(--ink-3)' } }),
          label)
      })),
    selected !== undefined
      ? createElement('div', { className: 'dsh-float dsh-inspector', key: selected.id },
          createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } },
            createElement('span', { className: 'dsh-mono', style: { fontSize: 12.5 } }, selected.id),
            createElement('button', { className: 'dsh-btn sm icon', type: 'button', 'aria-label': '关闭', onClick: () => setSelectedId('') }, Icon('x', 13))),
          createElement('div', { style: { fontSize: 14, fontWeight: 600, lineHeight: 1.5 } }, selected.title),
          createElement('div', { className: 'dsh-kvrow' }, createElement('span', null, '类型'), createElement('span', null, TASK_TYPE_LABEL[selected.type] ?? selected.type)),
          createElement('div', { className: 'dsh-kvrow' }, createElement('span', null, '状态'), createElement('span', null, TASK_STATUS_LABEL[selected.status] ?? selected.status)),
          createElement('div', { className: 'dsh-kvrow' }, createElement('span', null, 'Slot'), createElement('span', null, selected.owner !== null ? shortSlotId(selected.owner) : '—')),
          createElement('div', { className: 'dsh-kvrow' }, createElement('span', null, 'Commit'), createElement('span', { className: 'dsh-mono' }, selected.commit ?? '—')),
          createElement('div', { className: 'dsh-kvrow' }, createElement('span', null, '重试'), createElement('span', null, `${selected.attempts} 次`)),
          selected.depends_on.length > 0
            ? createElement('div', { className: 'dsh-kvrow' }, createElement('span', null, '依赖'), createElement('span', { className: 'dsh-mono' }, selected.depends_on.join(', ')))
            : null,
          selected.fault !== null
            ? createElement('div', { className: 'dsh-task-callout err', style: { marginTop: 8, marginBottom: 0 } }, Icon('alertTriangle', 13), selected.fault)
            : null)
      : null)
}
