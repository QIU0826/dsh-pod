/**
 * 控制台 UI 截图（设计评审用）——无头 Chrome 加载真实 standalone，逐个视图截 PNG。
 *
 * 做法：起 standalone（--demo，零 LLM 成本）→ POST /api/dsh-pod/launch 造一个真实 demo mission
 * （否则界面是空的，看不出设计）→ 逐视图点击后 Page.captureScreenshot。
 *
 * 用法（先 npm run build）：node scripts/ui-screenshot.mjs [--out <dir>] [--w 1280] [--h 800]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const arg = (n, d) => {
  const i = process.argv.indexOf(n)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d
}
const OUT = arg('--out', join(tmpdir(), 'dsh-pod-ui-shots'))
const W = Number(arg('--w', '1280'))
const H = Number(arg('--h', '800'))

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  (process.env.LOCALAPPDATA ?? '') + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
]
const chromeBin = CHROME_CANDIDATES.find((p) => existsSync(p))
if (chromeBin === undefined) {
  console.error('未找到 Chrome/Edge：用 --chrome <path> 指定')
  process.exit(2)
}
if (!existsSync('dist/standalone.js')) {
  console.error('缺少 dist/standalone.js —— 先 npm run build')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })

function startServer(port, dataDir) {
  const proc = spawn(process.execPath, ['dist/standalone-server.js', '--port', String(port), '--data-dir', dataDir, '--demo'], { stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolve, reject) => {
    let out = ''
    const onData = (b) => {
      out += String(b)
      const m = /standalone console: (http:\/\/[^\s]+)/.exec(out)
      if (m !== null) { proc.stdout.off('data', onData); resolve({ proc, url: m[1] }) }
    }
    proc.stdout.on('data', onData)
    proc.on('error', reject)
    proc.on('exit', (c) => reject(new Error(`standalone 提前退出 code=${c}\n${out}`)))
    setTimeout(() => reject(new Error('standalone 启动超时\n' + out)), 15000)
  })
}

async function getCdp(debugPort = 9339) {
  const profile = join(tmpdir(), 'dsh-pod-ui-shot-profile')
  const proc = spawn(chromeBin, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`, '--force-device-scale-factor=1',
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' })
  let wsUrl
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      if (r.ok) {
        const page = (await r.json()).find((t) => t.type === 'page')
        if (page !== undefined) { wsUrl = page.webSocketDebuggerUrl; break }
      }
    } catch { /* retry */ }
    await sleep(250)
  }
  if (wsUrl === undefined) { proc.kill(); throw new Error('Chrome CDP 未就绪') }
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data))
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  const cdp = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })) })
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  return { cdp, close: () => proc.kill() }
}

const VIEWS = [
  ['sessions', '会话'],
  ['chat', '对话'],
  ['board', '看板'],
  ['dag', 'DAG'],
  ['pets', '桌宠'],
  ['remote', '远程'],
  ['settings', '设置'],
]

let server
let cdpH
let dataDir
try {
  dataDir = mkdtempSync(join(tmpdir(), 'pod-uishot-'))
  const port = await freePort()
  server = await startServer(port, dataDir)
  console.log(`[shot] ${server.url}`)

  // 造数据：demo 后端跑一个真实 mission（否则各视图是空的，看不出设计）
  // --no-launch：跳过造数，用于评审**首次打开的空状态**
  if (process.argv.includes('--no-launch')) {
    console.log('[shot] --no-launch：评审空状态')
  } else {
    const launch = await fetch(server.url + '/api/dsh-pod/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'UI 评审演示',
        goal: '为 dsh-pod 控制台做一次界面评审：跑通 demo mission 并观察各视图呈现',
        cwd: process.cwd(),
        slots: [
          { id: 'S-1', vendor: 'claude', role: 'implementer', capabilities: ['编码'] },
          { id: 'S-2', vendor: 'codex', role: 'reviewer', capabilities: ['审查'] },
        ],
      }),
    })
    console.log(`[shot] launch ${launch.status}`)
  }

  cdpH = await getCdp()
  await cdpH.cdp('Page.navigate', { url: server.url })
  await sleep(6000) // 让 demo mission 推进 + 首帧渲染

  mkdirSync(OUT, { recursive: true })
  for (const [key, label] of VIEWS) {
    const clicked = await cdpH.cdp('Runtime.evaluate', {
      expression: `(() => {
        const it = [...document.querySelectorAll('.dsh-rail-item')].find((e) => e.textContent.includes(${JSON.stringify(label)}));
        if (!it) return false; it.click(); return true;
      })()`,
      returnByValue: true,
    })
    await sleep(1400)
    const shot = await cdpH.cdp('Page.captureScreenshot', { format: 'png' })
    const data = shot.result?.data
    if (typeof data !== 'string') { console.error(`[shot] ${key} 截图失败`); continue }
    const dest = join(OUT, `${key}.png`)
    writeFileSync(dest, Buffer.from(data, 'base64'))
    console.log(`[shot] ${key.padEnd(9)} ${clicked.result?.result?.value === true ? 'ok' : '（导航未命中）'} → ${dest}`)
  }
} finally {
  try { cdpH?.close() } catch { /* ignore */ }
  try { server?.proc?.kill() } catch { /* ignore */ }
  await sleep(800)
  if (dataDir !== undefined) { try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* 句柄延迟释放 */ } }
}
console.log(`\n[shot] 输出目录：${OUT}`)
