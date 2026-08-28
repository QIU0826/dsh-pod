/**
 * 独立控制台 HTML 壳（CR-38 P0）—— server.ts 内嵌返回的唯一事实源，
 * 挂载点 #root + /standalone.js（tsdown 独立 UI 入口产物）。
 */
export const STANDALONE_SHELL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>dsh-pod 控制台</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; background: #111418; color: #e6e6e6; }
  #root { max-width: 1100px; margin: 0 auto; padding: 16px; }
</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="/standalone.js"></script>
</body>
</html>`
