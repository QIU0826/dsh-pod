/**
 * 独立控制台冒烟核验（docs/STANDALONE-PLAN.md P1 两项）——
 * 无头 Chrome（CDP，与 scripts/pet-assets-*.mjs 同款渲染路径）加载**真实** standalone 控制台，断言：
 *
 *   ① 独立渲染：壳无启动错误（#boot-error 空）、React 已挂载（.dsh-shell）、
 *      设计 CSS 变量生效（.dsh-root 背景 = 设计稿地面色 —— 脱离 DSH 宿主变量也不塌）
 *   ② SSE 断线回退：SSE（/events/stream）已连；**重启服务断流后**客户端切 2s 轮询
 *      （/events 请求出现），事件不静默冻结（审计 P3 #17 的行为面）
 *
 * 用法（先 npm run build）：node scripts/standalone-smoke.mjs [--chrome <path>]
 * 幂等：数据目录用临时目录，跑完清理；不触碰 ~/.dsh/pod。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  (process.env.LOCALAPPDATA ?? '') + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

const argIdx = process.argv.indexOf('--chrome')
const chromeBin =
  argIdx >= 0 && process.argv[argIdx + 1] !== undefined
    ? process.argv[argIdx + 1]
    : CHROME_CANDIDATES.find((p) => existsSync(p))
if (chromeBin === undefined) {
  console.error('未找到 Chrome/Edge：用 --chrome <path> 指定')
  process.exit(2)
}
if (!existsSync('dist/standalone.js')) {
  console.error('缺少 dist/standalone.js —— 先 npm run build')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`)
}

/** 取一个空闲端口（绑 0 读取后释放；随后由 standalone 复用）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

/** 起 standalone（--demo 脚本化后端，零 LLM 成本）；等 CLI 打印实际地址。 */
function startServer(port, dataDir) {
  const proc = spawn(process.execPath, ['dist/standalone-server.js', '--port', String(port), '--data-dir', dataDir, '--demo'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    let out = ''
    const onData = (b) => {
      out += String(b)
      const m = /standalone console: (http:\/\/[^\s]+)/.exec(out)
      if (m !== null) {
        proc.stdout.off('data', onData)
        resolve({ proc, url: m[1] })
      }
    }
    proc.stdout.on('data', onData)
    proc.on('error', reject)
    proc.on('exit', (code) => reject(new Error(`standalone 提前退出 code=${code}\n${out}`)))
    setTimeout(() => reject(new Error('standalone 启动超时\n' + out)), 15000)
  })
}

/** CDP 客户端（无头 Chrome；事件回调 + 请求-响应）。 */
async function getCdp(debugPort = 9338) {
  const profile = join(tmpdir(), 'dsh-pod-standalone-smoke-profile')
  const proc = spawn(chromeBin, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
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
  let msgId = 0
  const pending = new Map()
  const listeners = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data))
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    for (const l of listeners) l(m)
  }
  const cdp = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++msgId
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Network.enable')
  return { cdp, on: (fn) => listeners.push(fn), close: () => proc.kill() }
}

async function evalJson(cdp, expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────
let server
let cdpHandle
let dataDir
try {
  dataDir = mkdtempSync(join(tmpdir(), 'pod-smoke-'))
  const port = await freePort()
  server = await startServer(port, dataDir)
  console.log(`[smoke] standalone: ${server.url}`)

  cdpHandle = await getCdp()
  /** 观测到的网络请求 URL（判 SSE / 轮询） */
  const requests = []
  const pageErrors = []
  cdpHandle.on((m) => {
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url)
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.text ?? 'exception')
  })

  await cdpHandle.cdp('Page.navigate', { url: server.url })
  await sleep(4000) // 等 React 挂载 + SSR 首帧 + SSE 建连

  // ① 独立渲染
  const boot = await evalJson(cdpHandle.cdp, `document.getElementById('boot-error')?.textContent ?? ''`)
  check('独立页无启动错误（#boot-error 为空）', (boot ?? '') === '', boot !== '' ? JSON.stringify(boot) : undefined)

  const shell = await evalJson(cdpHandle.cdp, `!!document.querySelector('.dsh-shell')`)
  check('React 已挂载（.dsh-shell 存在）', shell === true)

  const bg = await evalJson(cdpHandle.cdp, `getComputedStyle(document.querySelector('.dsh-root')).backgroundColor`)
  check('设计 CSS 变量生效（.dsh-root 地面色 = rgb(11,11,15)）', bg === 'rgb(11, 11, 15)', `实际 ${bg}`)

  check('页面无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join('; '))

  // ② SSE 已连
  const sseOpened = requests.some((u) => u.includes('/events/stream'))
  check('SSE 事件流已建连（/events/stream）', sseOpened)

  // ② 断流回退：重启服务（同端口）→ 客户端 reader 收 EOF → 回退 2s 轮询
  const pollBefore = requests.filter((u) => u.includes('/api/dsh-pod/events') && !u.includes('/stream')).length
  server.proc.kill()
  await sleep(1500)
  server = await startServer(port, dataDir)
  await sleep(6000) // 覆盖若干个 2s 轮询周期
  const pollAfter = requests.filter((u) => u.includes('/api/dsh-pod/events') && !u.includes('/stream')).length
  check('断流后回退轮询且持续拉取（/events 请求增加）', pollAfter > pollBefore, `前 ${pollBefore} → 后 ${pollAfter}`)

  const frozen = await evalJson(cdpHandle.cdp, `document.getElementById('boot-error')?.textContent ?? ''`)
  check('断流重连期间页面未冻结/未报错', (frozen ?? '') === '')
} finally {
  try { server?.proc?.kill() } catch { /* ignore */ }
  try { cdpHandle?.close() } catch { /* ignore */ }
  // Windows：被 kill 的 server 释放 SQLite 句柄有延迟，立即 rm 会 EBUSY——等一拍，且清理失败不致命
  await sleep(800)
  if (dataDir !== undefined) {
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* 句柄延迟释放，留给系统/临时目录清理 */ }
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n[smoke] ${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
