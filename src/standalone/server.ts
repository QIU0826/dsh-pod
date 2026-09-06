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
import { writeFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPodRuntime, type PodRuntime } from '../core/pod-runtime.js'
import { bearerTokenEquals, hasAllowedLoopbackOrigin, isLocalHostHeader, isLoopbackBindHost, isLoopbackRemoteAddress } from '../core/http-guard.js'
import { PodService } from '../pod-service.js'
import { PairingStore } from '../core/pairing.js'
import { makePodRoutes } from '../routes.js'
import { createMcpHttpServer, type McpHttpHandle } from '../mcp-http.js'
import { ClaudeHeadlessBackend } from '../workers/claude-headless.js'
import { CodexHeadlessBackend, codexBinaryCandidates } from '../workers/codex-headless.js'
import { OpenCodeHeadlessBackend, opencodeBinaryCandidates } from '../workers/opencode-headless.js'
import { ArkBackend } from '../workers/ark-headless.js'
import { DemoBackend } from '../workers/demo-backend.js'
import { STANDALONE_SHELL_HTML } from '../web/standalone-shell.js'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'

/**
 * ark 后端装配（与 pod-service 默认一致；2026-09-01 补齐 standalone 缺失）：
 * ARK_API_KEY 环境变量或 ~/.claude/settings.json 的 ARK_API_KEY；无 key 返回 undefined。
 */
function makeArkBackend(): ArkBackend | undefined {
  const envKey = process.env.ARK_API_KEY
  if (envKey !== undefined && envKey.length > 0) return new ArkBackend({ apiKey: envKey })
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json')
    if (!existsSync(settingsPath)) return undefined
    const raw = execFileSync(process.execPath, ['-e', `const s=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(s.ARK_API_KEY||''))`, settingsPath], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    return raw.length > 0 ? new ArkBackend({ apiKey: raw }) : undefined
  } catch {
    return undefined
  }
}

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
  /**
   * 设备配对（远程访问片 A，docs/远程访问-设计.md）：开启后 /api/pair/* 端点族可用，
   * 且非 loopback 请求可凭有效设备会话放行（替代共享静态 token 的逐设备凭据形态）。
   * 显式开启才生效——既有 fail-closed 纪律（非 loopback 必须 token 或 pairing）不放松。
   */
  pairing?: boolean
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
const PET_ASSET_MIME: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8',
}

/** 桌宠资产静态面：pet-assets/<character>/**（dataDir 内，防穿越；不存在 → 404 由回落机制兜底）。 */
function servePetAsset(res: ServerResponse, petRoot: string, relPath: string): void {
  const safe = relPath.split('/').filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..')
  if (safe.length === 0) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  const p = join(petRoot, ...safe)
  try {
    if (!existsSync(p) || !statSync(p).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const ext = p.slice(p.lastIndexOf('.')).toLowerCase()
    res.writeHead(200, { 'content-type': PET_ASSET_MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(readFileSync(p))
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('internal error')
  }
}

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
export function guard(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  loopbackOnly: boolean,
  /** 远程访问片 A：配对设备会话校验（非 loopback 放行的第二凭据路径）。 */
  deviceSession?: { validate(deviceId: string, secret: string): boolean },
): boolean {
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
  // 配对设备会话（远程访问片 A）：Cookie pod-device=<id>.<secret> 恒时校验
  if (deviceSession !== undefined) {
    const raw = readCookie(req, 'pod-device')
    if (raw !== undefined) {
      const dot = raw.indexOf('.')
      if (dot > 0) {
        const id = raw.slice(0, dot)
        const secret = raw.slice(dot + 1)
        if (id.length > 0 && secret.length > 0 && deviceSession.validate(id, secret)) return true
      }
    }
  }
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: 'forbidden: loopback-only 或缺少 Bearer token' }))
  return false
}

/** 读取 Cookie 头中指定项（无 Cookie 头 → undefined）。 */
export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (header === undefined || header.length === 0) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/**
 * 配对端点族（远程访问片 A，docs/远程访问-设计.md）：
 *   POST /api/pair/mint    — 铸造一次性令牌（**loopback-only**；同时仅一枚，TTL 10min）
 *   POST /api/pair/accept  — 一次性令牌 → 设备凭据（Set-Cookie pod-device=<id>.<secret>）
 *   POST /api/pair/revoke  — 撤销设备（**loopback-only**；body.deviceId 缺省=全部）
 *   GET  /api/pair/devices — 设备列表（**loopback-only**；凭据字段剥离）
 *
 * 纪律：accept 是唯一非 loopback 可达端点（凭一次性令牌自证）；mint/revoke/devices
 * 物理限回环（对齐 dsh-remote-web-ui「铸造面仅限本机」）。Cookie HttpOnly+SameSite=Lax。
 */
function handlePairRoute(
  store: PairingStore,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): void {
  const addr = req.socket.remoteAddress ?? ''
  const isLoopback = isLoopbackRemoteAddress(addr)
  const json = (status: number, body: unknown, headers?: Record<string, string>): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(headers ?? {}) })
    res.end(JSON.stringify(body))
  }
  const readBody = (): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      req.on('data', (c: Buffer) => {
        total += c.length
        if (total > 64 * 1024) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve(raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>))
        } catch (e) {
          reject(e)
        }
      })
      req.on('error', reject)
    })
  const loopbackOnlyError = (): void =>
    json(403, { error: 'pairing management is loopback-only（配对面板仅限本机使用）' })

  if (pathname === '/api/pair/mint' && req.method === 'POST') {
    if (!isLoopback) return loopbackOnlyError()
    const { token, expiresAt } = store.mintToken()
    json(200, { token, expiresAt, url: '/?pair=' + token })
    return
  }
  if (pathname === '/api/pair/accept' && req.method === 'POST') {
    void readBody()
      .then((body) => {
        const token = typeof body.token === 'string' ? body.token : ''
        if (token.length === 0) return json(422, { error: 'token is required' })
        const ua = req.headers['user-agent']
        try {
          const d = store.accept(token, typeof ua === 'string' ? ua : undefined)
          // HttpOnly（防 XSS 窃凭据）+ SameSite=Lax + Path 全站 + 30 天会话
          json(200, { ok: true, deviceId: d.deviceId, name: d.name }, {
            'set-cookie': `pod-device=${d.deviceId}.${d.secret}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}`,
          })
        } catch (error) {
          json(403, { error: error instanceof Error ? error.message : 'pairing failed' })
        }
      })
      .catch(() => json(400, { error: 'invalid json' }))
    return
  }
  if (pathname === '/api/pair/revoke' && req.method === 'POST') {
    if (!isLoopback) return loopbackOnlyError()
    void readBody()
      .then((body) => {
        const deviceId = typeof body.deviceId === 'string' && body.deviceId.length > 0 ? body.deviceId : undefined
        const revoked = store.revoke(deviceId)
        json(200, { ok: true, revoked })
      })
      .catch(() => json(400, { error: 'invalid json' }))
    return
  }
  if (pathname === '/api/pair/devices' && req.method === 'GET') {
    if (!isLoopback) return loopbackOnlyError()
    json(200, { devices: store.listDevices() })
    return
  }
  json(404, { error: 'not found' })
}

export interface StandaloneServer {
  server: Server
  /** 监听端口（listenStandalone 用 port 0 启动后回填为实际端口）。 */
  port: number
  host: string
  runtime: PodRuntime
  /** 员工侧 MCP HTTP 端点（/mcp 路由的 handle；pod_mem_* 三件套宿主面）。 */
  mcp: McpHttpHandle
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
  const arkBackend = makeArkBackend()
  const service = new PodService({
    store: runtime.store,
    memory: runtime.memory,
    dataDir: runtime.dataDir,
    demo: options.demo === true,
    backends: options.demo === true
      ? { claude: new DemoBackend('claude'), codex: new DemoBackend('codex'), opencode: new DemoBackend('opencode') }
      : {
          claude: new ClaudeHeadlessBackend({
            allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
            // 员工侧 MCP 接线（2026-09-03）：worker-mcp.json（listen 后写出，含实际端口/token）；
            // 文件存在 → start 时 --mcp-config 注入 + allowedTools 追加 pod_mem_* 三件套。
            mcpConfigPath: join(runtime.dataDir, 'worker-mcp.json'),
          }),
          codex: new CodexHeadlessBackend({ binary: codexBinaryCandidates(process.platform).find((c) => existsSync(c)) ?? 'codex' }),
          opencode: new OpenCodeHeadlessBackend({ binary: opencodeBin ?? 'opencode' }),
          // ark：补 standalone 缺失（v5 实证「no backend registered for vendor ark」）
          ...(arkBackend !== undefined ? { ark: arkBackend } : {}),
        },
  })
  // 员工侧 MCP HTTP 端点（/mcp）：pod_mem_* 三件套宿主面。token 与主面同源（guard 先行）。
  const mcp: McpHttpHandle = createMcpHttpServer(service, { token })
  // 远程访问片 A：设备配对存储（显式 --pairing 才启用；数据落 <dataDir>/pairing.json）
  const pairingStore = options.pairing === true ? new PairingStore({ dataDir: runtime.dataDir }) : undefined
  pairingStore?.open()
  const routes = makePodRoutes(() => service)
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    // 配对端点族（远程访问片 A）：在主守卫之前处理——accept 凭一次性令牌（无设备会话）、
    // mint/revoke 自带 loopback-only 自守卫。设计文档 §3 片 A / §4 安全模型。
    if (pairingStore !== undefined && pathname.startsWith('/api/pair/')) {
      handlePairRoute(pairingStore, req, res, pathname)
      return
    }
    if (!guard(req, res, token, loopbackOnly, pairingStore)) return
    if (pathname === '/' || pathname === '/index.html') {
      serveStatic(res, pathname, staticDir)
      return
    }
    if (pathname === '/standalone.js') {
      serveStatic(res, pathname, staticDir)
      return
    }
    // 桌宠角色资产静态面（2026-09-05 多角色切片）：<dataDir>/pet-assets/<character>/**。
    // 客户端同源优先加载（生态 raw.githubusercontent 在部分网络不可达）；路径穿越有守卫。
    if (pathname.startsWith('/pet-assets/')) {
      servePetAsset(res, join(runtime.dataDir, 'pet-assets'), pathname.slice('/pet-assets/'.length))
      return
    }
    // 员工侧 MCP 端点（2026-09-03）：pod_* 工具面（含 pod_mem_* 三件套）经 streamable HTTP
    // 暴露给 worker 子进程（claude --mcp-config 指向 worker-mcp.json）。guard 已在此前
    // 统一执行（loopback + Host + Origin 校验同主面）。
    if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
      // .catch 兜底（2026-09-05 修复）：handle 内部只包了 transport.handleRequest，
      // initialize 的 server.connect 与 DELETE 的 server.close 可在 try 外 reject——
      // 无 catch 的 floating promise 会以 unhandledRejection 终止整个 standalone 进程。
      void mcp.handle(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'internal error' }))
        }
      })
      return
    }
    // A2A 协议面路径（发现端点 + sendMessage/Stream + JSON-RPC）与既有 API 前缀并列放行
    const isPodPath =
      pathname.startsWith('/api/dsh-pod/') ||
      pathname === '/.well-known/agent-card' ||
      pathname === '/a2a' ||
      pathname.startsWith('/a2a/')
    if (!isPodPath) {
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
    mcp,
    close: async () => {
      clearInterval(maintenanceTimer)
      if (server.listening) server.close()
      await mcp.close()
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
  // 员工侧 MCP 接线（2026-09-03）：listen 后端口已定，写出 worker-mcp.json（claude worker
  // spawn 时读它拼 --mcp-config）。demo 模式无真实 worker 不写；文件存在性即灰度开关
  // （删除即回退旧版行为）。非 loopback 部署带 token（与主面同源）。
  if (options.demo !== true) {
    const mcpConfigPath = join(s.runtime.dataDir, 'worker-mcp.json')
    const url = `http://127.0.0.1:${s.port}/mcp`
    const config =
      s.mcp.token.length > 0
        ? { mcpServers: { 'dsh-pod': { type: 'http', url, headers: { Authorization: `Bearer ${s.mcp.token}` } } } }
        : { mcpServers: { 'dsh-pod': { type: 'http', url } } }
    writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2) + '\n')
  }
  return s
}
