/**
 * 独立控制台服务（standalone 模式，CR-38 P0）—— 不依赖 DSH 宿主。
 *
 * 形态对标 block/berd：本地起一个 Web 服务，浏览器打开即管理全部 harness。
 * 复用 routes.ts 的全部 /api/dsh-pod/* 路由（纯 (req,res) 签名，零改动；WebRoute 为
 * type-only import，编译期擦除，故本模块运行时零 dsh-* 依赖）与 PodPanel React
 * 面板（dist/standalone.js，tsdown 独立 UI 入口打包）。
 *
 * 安全（CR-29 同款纪律）：默认 loopback-only；--host 0.0.0.0 时必须 --token（Bearer）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPodRuntime, type PodRuntime } from '../core/pod-runtime.js'
import { bearerTokenEquals, hasAllowedLoopbackOrigin, isLocalHostHeader, isLoopbackBindHost, isLoopbackRemoteAddress } from '../core/http-guard.js'
import { PodService } from '../pod-service.js'
import { makePodRoutes } from '../routes.js'
import { ClaudeHeadlessBackend } from '../workers/claude-headless.js'
import { CodexHeadlessBackend, codexBinaryCandidates } from '../workers/codex-headless.js'
import { OpenCodeHeadlessBackend, opencodeBinaryCandidates } from '../workers/opencode-headless.js'
import { DemoBackend } from '../workers/demo-backend.js'
import { STANDALONE_SHELL_HTML } from '../web/standalone-shell.js'

export interface StandaloneOptions {
  /** 监听端口（默认 3930；0 = 随机，listenStandalone 会回填实际端口）。 */
  port?: number
  /** 监听地址（默认 127.0.0.1；0.0.0.0 需配合 token）。 */
  host?: string
  /** 数据根（默认 ~/.dsh/pod，与 DSH 插件形态共用同一份磁盘事实源）。 */
  dataDir?: string
  /** Bearer token；host 非 loopback 时必填。 */
  token?: string
  /** opencode 可执行文件显式路径（缺省走候选探测）。 */
  opencodeBin?: string
  /** 静态资源目录（含 standalone.js；默认取本模块所在目录，即打包后的 dist/）。 */
  staticDir?: string
  /** 演示模式：脚本化 Demo 后端（零 LLM 成本，真实 git/审批/问答链路）。 */
  demo?: boolean
}

/** host 是否 loopback（未指定 = 默认 127.0.0.1）。CLI 启动前置检查与请求守卫共用。 */
export function isLoopbackHost(host?: string): boolean {
  return isLoopbackBindHost(host)
}

/** 默认静态目录：打包后本模块位于 dist/，UI 产物 standalone.js 同目录。 */
function defaultStaticDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/** 静态资源：/ 与 /index.html 回 index 壳；/standalone.js 回打包产物。其余 404。 */
function serveStatic(res: ServerResponse, pathname: string, staticDir: string): boolean {
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(STANDALONE_SHELL_HTML)
    return true
  }
  if (pathname === '/standalone.js') {
    const p = join(staticDir, 'standalone.js')
    if (!existsSync(p)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('standalone.js 未构建（npm run build）')
      return true
    }
    // 本地工具不做 HTTP 缓存（实证：改版后浏览器吃旧 bundle，UI 行为与代码不一致）
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(readFileSync(p))
    return true
  }
  return false
}

/** 守卫：loopback-only 默认；非 loopback 必须 Bearer token（CR-29 同款）。
 * P1 补强：loopback 连接叠加 Host 白名单（堵 DNS rebinding——否则攻击页可读响应）
 * 与 Origin 校验（堵跨站写）；token 比较恒时。 */
export function guard(req: IncomingMessage, res: ServerResponse, token: string, loopbackOnly: boolean): boolean {
  const addr = req.socket.remoteAddress ?? ''
  if (isLoopbackRemoteAddress(addr)) {
    if (!isLocalHostHeader(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'forbidden: non-local Host header (DNS rebinding guard)' }))
      return false
    }
    if (!hasAllowedLoopbackOrigin(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'forbidden: cross-origin request' }))
      return false
    }
    return true
  }
  if (!loopbackOnly && token.length > 0 && bearerTokenEquals(token, req)) return true
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: 'forbidden: loopback-only 或缺少 Bearer token' }))
  return false
}

export interface StandaloneServer {
  server: Server
  /** 监听端口（listenStandalone 用 port 0 启动后回填为实际端口）。 */
  port: number
  host: string
  runtime: PodRuntime
  close(): Promise<void>
}

/** 装配独立控制台（不监听；测试可拿 server 自行 listen）。返回的 close() 同时关 HTTP 与磁盘句柄。 */
export function createStandaloneServer(options: StandaloneOptions = {}): StandaloneServer {
  const port = options.port ?? 3930
  const host = options.host ?? '127.0.0.1'
  const token = (options.token ?? '').trim()
  const loopbackOnly = isLoopbackHost(options.host)
  const staticDir = options.staticDir ?? defaultStaticDir()
  const runtime = createPodRuntime(options.dataDir)
  const opencodeBin = options.opencodeBin ?? opencodeBinaryCandidates(process.platform).find((c) => existsSync(c))
  const service = new PodService({
    store: runtime.store,
    memory: runtime.memory,
    dataDir: runtime.dataDir,
    demo: options.demo === true,
    backends: options.demo === true
      ? { claude: new DemoBackend('claude'), codex: new DemoBackend('codex'), opencode: new DemoBackend('opencode') }
      : {
          claude: new ClaudeHeadlessBackend({ allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'] }),
          codex: new CodexHeadlessBackend({ binary: codexBinaryCandidates(process.platform).find((c) => existsSync(c)) ?? 'codex' }),
          opencode: new OpenCodeHeadlessBackend({ binary: opencodeBin ?? 'opencode' }),
        },
  })
  const routes = makePodRoutes(() => service)
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    if (!guard(req, res, token, loopbackOnly)) return
    if (pathname === '/' || pathname === '/index.html') {
      serveStatic(res, pathname, staticDir)
      return
    }
    if (pathname === '/standalone.js') {
      serveStatic(res, pathname, staticDir)
      return
    }
    if (!pathname.startsWith('/api/dsh-pod/')) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    const route = routes.find((r) => r.kind === 'exact' && r.path === pathname)
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    try {
      void Promise.resolve(route.handler(req, res)).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'internal error' }))
        }
      })
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'internal error' }))
      }
    }
  })
  // 未 listen 即 close() 时吞掉 ERR_SERVER_NOT_RUNNING，避免无监听 error 崩进程
  server.on('error', () => {})
  // 宿主巡检的 standalone 等价物（P0 修复：此前独立模式无 maintenanceTick——
  // watchdog 空闲/墙钟、审批超期 pause、退避到期重驱、桌面通知全部失效）
  const maintenanceTimer = setInterval(() => {
    try {
      service.maintenanceTick()
    } catch (error) {
      console.error('[dsh-pod] standalone maintenanceTick failed:', error)
    }
  }, 30_000)
  maintenanceTimer.unref?.()
  return {
    server,
    port,
    host,
    runtime,
    close: async () => {
      clearInterval(maintenanceTimer)
      if (server.listening) server.close()
      runtime.close()
    },
  }
}

/** 阻塞直至监听就绪（CLI 与测试入口）。port 0（随机）时回填实际端口。 */
export async function listenStandalone(options: StandaloneOptions = {}): Promise<StandaloneServer> {
  const s = createStandaloneServer(options)
  await new Promise<void>((resolve, reject) => {
    s.server.once('error', reject)
    s.server.listen(s.port, s.host, () => resolve())
  })
  const addr = s.server.address()
  if (addr !== null && typeof addr === 'object') s.port = addr.port
  return s
}
