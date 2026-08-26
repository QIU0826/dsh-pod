/**
 * 拓扑动画 + 自由画布 —— 方案书 4.3 roadmap v0.2（Berd-E 灰度 key: topology-animation）。
 *
 * 拓扑视图：按任务 depends_on 做分层布局（拓扑排序 → 层 = 最长依赖路径深度），
 * SVG 渲染 DAG：节点 = 任务（状态着色），边 = 依赖箭头（运行中节点脉冲高亮 + 流动虚线）。
 *
 * 自由画布：同一 SVG 上可拖拽节点位置（本地记忆）；支持「新建任务」输入框追加节点，
 * 手画 DAG 最小闭环（方案书 542/593 行）。纯展示组件（无副作用，不调用后端）。
 */
import { createElement, type ReactElement } from 'react'
import type { StatusTask } from './api.js'

const NODE_W = 150
const NODE_H = 52
const LAYER_GAP_X = 60
const LAYER_GAP_Y = 28
const PAD = 40

const STATUS_COLOR: Record<string, string> = {
  ready: '#94a3b8',
  dispatched: '#3b82f6',
  running: '#10b981',
  done: '#64748b',
  blocked: '#ef4444',
  escalated: '#f59e0b',
}

const STATUS_DOT: Record<string, string> = {
  ready: '#94a3b8',
  dispatched: '#3b82f6',
  running: '#22c55e',
  done: '#16a34a',
  blocked: '#dc2626',
  escalated: '#d97706',
}

export interface TopologyPoint {
  id: string
  x: number
  y: number
}

interface TopologyProps {
  tasks: StatusTask[]
  /** 可拖拽（自由画布模式）。 */
  draggable?: boolean
  /** 用户拖拽后回报的节点坐标（受控，仅本地 UI 状态）。 */
  positions?: Record<string, TopologyPoint>
  onMove?: (id: string, x: number, y: number) => void
  onAddTask?: (id: string, title: string) => void
  /** 已添加的草稿节点（自由画布手画 DAG）。 */
  draftTasks?: StatusTask[]
  draftPositions?: Record<string, TopologyPoint>
  onDraftMove?: (id: string, x: number, y: number) => void
  onDeleteDraft?: (id: string) => void
}

interface LayoutNode {
  id: string
  title: string
  status: string
  layer: number
  index: number
  x: number
  y: number
  draft: boolean
}

function topoLayer(tasks: StatusTask[], draftIds: Set<string>): Map<string, number> {
  const layer = new Map<string, number>()
  const byId = new Map(tasks.map((t) => [t.id, t]))
  // 迭代固定点（最长依赖路径深度），直到稳定
  let changed = true
  let guard = 0
  while (changed && guard < 50) {
    changed = false
    guard++
    for (const t of tasks) {
      const deps = t.depends_on.filter((d) => byId.has(d) || draftIds.has(d))
      const base = deps.length === 0 ? 0 : Math.max(...deps.map((d) => layer.get(d) ?? 0)) + 1
      if ((layer.get(t.id) ?? 0) < base) {
        layer.set(t.id, base)
        changed = true
      }
    }
  }
  return layer
}

function layoutTasks(
  tasks: StatusTask[],
  draft: StatusTask[],
  positions?: Record<string, TopologyPoint>,
  draftPositions?: Record<string, TopologyPoint>,
): { nodes: LayoutNode[]; edges: Array<{ from: string; to: string }>; w: number; h: number } {
  const draftIds = new Set(draft.map((d) => d.id))
  const layer = topoLayer(tasks, draftIds)
  const grouped = new Map<number, LayoutNode[]>()
  for (const t of tasks) {
    const l = layer.get(t.id) ?? 0
    if (!grouped.has(l)) grouped.set(l, [])
    grouped.get(l)!.push({ id: t.id, title: t.title, status: t.status, layer: l, index: 0, x: 0, y: 0, draft: false })
  }
  for (const d of draft) {
    const l = layer.get(d.id) ?? 0
    if (!grouped.has(l)) grouped.set(l, [])
    grouped.get(l)!.push({ id: d.id, title: d.title, status: "ready", layer: l, index: 0, x: 0, y: 0, draft: true })
  }
  const maxLayer = Math.max(0, ...[...grouped.keys()])
  let maxCols = 1
  for (const [, nodes] of grouped) {
    nodes.forEach((n, i) => (n.index = i))
    maxCols = Math.max(maxCols, nodes.length)
  }
  const w = PAD * 2 + (maxLayer + 1) * NODE_W + maxLayer * LAYER_GAP_X
  const h = PAD * 2 + maxCols * NODE_H + (maxCols - 1) * LAYER_GAP_Y
  const allPositions = { ...positions, ...draftPositions }
  for (const [, nodes] of grouped) {
    for (const n of nodes) {
      const saved = allPositions[n.id]
      if (saved !== undefined) {
        n.x = saved.x
        n.y = saved.y
      } else {
        n.x = PAD + n.layer * (NODE_W + LAYER_GAP_X)
        n.y = PAD + n.index * (NODE_H + LAYER_GAP_Y) + ((maxCols - (grouped.get(n.layer)?.length ?? 1)) * (NODE_H + LAYER_GAP_Y)) / 2
      }
    }
  }
  const edges: Array<{ from: string; to: string }> = []
  for (const t of tasks) {
    for (const d of t.depends_on) {
      if (draftIds.has(d) || tasks.some((x) => x.id === d)) edges.push({ from: d, to: t.id })
    }
  }
  for (const d of draft) {
    for (const dep of d.depends_on) {
      edges.push({ from: dep, to: d.id })
    }
  }
  return { nodes: [...grouped.values()].flat(), edges, w: Math.max(w, 340), h: Math.max(h, 160) }
}

function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const x1 = a.x + NODE_W / 2
  const y1 = a.y + NODE_H / 2
  const x2 = b.x + NODE_W / 2
  const y2 = b.y + NODE_H / 2
  const dx = Math.abs(x2 - x1)
  const bend = Math.max(24, dx / 2)
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
}

export function TopologyCanvas(props: TopologyProps): ReactElement {
  const { tasks, draftTasks = [], positions, onMove, draggable, draftPositions, onDraftMove, onAddTask, onDeleteDraft } = props
  const { nodes, edges, w, h } = layoutTasks(tasks, draftTasks, positions, draftPositions)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return createElement(
    'div',
    { style: { position: 'relative', overflow: 'auto', border: '1px solid var(--ds-color-border, rgba(0,0,0,.12))', borderRadius: 6 } },
    createElement(
      'svg',
      { width: w, height: h, style: { display: "block", minWidth: w } },
      createElement("defs", null,
        createElement("marker", { id: "pod-arrow", markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: "auto" },
          createElement("path", { d: "M0,0 L8,4 L0,8 z", fill: "rgba(100,116,139,.5)" }),
        ),
      ),
      edges.map((e) => {
        const a = byId.get(e.from)
        const b = byId.get(e.to)
        if (a === undefined || b === undefined) return null
        const isRunning = a.status === 'running' || b.status === 'running' || b.status === 'dispatched'
        return createElement("path", {
          key: `e-${e.from}-${e.to}`,
          d: edgePath(a, b),
          fill: "none",
          stroke: isRunning ? '#10b981' : 'rgba(100,116,139,.45)',
          strokeWidth: isRunning ? 2 : 1.2,
          strokeDasharray: isRunning ? '5 3' : undefined,
          className: isRunning ? 'pod-edge-running' : undefined,
          markerEnd: 'url(#pod-arrow)',
        })
      }),
      nodes.map((n) => {
        const color = STATUS_COLOR[n.status] ?? '#94a3b8'
        const dot = STATUS_DOT[n.status] ?? '#94a3b8'
        const isRunning = n.status === 'running' || n.status === 'dispatched'
        return createElement(
          'g',
          {
            key: n.id,
            style: { cursor: draggable ? "grab" : "default" },
            onMouseDown: draggable
              ? (ev: MouseEvent) => {
                  const startX = ev.clientX - n.x
                  const startY = ev.clientY - n.y
                  const move = (e2: MouseEvent): void => {
                    const nx = Math.max(0, e2.clientX - startX)
                    const ny = Math.max(0, e2.clientY - startY)
                    if (n.draft) onDraftMove?.(n.id, nx, ny)
                    else onMove?.(n.id, nx, ny)
                  }
                  const up = (): void => {
                    window.removeEventListener('mousemove', move)
                    window.removeEventListener('mouseup', up)
                  }
                  window.addEventListener('mousemove', move)
                  window.addEventListener('mouseup', up)
                }
              : undefined,
          },
          isRunning
            ? createElement('rect', { x: n.x - 3, y: n.y - 3, width: NODE_W + 6, height: NODE_H + 6, rx: 8, fill: 'none', stroke: '#10b981', strokeWidth: 2, opacity: 0.6, className: 'pod-node-pulse' })
            : null,
          createElement('rect', { x: n.x, y: n.y, width: NODE_W, height: NODE_H, rx: 8, fill: 'var(--ds-color-bg-2, rgba(0,0,0,.05))', stroke: color, strokeWidth: 1.5 }),
          createElement('text', { x: n.x + 8, y: n.y + 18, fontSize: 12, fontWeight: 600, fill: 'currentColor' }, n.id),
          createElement('text', { x: n.x + 8, y: n.y + 36, fontSize: 10, fill: 'var(--ds-color-text-2, #666)' }, truncate(n.title, 18)),
          createElement('circle', { cx: n.x + NODE_W - 12, cy: n.y + 12, r: 4, fill: dot }),
          n.draft && onDeleteDraft !== undefined
            ? createElement("text", { x: n.x + NODE_W - 12, y: n.y + NODE_H - 8, fontSize: 10, fill: "#ef4444", cursor: "pointer", onClick: () => onDeleteDraft(n.id), "aria-label": `删除草稿节点 ${n.id}` }, "✕")
            : null,
        )
      }),
    ),
    onAddTask !== undefined
      ? createElement('div', { style: { position: 'absolute', left: 8, top: 8, display: 'flex', gap: 6, alignItems: 'center', background: 'var(--ds-color-bg-1, #fff)', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--ds-color-border, rgba(0,0,0,.12))' } },
          createElement('span', { style: { fontSize: 11 } }, '手画 DAG：'),
          createElement('input', { id: 'pod-draft-id', style: { width: 90, fontSize: 11 }, placeholder: 'id (如 T-5)', 'aria-label': '草稿任务 id' }),
          createElement('input', { id: 'pod-draft-title', style: { width: 140, fontSize: 11 }, placeholder: '标题', 'aria-label': '草稿任务标题' }),
          createElement('button', { style: { fontSize: 11 }, onClick: () => {
            const idEl = document.getElementById('pod-draft-id') as HTMLInputElement | null
            const titleEl = document.getElementById('pod-draft-title') as HTMLInputElement | null
            const id = idEl?.value.trim() ?? ''
            const title = titleEl?.value.trim() ?? ''
            if (id.length === 0 || title.length === 0) return
            onAddTask(id, title)
            if (idEl !== null) idEl.value = ''
            if (titleEl !== null) titleEl.value = ''
          } }, "添加节点"),
        )
      : null,
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}
