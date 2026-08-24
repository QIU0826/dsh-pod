/**
 * 浏览器半入口 —— dsh-pod 的 Mission Canvas 挂载（沿 dsh-ssh 实证模式）：
 *   - 侧边栏入口行（纯 DOM，self-heal）
 *   - 中心栏面板（React 根挂入 `[data-pane="conversation"], [class*="centerCol"]`，
 *     打开时经 html data 属性隐藏会话内容，单占用：dsh-panel-activate 协同）
 * 失败策略：DOM 挂载问题只降级不抛出（web shell 因插件 apply 抛错会整机失败）。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PodPanel } from './PodPanel.js'

const NS = 'dsh-pod'

export type PodLocaleKey = 'pod.name' | 'pod.wip'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-pod': PodLocaleKey
  }
}

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['locale']

const SIDEBAR_ENTRY_SELECTOR = '[data-dsh-pod-entry]'
const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
const ACTIVE_ATTR = 'data-dsh-pod-active'
const OTHER_ACTIVE_ATTR = 'data-dsh-taskboard-active'
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'pod'

const ENTRY_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><circle cx="5" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="5" r="1.2" fill="currentColor"/><circle cx="11" cy="8" r="1.2" fill="currentColor"/></svg>'

/** 侧边栏入口（纯 DOM；frame 迟到时由 interval self-heal，沿 dsh-ssh 思路的最小实现）。 */
function mountSidebarEntry(toggle: () => void): () => void {
  const ensure = (): void => {
    if (document.querySelector(SIDEBAR_ENTRY_SELECTOR) !== null) return
    const nav = document.querySelector('nav[class*="sidebar"], [class*="sidebarNav"], [data-testid*="sidebar"]')
    if (nav === undefined || nav === null) return
    const row = document.createElement('button')
    row.dataset.dshPodEntry = ''
    row.style.cssText =
      'display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;background:none;border:none;cursor:pointer;font:inherit;color:inherit;'
    row.innerHTML = `${ENTRY_ICON}<span>Pod</span>`
    row.title = 'Pod 鲸群'
    row.addEventListener('click', toggle)
    nav.appendChild(row)
  }
  ensure()
  const timer = setInterval(ensure, 1500)
  return () => {
    clearInterval(timer)
    document.querySelectorAll(SIDEBAR_ENTRY_SELECTOR).forEach((node) => node.remove())
  }
}

/** 中心栏 Canvas 面板（React 根 + html 可见性切换 + self-heal）。 */
function mountPanel(open: () => boolean, onToggle: (next: boolean) => void): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const ensure = (): void => {
    if (container !== undefined) {
      if (container.isConnected) return
      root?.unmount()
      root = undefined
      container.remove()
      container = undefined
    }
    const column = document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR)
    if (column === undefined || column === null) return
    container = document.createElement('div')
    container.dataset.dshPodView = ''
    container.style.cssText = 'position:relative;height:100%;display:none;'
    column.appendChild(container)
    root = createRoot(container)
    root.render(createElement(PodPanel))
  }

  const waitObserver = new MutationObserver(() => {
    ensure()
  })
  waitObserver.observe(document.body, { childList: true, subtree: true })
  ensure()

  const applyVisible = (): void => {
    if (container === undefined) return
    const visible = open()
    container.style.display = visible ? 'block' : 'none'
    if (visible) {
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.documentElement.removeAttribute(OTHER_ACTIVE_ATTR)
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
  }
  // 跨插件激活协同：其他面板（如任务看板）打开时让位
  const onActivate = (event: Event): void => {
    const name = (event as CustomEvent<string>).detail
    if (name !== PANEL_NAME && name !== undefined) onToggle(false)
    applyVisible()
  }
  document.addEventListener(ACTIVATE_EVENT, onActivate)
  applyVisible()

  const visibilityTimer = setInterval(applyVisible, 1000)
  return () => {
    clearInterval(visibilityTimer)
    waitObserver.disconnect()
    document.removeEventListener(ACTIVATE_EVENT, onActivate)
    root?.unmount()
    container?.remove()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
  }
}

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () =>
      ctx.locale.register(NS, {
        zh: {
          'pod.name': 'Pod 鲸群',
          'pod.wip': '多智能体驾驶舱：一键组队、看得见、管得住',
        },
        en: {
          'pod.name': 'Pod',
          'pod.wip': 'Multi-agent cockpit: launch, watch, govern',
        },
      }),
    'dsh-pod: dictionaries',
  )

  let panelOpen = false
  const toggle = (): void => {
    panelOpen = !panelOpen
    document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    document.documentElement.setAttribute(ACTIVE_ATTR, '')
    panelOpen = true
  }
  const disposers: Array<() => void> = []
  try {
    disposers.push(mountSidebarEntry(toggle))
    disposers.push(
      mountPanel(
        () => panelOpen,
        (next) => {
          panelOpen = next
        },
      ),
    )
  } catch (error) {
    // DOM 挂载失败只降级不抛出（web shell 整机失败对策，dsh-ssh 同策略）
    console.warn('[dsh-pod] surface mount failed:', error)
  }
  ctx.effect(
    () => () => {
      for (const dispose of disposers.splice(0)) dispose()
    },
    'dsh-pod: ui mounts',
  )
}
