/**
 * Q 版娘化形象预览页生成脚本。
 * 用法：npx vitest run scripts/avatars-preview.gen.ts
 * 输出：/d/tmp/dsh-pod-chibi-preview.html
 * 每行展示一个 harness 在 6 个核心状态下的 SVG + 状态色光晕，便于肉眼检查动作流程性。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { Avatar, avatarMotion, AVATAR_OPTIONS } from '../src/web/avatars.js'
import { CONSOLE_CSS } from '../src/web/console-css.js'

const chibiIds = ['claude', 'gpt', 'codex', 'opencode', 'ark', 'dsh'] as const
const statuses = ['idle', 'working', 'dispatched', 'negotiating', 'accepted', 'waiting_approval', 'error', 'rejected', 'paused', 'rate_limited', 'done'] as const

const rows = chibiIds.map((id) => {
  const label = AVATAR_OPTIONS.find((a) => a.id === id)?.label ?? id
  const cells = statuses.map((status) => {
    const svg = renderToStaticMarkup(Avatar(id, status, 64, true))
    const motion = avatarMotion(status)
    return `<div class="cell"><div class="status">${status}</div><div class="avatar">${svg}</div><div class="motion">${motion}</div></div>`
  }).join('')
  return `<div class="row"><div class="label">${label}</div>${cells}</div>`
}).join('')

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-pod Q 版娘化形象预览</title>
<style>
:root { --bg: #0b0b0f; --surface-1: #13131a; --line: #272730; --ink: #e8e8ec; --ink-2: #90909d; }
body { margin: 0; padding: 24px; background: var(--bg); color: var(--ink); font: 14px/1.6 Inter, "Noto Sans SC", system-ui, sans-serif; }
h1 { font-size: 18px; margin: 0 0 16px; }
.row { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; padding: 12px; background: var(--surface-1); border: 1px solid var(--line); border-radius: 12px; }
.label { width: 110px; flex: none; font-weight: 600; color: var(--ink); }
.cell { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px; background: rgba(255,255,255,.03); border-radius: 8px; }
.status { font-size: 11px; color: var(--ink-2); }
.motion { font-size: 10px; color: var(--ink-2); opacity: .8; }
${CONSOLE_CSS}
</style>
</head>
<body>
<h1>Q 版娘化形象 × 工作状态动画预览</h1>
<p style="color:var(--ink-2);font-size:12px;margin-top:-8px;margin-bottom:20px;">每个角色 64px，展示 idle/work/lean/look/shake/sleep 等状态类与状态色边框/光晕。动作关键帧在 console-css.ts 中按部位驱动。</p>
${rows}
</body>
</html>`

const outPath = '/d/tmp/dsh-pod-chibi-preview.html'
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, html, 'utf-8')
console.log(`✅ preview written: ${outPath}`)
