/**
 * 独立控制台 UI 入口（CR-38 P1）—— 不依赖 DSH 宿主槽位，
 * 直接 createRoot 挂 PodPanel（零 props，数据走同源 /api/dsh-pod/*）。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { PodPanel } from './PodPanel.js'

const root = document.getElementById('root')
if (root === null) throw new Error('standalone: #root 不存在（index.html 缺少挂载点）')
createRoot(root).render(createElement(PodPanel))
