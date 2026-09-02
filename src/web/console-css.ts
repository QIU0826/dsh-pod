/**
 * 控制台设计系统（唯一事实源）—— 2026-08-29 重设计版（外部设计稿：dark cockpit / cyan）。
 *
 * Token 与组件形态 1:1 落自设计稿（会话列表/对话/看板/DAG/审批/问答/设置 七屏）：
 * 深色近黑地面 + 青色主色；表面三级（#13131a/#1c1c25/#252532）+ 1px 冷线分层；
 * 语义状态色只用于状态；数据一律等宽。无 Tailwind 运行时——本文件即全部样式。
 *
 * standalone 壳静态内联本字符串；DSH 宿主形态由 PodPanel 挂载注入（id pod-console-css）。
 */
export const CONSOLE_CSS = `
.dsh-root, .dsh-root * { box-sizing: border-box; }
.dsh-root {
  --bg: #0b0b0f;
  --surface-1: #13131a; --surface-2: #1c1c25; --surface-3: #252532;
  --line: #272730;
  --ink: #e8e8ec; --ink-2: #90909d; --ink-3: #5e5e6b;
  --primary: #22d3ee; --primary-strong: #67e8f9; --primary-ink: #071418;
  --success: #22c55e; --warning: #f59e0b; --error: #ef4444; --info: #3b82f6;
  --mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Consolas, monospace;
  --sans: 'Inter', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, -apple-system, sans-serif;
  --shadow-2: 0 8px 24px -8px rgba(0, 0, 0, 0.45);
  --shadow-3: 0 24px 60px -20px rgba(0, 0, 0, 0.60);
  height: 100vh; overflow: hidden;
  background: var(--bg); color: var(--ink);
  font: 14px/1.6 var(--sans);
  -webkit-font-smoothing: antialiased;
}
.dsh-root ::selection { background: rgba(34,211,238,.3); color: #fff; }
.dsh-root :focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; border-radius: 4px; }
.dsh-root ::-webkit-scrollbar { width: 8px; height: 8px; }
.dsh-root ::-webkit-scrollbar-thumb { background: #252532; border-radius: 4px; }
.dsh-root ::-webkit-scrollbar-thumb:hover { background: #30303f; }
.dsh-root ::-webkit-scrollbar-track { background: transparent; }

/* ── 壳：图标导航轨 + 顶栏 ─────────────────── */
.dsh-shell { display: grid; grid-template-columns: 64px minmax(0,1fr); height: 100vh; }
.dsh-rail {
  grid-row: 1; display: flex; flex-direction: column; align-items: center;
  padding: 14px 0; gap: 6px; background: var(--surface-1);
  border-right: 1px solid var(--line); z-index: 50;
}
.dsh-rail-brand { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; color: var(--primary); margin-bottom: 8px; }
/* 图标下方带短标签：此前纯图标，新用户只能靠悬浮提示（触屏无法悬浮），等于不可发现 */
.dsh-rail-item {
  width: 56px; height: 48px; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px; border-radius: 8px; color: var(--ink-2); background: transparent; border: 0; cursor: pointer;
  transition: background .15s ease, color .15s ease; position: relative;
}
.dsh-rail-label { font-size: 9.5px; line-height: 1; letter-spacing: .2px; }
.dsh-rail-item:hover { background: var(--surface-2); color: var(--ink); }
.dsh-rail-item.active { color: var(--primary); background: rgba(34,211,238,.08); }
.dsh-rail-badge {
  position: absolute; top: 3px; right: 6px; min-width: 15px; height: 15px; padding: 0 4px;
  border-radius: 999px; background: var(--warning); color: #1a1000;
  font-size: 9.5px; font-weight: 700; display: flex; align-items: center; justify-content: center;
}
.dsh-rail-spacer { flex: 1; }
.dsh-main-col { display: flex; flex-direction: column; min-width: 0; height: 100vh; }
.dsh-topbar {
  height: 52px; flex: none; display: flex; align-items: center; justify-content: space-between;
  gap: 16px; padding: 0 20px; background: var(--surface-1);
  border-bottom: 1px solid var(--line); z-index: 40;
}
.dsh-topbar-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
.dsh-topbar-title { display: flex; flex-direction: column; min-width: 0; }
.dsh-topbar-kicker { font-size: 11px; color: var(--ink-3); }
.dsh-topbar-goal { font-size: 13.5px; font-weight: 600; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 380px; }
.dsh-topbar-right { display: flex; align-items: center; gap: 16px; flex: none; }
.dsh-budget-inline { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.dsh-budget-inline .row { display: flex; align-items: center; gap: 8px; }
.dsh-view { flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* ── 通用元件 ─────────────────────────────── */
.dsh-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
  padding: 7px 14px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--surface-2); color: var(--ink);
  transition: background .15s, border-color .15s, filter .15s, transform .05s;
}
.dsh-btn:hover { background: var(--surface-3); border-color: #30303f; }
.dsh-btn:active { transform: translateY(1px); }
.dsh-btn:disabled { opacity: .45; cursor: not-allowed; transform: none; }
.dsh-btn.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-ink); font-weight: 600; }
.dsh-btn.primary:hover { filter: brightness(1.12); background: var(--primary); }
.dsh-btn.ghost { background: transparent; border-color: transparent; color: var(--ink-2); }
.dsh-btn.ghost:hover { color: var(--ink); background: var(--surface-2); }
.dsh-btn.destructive { color: #fca5a5; border-color: rgba(239,68,68,.35); background: rgba(239,68,68,.08); }
.dsh-btn.destructive:hover { background: rgba(239,68,68,.14); border-color: rgba(239,68,68,.55); }
.dsh-btn.sm { padding: 4px 10px; font-size: 12px; border-radius: 6px; }
.dsh-btn.icon { padding: 6px; width: 32px; height: 32px; }
.dsh-input, .dsh-select, .dsh-textarea {
  font: inherit; font-size: 13px; color: var(--ink); background: var(--surface-2);
  border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; width: 100%;
  transition: border-color .15s;
}
.dsh-select { appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--ink-3) 50%), linear-gradient(135deg, var(--ink-3) 50%, transparent 50%); background-position: calc(100% - 16px) 55%, calc(100% - 11px) 55%; background-size: 5px 5px; background-repeat: no-repeat; padding-right: 30px; cursor: pointer; }
.dsh-input:hover, .dsh-select:hover, .dsh-textarea:hover { border-color: #30303f; }
.dsh-input:focus, .dsh-select:focus, .dsh-textarea:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 2px rgba(34,211,238,.18); }
.dsh-input::placeholder, .dsh-textarea::placeholder { color: var(--ink-3); }
.dsh-input[readonly] { color: var(--ink-2); cursor: default; }
.dsh-textarea { font-family: var(--mono); font-size: 12.5px; resize: vertical; min-height: 64px; }
.dsh-mono { font-family: var(--mono); }
.dsh-hint { font-size: 12px; color: var(--ink-3); line-height: 1.5; }
.dsh-pill {
  display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px;
  border-radius: 999px; font-size: 12px; font-weight: 500; white-space: nowrap;
  background: var(--surface-2); color: var(--ink-2);
}
.dsh-pill.run { background: rgba(34,211,238,.1); color: var(--primary); }
.dsh-pill.wait { background: rgba(245,158,11,.1); color: #fbbf24; }
.dsh-pill.error { background: rgba(239,68,68,.1); color: #f87171; }
.dsh-pill.block { background: rgba(239,68,68,.08); color: #fca5a5; }
.dsh-pill.done { background: rgba(34,197,94,.1); color: #4ade80; }
.dsh-pill.idle { background: var(--surface-2); color: var(--ink-2); }
.dsh-pill.info { background: rgba(59,130,246,.1); color: #60a5fa; }
.dsh-pill.plan { background: rgba(34,211,238,.06); color: #67e8f9; }
.dsh-dot { width: 8px; height: 8px; border-radius: 999px; flex: none; background: var(--ink-3); }
.dsh-dot.on { background: var(--primary); animation: dsh-pulse 2s ease-in-out infinite; }
.dsh-dot.ok { background: var(--success); }
.dsh-dot.warn { background: var(--warning); }
.dsh-dot.err { background: var(--error); }
@keyframes dsh-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
.dsh-meter { height: 8px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
.dsh-meter-fill { display: block; height: 100%; border-radius: 999px; background: var(--primary); transition: width .3s ease; }
.dsh-meter-fill.warn { background: var(--warning); }
.dsh-meter-fill.hot { background: var(--error); }
.dsh-tag { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; background: var(--surface-3); color: var(--ink-2); font-size: 11px; cursor: pointer; border: 1px solid transparent; transition: border-color .12s, color .12s; }
.dsh-tag:hover { color: var(--ink); }
.dsh-tag.on { border-color: var(--primary); color: var(--primary); }
.dsh-seg { display: inline-flex; background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 2px; gap: 2px; }
.dsh-seg button { font: inherit; font-size: 12px; border: 0; background: transparent; color: var(--ink-2); padding: 4px 12px; border-radius: 6px; cursor: pointer; transition: color .12s; }
.dsh-seg button:hover { color: var(--ink); }
.dsh-seg button.on { background: var(--surface-1); color: var(--ink); box-shadow: inset 0 0 0 1px var(--primary); }
.dsh-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 40px 20px; text-align: center; }
.dsh-empty-title { font-size: 16px; font-weight: 600; }
.dsh-empty-sub { font-size: 13px; color: var(--ink-2); max-width: 420px; }

/* ── 会话列表 ─────────────────────────────── */
.dsh-page-head {
  flex: none; display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 18px 24px; border-bottom: 1px solid var(--line);
}
.dsh-page-title { font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
.dsh-page-sub { font-size: 13px; color: var(--ink-2); margin-top: 2px; }
.dsh-master-detail { flex: 1; min-height: 0; display: flex; }
.dsh-list-region { flex: 1; min-width: 0; overflow-y: auto; padding: 20px 24px; }
.dsh-list-scroll { min-width: 680px; }
.dsh-sess-grid { display: grid; grid-template-columns: minmax(0,1fr) 96px 90px 90px 140px 40px; gap: 0 16px; align-items: center; }
.dsh-sess-head { padding: 0 16px 8px; font-size: 12px; font-weight: 500; color: var(--ink-3); }
.dsh-sess-row {
  display: grid; grid-template-columns: minmax(0,1fr) 96px 90px 90px 140px 40px; gap: 0 16px;
  align-items: center; width: 100%; text-align: left; font: inherit; cursor: pointer;
  border: 1px solid var(--line); background: var(--surface-1); border-radius: 10px;
  padding: 12px 16px; margin-bottom: 8px; color: var(--ink);
  transition: border-color .15s, background .15s;
}
.dsh-sess-row:hover { border-color: rgba(34,211,238,.4); background: var(--surface-2); }
.dsh-sess-row.on { border-color: var(--primary); background: rgba(34,211,238,.05); }
.dsh-sess-goal { font-size: 13.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-sess-detail { width: 340px; flex: none; border-left: 1px solid var(--line); background: var(--surface-1); overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 20px; }
.dsh-kv-label { font-size: 11px; color: var(--ink-3); }
.dsh-kv-value { font-size: 14px; color: var(--ink); }
.dsh-slotchips { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-slotchip { display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 8px; background: var(--surface-2); font-size: 12px; color: var(--ink); }
.dsh-slotchip .ic { color: var(--primary); }
.dsh-lastevent { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); padding: 12px; }
@media (max-width: 1100px) { .dsh-sess-detail { display: none; } }

/* ── 对话视图（轨 + 状态栏 + 线程 + 右栏）──── */
.dsh-chat-grid { flex: 1; min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr); grid-template-columns: minmax(0,1fr) 288px; }
.dsh-chat-main { min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.dsh-thread { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 24px 12px; }
.dsh-thread-inner { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
.dsh-msg-user-wrap { display: flex; justify-content: flex-end; }
.dsh-msg-user {
  max-width: 80%; background: var(--surface-2); border: 1px solid rgba(34,211,238,.2);
  border-radius: 12px 12px 4px 12px; padding: 10px 14px;
  font-size: 13.5px; white-space: pre-wrap; word-break: break-word;
}
.dsh-msg-time { font-size: 11px; color: var(--ink-3); margin-top: 4px; }
.dsh-msg-user-wrap .dsh-msg-time { text-align: right; }
.dsh-msg { display: flex; gap: 12px; }
.dsh-msg-avatar {
  width: 32px; height: 32px; border-radius: 10px; flex: none;
  display: flex; align-items: center; justify-content: center;
  background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-2);
}
.dsh-msg-avatar.accent { background: rgba(34,211,238,.1); border-color: rgba(34,211,238,.2); color: var(--primary); }
.dsh-msg-avatar.warn { background: rgba(245,158,11,.1); border-color: rgba(245,158,11,.2); color: var(--warning); }
.dsh-msg-avatar.info { background: rgba(59,130,246,.1); border-color: rgba(59,130,246,.2); color: #60a5fa; }
.dsh-msg-body { min-width: 0; max-width: 82%; }
.dsh-msg-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.dsh-msg-name { font-size: 12px; font-weight: 600; color: var(--ink); }
.dsh-msg-sub { font-size: 11px; color: var(--ink-3); }
.dsh-msg-bubble {
  background: var(--surface-1); border: 1px solid var(--line);
  border-radius: 12px 12px 12px 4px; padding: 10px 14px;
  font-size: 13.5px; line-height: 1.65; white-space: pre-wrap; word-break: break-word;
}
.dsh-msg-card { background: var(--surface-2); border: 1px solid var(--line); border-radius: 12px 12px 12px 4px; padding: 14px; }
.dsh-msg-card h4 { margin: 0 0 4px; font-size: 13.5px; font-weight: 600; }
.dsh-msg-card .sub { font-size: 12px; color: var(--ink-3); margin-bottom: 10px; }
.dsh-card-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.dsh-inline-q { font-size: 13.5px; line-height: 1.6; margin: 4px 0; }
.dsh-sysline { align-self: center; display: flex; align-items: center; gap: 10px; font-family: var(--mono); font-size: 11px; color: var(--ink-3); text-align: center; }
.dsh-sysline::before, .dsh-sysline::after { content: ''; width: 28px; height: 1px; background: var(--line); }
.dsh-sysline.warn { color: #fbbf24; }
.dsh-sysline.ok { color: #4ade80; }
.dsh-composer { flex: none; border-top: 1px solid var(--line); background: var(--surface-1); padding: 14px 24px; }
.dsh-composer-inner { max-width: 760px; margin: 0 auto; display: flex; gap: 10px; align-items: center; }
.dsh-composer .dsh-input { height: 40px; border-radius: 10px; }
.dsh-composer-send {
  width: 40px; height: 40px; flex: none; border-radius: 10px; border: 0; cursor: pointer;
  background: var(--primary); color: var(--primary-ink); display: flex; align-items: center; justify-content: center;
  transition: filter .15s;
}
.dsh-composer-send:hover { filter: brightness(1.12); }
.dsh-composer-send:disabled { opacity: .4; cursor: default; }
.dsh-target-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; max-width: 760px; margin-inline: auto; }
.dsh-chat-side { border-left: 1px solid var(--line); background: var(--surface-1); overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 20px; }
.dsh-side-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.dsh-side-card { border: 1px solid var(--line); border-radius: 10px; background: var(--surface-1); padding: 12px; }
.dsh-kvrow { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--ink-2); margin-top: 4px; }
.dsh-slotrow {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px;
  border: 1px solid var(--line); background: var(--surface-1); cursor: pointer; margin-bottom: 6px;
  transition: border-color .12s;
}
.dsh-slotrow:hover { border-color: #30303f; }
.dsh-slotrow.on { border-color: var(--primary); }
.dsh-slotrow .grow { flex: 1; min-width: 0; }
.dsh-slotrow .t1 { font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-slotrow .t2 { font-size: 11px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-quickactions { display: flex; flex-direction: column; gap: 6px; }
.dsh-quickaction {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; font: inherit;
  font-size: 12px; font-weight: 500; color: var(--ink); background: var(--surface-1);
  border: 1px solid var(--line); cursor: pointer; transition: background .12s, border-color .12s;
  text-align: left;
}
.dsh-quickaction:hover { background: var(--surface-3); }
.dsh-quickaction.danger:hover { color: #fca5a5; background: rgba(239,68,68,.08); border-color: rgba(239,68,68,.3); }
@media (max-width: 1024px) { .dsh-chat-grid { grid-template-columns: minmax(0,1fr); } .dsh-chat-side { display: none; } }

/* ── 任务看板 ─────────────────────────────── */
.dsh-board-bar { flex: none; display: flex; align-items: center; gap: 12px; padding: 10px 20px; border-bottom: 1px solid var(--line); }
.dsh-search { display: flex; align-items: center; gap: 8px; width: 240px; padding: 7px 12px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; color: var(--ink-3); }
.dsh-search input { flex: 1; background: transparent; border: 0; outline: 0; color: var(--ink); font: inherit; font-size: 13px; }
.dsh-search input::placeholder { color: var(--ink-3); }
.dsh-board-wrap { flex: 1; min-height: 0; display: flex; }
.dsh-board-cols { flex: 1; min-width: 0; display: flex; gap: 14px; overflow-x: auto; padding: 16px 20px; }
.dsh-kcol { flex: 1 0 280px; max-width: 340px; display: flex; flex-direction: column; background: var(--surface-2); border: 1px solid var(--line); border-radius: 12px; min-height: 0; }
.dsh-kcol-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.dsh-kcol-title { font-size: 13px; font-weight: 600; flex: 1; }
.dsh-kcol-count { padding: 1px 8px; border-radius: 999px; background: var(--surface-3); color: var(--ink-2); font-size: 11.5px; }
.dsh-kcol-cards { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 12px; }
.dsh-task-card {
  flex: none; padding: 12px; background: var(--surface-1); border: 1px solid var(--line);
  border-radius: 8px; transition: border-color .15s, transform .15s; cursor: pointer;
}
.dsh-task-card:hover { border-color: #30303f; transform: translateY(-1px); }
.dsh-task-card.blocked { border-left: 3px solid var(--error); }
.dsh-task-card.escalated { border-left: 3px solid var(--warning); }
.dsh-task-card.paused { border-left: 3px solid #64748b; opacity: 0.85; }
.dsh-task-card.done { opacity: .92; }
.dsh-task-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.dsh-task-id { font-family: var(--mono); font-size: 12px; color: var(--ink-3); }
.dsh-type-badge { padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; background: rgba(34,211,238,.12); color: var(--primary); }
.dsh-type-badge.review { background: rgba(245,158,11,.1); color: #fbbf24; }
.dsh-type-badge.test { background: rgba(34,197,94,.1); color: #4ade80; }
.dsh-type-badge.doc { background: rgba(144,144,157,.12); color: var(--ink-2); }
.dsh-type-badge.research { background: rgba(59,130,246,.1); color: #60a5fa; }
.dsh-type-badge.plan { background: rgba(34,211,238,.07); color: #67e8f9; }
.dsh-task-title { font-size: 13.5px; font-weight: 500; line-height: 1.45; margin-bottom: 8px; }
.dsh-task-meta { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--ink-2); margin-bottom: 8px; }
.dsh-task-callout { display: flex; gap: 6px; align-items: flex-start; padding: 7px 10px; border-radius: 6px; font-size: 12px; line-height: 1.45; margin-bottom: 8px; }
.dsh-task-callout.err { background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.25); color: #fca5a5; }
.dsh-task-callout.warn { background: rgba(245,158,11,.1); border: 1px solid rgba(245,158,11,.25); color: #fbbf24; }
.dsh-task-fields { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
.dsh-task-field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-task-field .k { font-size: 10.5px; color: var(--ink-3); }
.dsh-task-field .v { font-size: 12px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-agent-rail { width: 280px; flex: none; border-left: 1px solid var(--line); background: var(--surface-1); overflow-y: auto; padding: 16px; }
.dsh-agent-slot { padding: 12px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 10px; margin-bottom: 10px; }
/* 槽位可点选（= 换人目标）：悬浮反馈 + 选中态，让「换给谁」看得见 */
.dsh-agent-slot.clickable { cursor: pointer; transition: border-color .12s, background .12s; }
.dsh-agent-slot.clickable:hover { background: var(--surface-3); }
.dsh-agent-slot.selected { border-color: var(--primary); background: var(--surface-3); }
/* 审批规则列表（设置页） */
.dsh-rule-list { display: flex; flex-direction: column; gap: 6px; }
.dsh-rule-row { display: grid; grid-template-columns: 104px minmax(0,1fr) 44px 76px auto; gap: 10px; align-items: center; padding: 8px 10px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; }
/* 长期记忆列表（设置页）：类型 / 重要度 / 内容引用 / 纠正 */
.dsh-mem-list { display: flex; flex-direction: column; gap: 6px; }
.dsh-mem-row { display: grid; grid-template-columns: 48px 68px minmax(0,1fr) auto; gap: 10px; align-items: start; padding: 8px 10px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; }
.dsh-mem-ref { font-size: 12.5px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 定时任务列表（设置页）：job / 周期 / 启用状态 / 上次触发 */
.dsh-cron-list { display: flex; flex-direction: column; gap: 6px; }
.dsh-cron-row { display: grid; grid-template-columns: minmax(0,1fr) 84px 68px 150px; gap: 10px; align-items: center; padding: 8px 10px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; }
.dsh-cron-fire { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.dsh-agent-slot-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.dsh-agent-avatar { width: 34px; height: 34px; border-radius: 999px; background: var(--surface-3); color: var(--primary); display: flex; align-items: center; justify-content: center; flex: none; }
.dsh-agent-name { font-size: 13px; font-weight: 600; }
.dsh-agent-role { font-size: 11.5px; color: var(--ink-2); }
.dsh-agent-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.dsh-agent-ctx { display: flex; flex-direction: column; gap: 5px; font-size: 11px; color: var(--ink-3); }
.dsh-agent-ctx .row { display: flex; justify-content: space-between; }
.dsh-agent-ctx .val { color: var(--ink); font-weight: 500; }
.dsh-agent-ctx .dsh-meter { height: 5px; }
@media (max-width: 1280px) { .dsh-agent-rail { width: 240px; } }
@media (max-width: 1024px) { .dsh-agent-rail { display: none; } }

/* ── DAG 拓扑 ─────────────────────────────── */
.dsh-dag-wrap { flex: 1; min-height: 0; position: relative; overflow: auto; background: radial-gradient(circle at 50% 20%, rgba(34,211,238,.05), transparent 55%), var(--bg); }
.dsh-dag-svg { display: block; }
.dsh-dag-svg .dag-edge { fill: none; stroke: var(--ink-3); stroke-width: 1.5; opacity: .5; }
.dsh-dag-svg .node-bg { fill: var(--surface-1); stroke: var(--line); stroke-width: 1.5; }
.dsh-dag-svg .node-bg.st-done { stroke: var(--success); }
.dsh-dag-svg .node-bg.st-running { stroke: var(--primary); }
.dsh-dag-svg .node-bg.st-blocked { stroke: var(--error); }
.dsh-dag-svg .node-bg.st-escalated { stroke: var(--warning); }
.dsh-dag-svg .node-id { font-family: var(--mono); font-size: 10px; fill: var(--ink-3); }
.dsh-dag-svg .node-title { font-size: 12px; font-weight: 600; fill: var(--ink); }
.dsh-dag-svg .node-agent { font-family: var(--mono); font-size: 9px; fill: var(--ink-2); }
.dsh-dag-node { cursor: pointer; }
.dsh-dag-node.pulse .node-bg { animation: dsh-node-pulse 2s ease-in-out infinite; }
@keyframes dsh-node-pulse { 0%,100% { opacity: .95; } 50% { opacity: .55; } }
.dsh-float { position: absolute; background: var(--surface-1); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow-2); z-index: 5; }
.dsh-legend { top: 14px; right: 14px; width: 168px; padding: 12px; }
.dsh-legend .row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--ink-2); margin-top: 6px; }
.dsh-inspector { bottom: 14px; right: 14px; width: 280px; padding: 14px; }

/* ── 审批页 ───────────────────────────────── */
.dsh-approval-wrap { flex: 1; min-height: 0; overflow-y: auto; padding: 24px; }
.dsh-approval-card { max-width: 720px; background: var(--surface-1); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
.dsh-approval-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.dsh-approval-title { font-size: 19px; font-weight: 600; }
.dsh-diff-box { border: 1px solid var(--line); border-radius: 10px; background: var(--bg); overflow: hidden; font-family: var(--mono); font-size: 12px; line-height: 1.6; }
.dsh-diff-line { display: flex; gap: 10px; padding: 1px 12px; white-space: pre-wrap; word-break: break-all; }
.dsh-diff-line .no { color: var(--ink-3); flex: none; width: 18px; text-align: right; user-select: none; }
.dsh-diff-line.add { background: rgba(34,197,94,.08); }
.dsh-diff-line.add .mark { color: var(--success); }
.dsh-diff-line.del { background: rgba(239,68,68,.08); }
.dsh-diff-line.del .mark { color: var(--error); }
.dsh-diff-line .mark { flex: none; width: 12px; }
.dsh-history-table { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.dsh-history-row { display: grid; grid-template-columns: 70px minmax(0,1fr) 90px 110px; gap: 12px; align-items: center; padding: 10px 14px; font-size: 13px; border-bottom: 1px solid var(--line); background: var(--surface-1); }
.dsh-history-row:last-child { border-bottom: 0; }
.dsh-history-row.head { background: var(--surface-2); font-size: 12px; color: var(--ink-3); }

/* ── 问答弹窗（choice cards）─────────────── */
.dsh-overlay { position: fixed; inset: 0; background: rgba(11,11,15,.72); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 24px; }
.dsh-modal { width: 100%; max-width: 520px; max-height: calc(100vh - 80px); overflow-y: auto; background: var(--surface-1); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow-3); }
.dsh-modal-header { display: flex; gap: 14px; align-items: center; padding: 20px 20px 0; }
.dsh-modal-badge { width: 40px; height: 40px; border-radius: 10px; background: var(--surface-2); color: var(--primary); display: flex; align-items: center; justify-content: center; flex: none; }
.dsh-modal-title { font-size: 16px; font-weight: 600; }
.dsh-modal-body { padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
.dsh-modal-footer { padding: 14px 20px 20px; }
.dsh-modal-footer .dsh-btn { width: 100%; }
.dsh-qlist { display: flex; flex-direction: column; gap: 8px; }
.dsh-qitem { display: flex; gap: 10px; align-items: baseline; font-size: 13.5px; line-height: 1.6; }
.dsh-qitem .idx { flex: none; width: 20px; height: 20px; border-radius: 999px; background: var(--surface-3); color: var(--ink-2); font-size: 11px; display: inline-flex; align-items: center; justify-content: center; }
.dsh-choice-card {
  display: flex; gap: 12px; align-items: center; padding: 12px 14px; border-radius: 10px;
  border: 1px solid var(--line); background: var(--surface-1); cursor: pointer; font: inherit;
  text-align: left; transition: border-color .14s, background .14s; width: 100%; color: var(--ink);
}
.dsh-choice-card:hover { border-color: #30303f; }
.dsh-choice-card.on { border-color: var(--primary); background: rgba(34,211,238,.06); }
.dsh-choice-icon { width: 34px; height: 34px; border-radius: 8px; background: var(--surface-2); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; flex: none; }
.dsh-choice-card.on .dsh-choice-icon { color: var(--primary); background: rgba(34,211,238,.14); }
.dsh-choice-label { font-size: 13.5px; font-weight: 600; }
.dsh-choice-hint { font-size: 11.5px; color: var(--ink-3); }

/* ── 设置页 ───────────────────────────────── */
.dsh-settings-wrap { flex: 1; min-height: 0; overflow-y: auto; }
.dsh-settings-inner { max-width: 680px; margin: 0 auto; padding: 24px 20px 60px; display: flex; flex-direction: column; gap: 16px; }
.dsh-card { background: var(--surface-1); border: 1px solid var(--line); border-radius: 12px; padding: 18px; }
.dsh-card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.dsh-card-title { font-size: 14.5px; font-weight: 600; }
.dsh-form-row { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.dsh-form-row:last-child { margin-bottom: 0; }
.dsh-label { font-size: 12.5px; color: var(--ink-2); font-weight: 500; }
.dsh-roster-table { width: 100%; border-collapse: collapse; }
.dsh-roster-table th { text-align: left; font-size: 11.5px; font-weight: 500; color: var(--ink-3); padding: 6px 8px; border-bottom: 1px solid var(--line); }
.dsh-roster-table td { padding: 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
.dsh-roster-table tr:last-child td { border-bottom: 0; }
.dsh-savebar { position: sticky; bottom: 0; display: flex; justify-content: flex-end; gap: 10px; padding: 14px 0; background: linear-gradient(to top, var(--bg) 70%, transparent); }
.dsh-dirlist { max-height: 300px; overflow-y: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); display: flex; flex-direction: column; padding: 4px; gap: 1px; margin: 12px 0 10px; }
.dsh-diritem { display: flex; align-items: center; gap: 10px; text-align: left; font: inherit; font-size: 13px; color: var(--ink); background: transparent; border: 0; border-radius: 7px; padding: 7px 10px; cursor: pointer; transition: background .12s; }
.dsh-diritem:hover { background: var(--surface-3); }
.dsh-crumb { font-family: var(--mono); font-size: 12px; color: var(--ink); background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; word-break: break-all; flex: 1; min-width: 200px; }

/* ── Agent 形象（毕加索动物）与状态动作 ────── */
.dsh-av { display: block; transform-origin: 50% 60%; }
.dsh-av-chibi { position: relative; }
/* 经典动物走整体 transform；Q 版娘化走内部分层 transform，避免叠加 */
.dsh-av:not(.dsh-av-chibi).idle { animation: dsh-av-breathe 3.4s ease-in-out infinite; }
.dsh-av:not(.dsh-av-chibi).work { animation: dsh-av-work 0.85s ease-in-out infinite; }
.dsh-av:not(.dsh-av-chibi).lean { animation: dsh-av-lean 1.8s ease-in-out infinite alternate; }
.dsh-av:not(.dsh-av-chibi).look { animation: dsh-av-look 1.5s ease-in-out infinite; }
.dsh-av:not(.dsh-av-chibi).shake { animation: dsh-av-shake 0.45s linear infinite; }
.dsh-av:not(.dsh-av-chibi).sleep { animation: dsh-av-sleep 3s ease-in-out infinite alternate; }
@keyframes dsh-av-breathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.06); } }
@keyframes dsh-av-work { 0%,100% { transform: translateY(0) rotate(-5deg); } 50% { transform: translateY(-3px) rotate(6deg); } }
@keyframes dsh-av-lean { from { transform: rotate(0deg); } to { transform: rotate(-8deg) translateY(1px); } }
@keyframes dsh-av-look { 0%,100% { transform: translateX(-2.5px); } 50% { transform: translateX(2.5px); } }
@keyframes dsh-av-shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-2.5px); } 75% { transform: translateX(2.5px); } }
@keyframes dsh-av-sleep { from { transform: rotate(0) translateY(0); } to { transform: rotate(15deg) translateY(2px); } }

/* ── Q 版娘化形象：按部位驱动的状态动画 ────── */
.dsh-av-chibi .chi-tail,
.dsh-av-chibi .chi-leg-l,
.dsh-av-chibi .chi-leg-r,
.dsh-av-chibi .chi-body,
.dsh-av-chibi .chi-head,
.dsh-av-chibi .chi-hair,
.dsh-av-chibi .chi-hair-f,
.dsh-av-chibi .chi-face,
.dsh-av-chibi .chi-arm-l,
.dsh-av-chibi .chi-arm-r,
.dsh-av-chibi .chi-prop,
.dsh-av-chibi .chi-star { transform-box: fill-box; transform-origin: center; }

/* idle：呼吸，全身轻微起伏，头发/手臂自然摆动 */
.dsh-av-chibi.idle .chi-body { animation: chi-body-idle 3.2s ease-in-out infinite; }
.dsh-av-chibi.idle .chi-head { animation: chi-head-idle 3.2s ease-in-out infinite; }
.dsh-av-chibi.idle .chi-hair { animation: chi-hair-idle 3.2s ease-in-out infinite; }
.dsh-av-chibi.idle .chi-hair-f { animation: chi-hair-f-idle 3.2s ease-in-out infinite; }
.dsh-av-chibi.idle .chi-arm-l { animation: chi-arm-l-idle 3.2s ease-in-out infinite; }
.dsh-av-chibi.idle .chi-arm-r { animation: chi-arm-r-idle 3.2s ease-in-out infinite; }
.dsh-av-chibi.idle .chi-tail { animation: chi-tail-idle 3.2s ease-in-out infinite; }
.dsh-av-chibi.idle .chi-star { animation: chi-star-idle 2.4s ease-in-out infinite; }
@keyframes chi-body-idle { 0%,100% { transform: scale(1, 1) translateY(0); } 50% { transform: scale(1.03, 0.98) translateY(0.5px); } }
@keyframes chi-head-idle { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-1px); } }
@keyframes chi-hair-idle { 0%,100% { transform: rotate(-1.5deg); } 50% { transform: rotate(1.5deg); } }
@keyframes chi-hair-f-idle { 0%,100% { transform: translateY(0); } 50% { transform: translateY(0.5px); } }
@keyframes chi-arm-l-idle { 0%,100% { transform: rotate(-1deg); } 50% { transform: rotate(1.5deg); } }
@keyframes chi-arm-r-idle { 0%,100% { transform: rotate(1deg); } 50% { transform: rotate(-1.5deg); } }
@keyframes chi-tail-idle { 0%,100% { transform: rotate(0); } 50% { transform: rotate(2deg); } }
@keyframes chi-star-idle { 0%,100% { opacity: .55; transform: scale(.9); } 50% { opacity: 1; transform: scale(1.05); } }

/* work：快速敲击，双臂交替，身体跟随 */
.dsh-av-chibi.work .chi-body { animation: chi-body-work 0.7s ease-in-out infinite; }
.dsh-av-chibi.work .chi-head { animation: chi-head-work 0.7s ease-in-out infinite; }
.dsh-av-chibi.work .chi-hair { animation: chi-hair-work 0.7s ease-in-out infinite; }
.dsh-av-chibi.work .chi-arm-l { animation: chi-arm-l-work 0.35s ease-in-out infinite; }
.dsh-av-chibi.work .chi-arm-r { animation: chi-arm-r-work 0.35s ease-in-out infinite; }
.dsh-av-chibi.work .chi-tail { animation: chi-tail-work 0.7s ease-in-out infinite; }
.dsh-av-chibi.work .chi-prop { animation: chi-prop-work 0.35s steps(2) infinite; }
@keyframes chi-body-work { 0%,100% { transform: translateY(0) scale(1, 1); } 50% { transform: translateY(1.5px) scale(1.02, 0.98); } }
@keyframes chi-head-work { 0%,100% { transform: rotate(-2deg); } 50% { transform: rotate(2deg); } }
@keyframes chi-hair-work { 0%,100% { transform: rotate(-3deg); } 50% { transform: rotate(3deg); } }
@keyframes chi-arm-l-work { 0%,100% { transform: translateY(0); } 50% { transform: translateY(3px); } }
@keyframes chi-arm-r-work { 0%,100% { transform: translateY(3px); } 50% { transform: translateY(0); } }
@keyframes chi-tail-work { 0%,100% { transform: rotate(-2deg); } 50% { transform: rotate(2deg); } }
@keyframes chi-prop-work { 0%,100% { opacity: 1; } 50% { opacity: .55; } }

/* lean：前倾待命，身体倾斜，头发向后飘 */
.dsh-av-chibi.lean .chi-body { animation: chi-body-lean 1.8s ease-in-out infinite alternate; }
.dsh-av-chibi.lean .chi-head { animation: chi-head-lean 1.8s ease-in-out infinite alternate; }
.dsh-av-chibi.lean .chi-hair { animation: chi-hair-lean 1.8s ease-in-out infinite alternate; }
.dsh-av-chibi.lean .chi-arm-l { animation: chi-arm-l-lean 1.8s ease-in-out infinite alternate; }
.dsh-av-chibi.lean .chi-arm-r { animation: chi-arm-r-lean 1.8s ease-in-out infinite alternate; }
@keyframes chi-body-lean { 0% { transform: rotate(0) translate(0, 0); } 100% { transform: rotate(-7deg) translate(2px, 1px); } }
@keyframes chi-head-lean { 0% { transform: rotate(0) translate(0, 0); } 100% { transform: rotate(4deg) translate(1px, -1px); } }
@keyframes chi-hair-lean { 0% { transform: rotate(0); } 100% { transform: rotate(8deg); } }
@keyframes chi-arm-l-lean { 0% { transform: rotate(0); } 100% { transform: rotate(-6deg); } }
@keyframes chi-arm-r-lean { 0% { transform: rotate(0); } 100% { transform: rotate(-4deg); } }

/* look：左右张望，头部带动，头发滞后摆动 */
.dsh-av-chibi.look .chi-head { animation: chi-head-look 1.4s ease-in-out infinite; }
.dsh-av-chibi.look .chi-hair { animation: chi-hair-look 1.4s ease-in-out infinite; }
.dsh-av-chibi.look .chi-hair-f { animation: chi-hair-f-look 1.4s ease-in-out infinite; }
.dsh-av-chibi.look .chi-body { animation: chi-body-look 1.4s ease-in-out infinite; }
.dsh-av-chibi.look .chi-arm-l { animation: chi-arm-l-look 1.4s ease-in-out infinite; }
.dsh-av-chibi.look .chi-arm-r { animation: chi-arm-r-look 1.4s ease-in-out infinite; }
@keyframes chi-head-look { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-3px); } 75% { transform: translateX(3px); } }
@keyframes chi-hair-look { 0%,100% { transform: rotate(0); } 25% { transform: rotate(-4deg); } 75% { transform: rotate(4deg); } }
@keyframes chi-hair-f-look { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-1px); } 75% { transform: translateX(1px); } }
@keyframes chi-body-look { 0%,100% { transform: rotate(0); } 25% { transform: rotate(-1.5deg); } 75% { transform: rotate(1.5deg); } }
@keyframes chi-arm-l-look { 0%,100% { transform: rotate(0); } 25% { transform: rotate(2deg); } 75% { transform: rotate(-2deg); } }
@keyframes chi-arm-r-look { 0%,100% { transform: rotate(0); } 25% { transform: rotate(-2deg); } 75% { transform: rotate(2deg); } }

/* shake：出错/拒绝，头部快速摇晃，头发甩动 */
.dsh-av-chibi.shake .chi-head { animation: chi-head-shake 0.45s linear infinite; }
.dsh-av-chibi.shake .chi-hair { animation: chi-hair-shake 0.45s linear infinite; }
.dsh-av-chibi.shake .chi-hair-f { animation: chi-hair-f-shake 0.45s linear infinite; }
.dsh-av-chibi.shake .chi-body { animation: chi-body-shake 0.45s linear infinite; }
.dsh-av-chibi.shake .chi-face { animation: chi-face-shake 0.45s linear infinite; }
@keyframes chi-head-shake { 0%,100% { transform: translateX(0) rotate(0); } 25% { transform: translateX(-3px) rotate(-3deg); } 75% { transform: translateX(3px) rotate(3deg); } }
@keyframes chi-hair-shake { 0%,100% { transform: rotate(0); } 25% { transform: rotate(-8deg); } 75% { transform: rotate(8deg); } }
@keyframes chi-hair-f-shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-2px); } 75% { transform: translateX(2px); } }
@keyframes chi-body-shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-1px); } 75% { transform: translateX(1px); } }
@keyframes chi-face-shake { 0%,100% { opacity: 1; } 50% { opacity: .7; } }

/* sleep：暂停/限流，低头打盹，双臂抱胸，zzz 气泡 */
.dsh-av-chibi.sleep .chi-head { animation: chi-head-sleep 3s ease-in-out infinite alternate; }
.dsh-av-chibi.sleep .chi-hair { animation: chi-hair-sleep 3s ease-in-out infinite alternate; }
.dsh-av-chibi.sleep .chi-hair-f { animation: chi-hair-f-sleep 3s ease-in-out infinite alternate; }
.dsh-av-chibi.sleep .chi-body { animation: chi-body-sleep 3s ease-in-out infinite alternate; }
.dsh-av-chibi.sleep .chi-arm-l { animation: chi-arm-l-sleep 3s ease-in-out infinite alternate; }
.dsh-av-chibi.sleep .chi-arm-r { animation: chi-arm-r-sleep 3s ease-in-out infinite alternate; }
.dsh-av-chibi.sleep .chi-face { animation: chi-face-sleep 3s ease-in-out infinite alternate; }
@keyframes chi-head-sleep { 0% { transform: rotate(0) translateY(0); } 100% { transform: rotate(16deg) translateY(2px); } }
@keyframes chi-hair-sleep { 0% { transform: rotate(0); } 100% { transform: rotate(-6deg); } }
@keyframes chi-hair-f-sleep { 0% { transform: translateY(0); } 100% { transform: translateY(1px); } }
@keyframes chi-body-sleep { 0% { transform: scale(1, 1); } 100% { transform: scale(1.02, 0.96); } }
@keyframes chi-arm-l-sleep { 0% { transform: rotate(0); } 100% { transform: rotate(-10deg) translateY(1px); } }
@keyframes chi-arm-r-sleep { 0% { transform: rotate(0); } 100% { transform: rotate(10deg) translateY(1px); } }
@keyframes chi-face-sleep { 0% { opacity: 1; } 100% { opacity: .75; } }
/* zzz 气泡：sleep 动作的视觉提示；用伪元素实现，避免污染 SVG */
.dsh-av-chibi.sleep::after {
  content: 'z';
  position: absolute;
  right: 2px;
  top: 2px;
  font: 700 9px/1 var(--sans);
  color: var(--ink-3);
  opacity: 0;
  animation: chi-zzz 2.2s ease-in-out infinite;
}
@keyframes chi-zzz { 0% { opacity: 0; transform: translateY(0); } 50% { opacity: 1; } 100% { opacity: 0; transform: translateY(-10px); } }
@media (prefers-reduced-motion: reduce) { .dsh-av, .dsh-av *, .dsh-view, .dsh-msg, .dsh-msg-user-wrap, .dsh-modal, .dsh-rail-item.active, .dsh-caret { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; } }
/* 形象选择浮层（8 宫格） */
.dsh-avatar-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.dsh-avatar-cell {
  display: flex; flex-direction: column; align-items: center; gap: 6px; font: inherit;
  padding: 10px 6px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--surface-1); color: var(--ink-2); cursor: pointer;
  transition: border-color .14s, background .14s;
}
.dsh-avatar-cell:hover { border-color: #30303f; color: var(--ink); }
.dsh-avatar-cell.on { border-color: var(--primary); background: rgba(34,211,238,.06); color: var(--primary); }
.dsh-avatar-cell .nm { font-size: 11.5px; }

/* ── 流式输出 / 传信行 / 侧面板拖拽 ───────── */
.dsh-caret { display: inline-block; width: 2px; height: 1em; margin-left: 3px; vertical-align: -2px; background: var(--primary); animation: dsh-caret-blink 0.9s steps(1) infinite; }
@keyframes dsh-caret-blink { 0%, 55% { opacity: 1; } 56%, 100% { opacity: 0; } }
.dsh-actline { display: inline-flex; align-items: center; gap: 8px; margin-top: 3px; font-family: var(--mono); font-size: 10px; color: var(--ink-3); }
.dsh-actline .tool { color: var(--primary); max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-actline .el { flex: none; }
.dsh-actline .ctx { color: var(--primary); cursor: pointer; border-bottom: 1px dotted var(--primary); }
.dsh-actline .ctx:hover { color: var(--ink); border-color: var(--ink); }
.dsh-ctxspec { max-height: 56vh; overflow: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; font-family: var(--mono); font-size: 11.5px; line-height: 1.6; color: var(--ink-2); white-space: pre-wrap; word-break: break-word; margin: 0; }
.dsh-toolline {
  align-self: flex-start; display: flex; align-items: center; gap: 8px; max-width: 60%;
  font-family: var(--mono); font-size: 11px; color: var(--ink-3);
  background: var(--surface-1); border: 1px solid var(--line); border-radius: 8px;
  padding: 3px 10px;
}
.dsh-toolline .who { color: var(--primary); flex: none; }
.dsh-toolline .note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-relay {
  align-self: flex-start; display: flex; align-items: center; gap: 7px; max-width: 86%;
  font-size: 11.5px; color: var(--ink-2); background: var(--surface-1);
  border: 1px dashed var(--line); border-radius: 9px; padding: 4px 10px;
}
.dsh-relay .who { font-family: var(--mono); font-size: 10.5px; color: var(--primary); flex: none; }
.dsh-relay .arr { color: var(--ink-3); flex: none; }
.dsh-relay .note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-side-resize { position: absolute; left: -4px; top: 0; bottom: 0; width: 8px; cursor: col-resize; z-index: 6; }
.dsh-side-resize::after { content: ''; position: absolute; left: 3px; top: 50%; transform: translateY(-50%); width: 2px; height: 34px; border-radius: 2px; background: var(--line); transition: background .15s; }
.dsh-side-resize:hover::after { background: var(--primary); }
.dsh-side-reopen {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; width: auto; height: 26px;
  padding: 0 10px; margin-bottom: 8px; font: inherit; font-size: 11.5px;
  border-radius: 8px; border: 1px solid var(--line); background: var(--surface-1); color: var(--ink-2); cursor: pointer;
  transition: color .15s, border-color .15s;
}
.dsh-side-reopen:hover { color: var(--primary); border-color: var(--primary); }
.dsh-composer-ta {
  display: block; flex: 1; min-width: 0; width: 100%; min-height: 40px; max-height: 180px; resize: vertical;
  border-radius: 10px; line-height: 1.55; padding: 9px 12px; overflow-y: auto;
}

/* ── 动效体系（视图切换 / 入场 / 按钮反馈）── */
@keyframes dsh-view-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes dsh-msg-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes dsh-modal-in { from { opacity: 0; transform: scale(.965) translateY(6px); } to { opacity: 1; transform: scale(1) translateY(0); } }
@keyframes dsh-pop { 0% { transform: scale(.86); } 60% { transform: scale(1.08); } 100% { transform: scale(1); } }
.dsh-view { animation: dsh-view-in .22s ease-out; }
.dsh-msg, .dsh-msg-user-wrap { animation: dsh-msg-in .25s ease-out both; }
.dsh-modal { animation: dsh-modal-in .2s ease-out; }
.dsh-rail-item.active { animation: dsh-pop .2s ease-out; }
.dsh-btn:active { transform: scale(.97); }
.dsh-btn:active.primary { transform: scale(.97); }
.dsh-composer-send:active { transform: scale(.94); }
.dsh-sess-row { will-change: transform; }
.dsh-sess-row:active { transform: scale(.995); }
.dsh-kcol, .dsh-task-card, .dsh-agent-slot, .dsh-choice-card, .dsh-avatar-cell { will-change: auto; }

/* ── 通告条 ───────────────────────────────── */
.dsh-note { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 10px 20px 0; padding: 8px 12px; border-radius: 10px; flex: none; }
.dsh-note.error { background: rgba(239,68,68,.08); border: 1px solid rgba(239,68,68,.3); color: #fca5a5; }
.dsh-note.demo { background: rgba(245,158,11,.08); border: 1px solid rgba(245,158,11,.3); color: #fbbf24; }
.dsh-note.demo strong { color: #fbbf24; font-weight: 600; margin-right: 2px; }

/* ── 桌宠房间（学习 dsh-web/dsh-pet，2026-09-02）────────── */
.dsh-pet-room { position: relative; flex: 1; overflow: auto; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; padding: 0 24px 28px; }
.dsh-pet-room-wall { position: absolute; inset: 0 0 38% 0; background:
  radial-gradient(1200px 500px at 50% -10%, rgba(34,211,238,.10), transparent 60%),
  linear-gradient(180deg, #0d1420 0%, #101a2b 70%, #14243a 100%); pointer-events: none; }
.dsh-pet-room-floor { position: absolute; inset: 38% 0 0 0; background:
  linear-gradient(180deg, #0e1a2c 0%, #0a1322 100%); pointer-events: none; }
.dsh-pet-room-floor::after { content: ''; position: absolute; inset: 0;
  background-image:
    linear-gradient(rgba(34,211,238,.06) 1px, transparent 1px),
    linear-gradient(90deg, rgba(34,211,238,.05) 1px, transparent 1px);
  background-size: 72px 72px, 72px 72px;
  transform: perspective(600px) rotateX(52deg); transform-origin: top center; }
.dsh-pet-room-title { position: relative; margin: 18px 0 4px; font-size: 13px; letter-spacing: .22em; color: var(--ink-2); text-transform: uppercase; flex: none; }
.dsh-pet-room-grid { position: relative; display: flex; flex-wrap: wrap; justify-content: center; align-items: flex-end; gap: 34px 48px; padding: 24px 8px 6px; width: 100%; max-width: 1080px; flex: none; }
.dsh-pet-station { position: relative; display: flex; flex-direction: column; align-items: center; }
.dsh-pet-sprite { position: relative; z-index: 2; }
.dsh-pet-shadow { width: 92px; height: 14px; margin-top: -8px; border-radius: 50%;
  background: radial-gradient(closest-side, rgba(0,0,0,.5), transparent); z-index: 1; }
.dsh-pet-bubble { position: relative; z-index: 3; margin-bottom: 10px; max-width: 230px; min-width: 120px;
  padding: 8px 12px; border-radius: 12px; border: 1px solid rgba(34,211,238,.28);
  background: linear-gradient(180deg, rgba(13,22,36,.92), rgba(10,17,28,.92));
  box-shadow: var(--shadow-2); font-size: 12px; color: var(--ink); }
.dsh-pet-bubble pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-family: var(--sans); line-height: 1.5; }
.dsh-pet-bubble.busy { border-color: rgba(34,211,238,.55); }
.dsh-pet-bubble.bad { border-color: rgba(239,68,68,.5); }
.dsh-pet-bubble::after { content: ''; position: absolute; left: 50%; bottom: -6px; margin-left: -6px;
  width: 10px; height: 10px; transform: rotate(45deg);
  background: rgba(10,17,28,.92); border-right: 1px solid rgba(34,211,238,.28); border-bottom: 1px solid rgba(34,211,238,.28); }
.dsh-pet-bubble.bad::after { border-right-color: rgba(239,68,68,.5); border-bottom-color: rgba(239,68,68,.5); }
.dsh-pet-nameplate { position: relative; z-index: 2; display: flex; flex-direction: column; align-items: center; gap: 1px;
  margin-top: 6px; padding: 5px 14px; border-radius: 10px;
  background: rgba(19,19,26,.85); border: 1px solid var(--line); }
.dsh-pet-vendor { font-size: 13px; font-weight: 600; color: var(--primary); }
.dsh-pet-role { font-size: 11px; color: var(--ink-2); }
.dsh-pet-meta { font-size: 10.5px; color: var(--ink-3); font-family: var(--mono); }
.dsh-pet-room-empty { position: relative; margin: 40px 0 60px; font-size: 14px; color: var(--ink-2); }
.dsh-pet-room-legend { position: relative; margin-top: 18px; font-size: 11px; color: var(--ink-3); flex: none; }
`
