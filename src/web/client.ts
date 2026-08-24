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

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
const ACTIVE_ATTR = 'data-dsh-pod-active'
const OTHER_ACTIVE_ATTR = 'data-dsh-taskboard-active'
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'pod'

const ENTRY_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><circle cx="5" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="5" r="1.2" fill="currentColor"/><circle cx="11" cy="8" r="1.2" fill="currentColor"/></svg>'

/**
 * 侧边栏入口 —— 按 shell 真实结构挂载（dsh-ssh sidebar-entry-core 实证：
 * 入口行插在 New Session 按钮之后；MutationObserver self-heal 防 React 重渲染位移）。
 * 纯 DOM 行（不参与 shell 协调）；语义属性 data-dsh-plugin="pod" + data-dsh-part="sidebar-entry"。
 */
const SIDEBAR_COLUMN_SELECTOR = '[data-pane="sidebar"], [class*="sidebarCol"]'
const FAMILY_SELECTORS = ['[data-dsh-pod-entry]', '[data-dsh-ssh-entry]', '[data-dsh-taskboard-entry]']

function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>(SIDEBAR_COLUMN_SELECTOR)
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

function createPodEntry(onToggle: () => void): HTMLButtonElement {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.dshPodEntry = ''
  entry.setAttribute('data-dsh-plugin', 'pod')
  entry.setAttribute('data-dsh-part', 'sidebar-entry')
  entry.setAttribute('aria-label', 'Pod 鲸群')
  entry.title = 'Pod 鲸群'
  entry.style.cssText =
    'display:flex;align-items:center;gap:6px;width:100%;padding:6px 10px;background:none;border:none;cursor:pointer;font:inherit;color:inherit;text-align:left;'
  entry.innerHTML = `<span>${ENTRY_ICON}</span><span>Pod</span>`
  entry.addEventListener('click', onToggle)
  return entry
}

function placePodEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    const row = button.closest('[class*="logoRow"]')
    const base = row !== null && row.parentElement === root ? row : button
    const family = Array.from(root.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.matches(FAMILY_SELECTORS.join(', ')),
    )
    const anchor = family.length > 0 ? family[family.length - 1]!.nextElementSibling : base.nextElementSibling
    root.insertBefore(entry, anchor)
  }
  return true
}

function mountSidebarEntry(onToggle: () => void): () => void {
  if (document.querySelector('[data-dsh-pod-entry]') !== null) return () => {}
  const entry = createPodEntry(onToggle)
  let root: HTMLElement | undefined
  let placed = false

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placePodEntry(root, entry)
    if (placed) rootObserver.observe(root, { childList: true, subtree: true })
  }

  const waitObserver = new MutationObserver(() => {
    tryPlace()
  })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) placed = placePodEntry(root, entry)
  })

  tryPlace()
  return () => {
    waitObserver.disconnect()
    rootObserver.disconnect()
    entry.remove()
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
