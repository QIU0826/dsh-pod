/**
 * 独立控制台 HTML 壳（CR-38 P0）—— server.ts 内嵌返回的唯一事实源，
 * 挂载点 #root + /standalone.js（tsdown 独立 UI 入口产物）。
 * 设计系统（console-css.ts 单一事实源）在此静态内联，DSH 宿主形态由 PodPanel 注入同一份。
 */
import { CONSOLE_CSS } from './console-css.js'

export const STANDALONE_SHELL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>dsh-pod 控制台 · Pod 鲸群</title>
<script>
  // 启动期错误可见化：UI bundle 挂载失败时绝不黑屏——错误直接渲染到页面上
  window.addEventListener('error', function (e) {
    var d = document.getElementById('boot-error');
    if (!d) { d = document.createElement('div'); d.id = 'boot-error'; document.body.prepend(d); }
    var line = document.createElement('div');
    line.textContent = '加载/运行错误: ' + (e.message || '(no message)') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0);
    d.appendChild(line);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var d = document.getElementById('boot-error');
    if (!d) { d = document.createElement('div'); d.id = 'boot-error'; document.body.prepend(d); }
    var line = document.createElement('div');
    line.textContent = '未捕获 Promise 拒绝: ' + ((e.reason && (e.reason.stack || e.reason.message)) || String(e.reason));
    d.appendChild(line);
  });
</script>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; padding: 0; background: #0B0E14; }
  body { font-family: system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif; }
  #root { min-height: 100vh; }
  #boot-error {
    max-width: 920px; margin: 16px auto; padding: 12px 16px;
    border: 1px solid #7F1D1D; border-radius: 10px; background: #2A0D0D; color: #FCA5A5;
    font: 12px/1.7 ui-monospace, Consolas, monospace; white-space: pre-wrap;
  }
${CONSOLE_CSS}</style>
</head>
<body>
<!-- pod-dark-ops-2026-08-29 方向契约见 src/web/console-css.ts 头注；FINISH: unreviewed and undocumented is unfinished -->
<div id="root"><div class="pod-root" style="display:flex;align-items:center;justify-content:center;min-height:100vh;color:#66718A;font-size:13px;">控制台加载中…</div></div>
<script type="module" src="/standalone.js"></script>
</body>
</html>`
