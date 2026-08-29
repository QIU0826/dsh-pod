/**
 * HTTP 入口安全共享守卫（P1 加固）。
 *
 * 威胁模型：本地服务默认「loopback 即可信」，但浏览器侧有两个绕过面——
 *   1. DNS rebinding：evil.com 的 A 记录切到 127.0.0.1，受害者浏览器访问
 *      http://evil.com:3930 实际打到本机服务，且同源策略认为与服务同源（可读响应）；
 *   2. CSRF：text/plain / form-encoded 属 CORS simple request，恶意网页可无预检
 *      跨站 POST（写操作生效）。
 * 防护组合：loopback 无 token 模式下强制 Host 白名单 + Origin 校验；
 * 带 body 的请求强制 application/json（触发 CORS 预检，浏览器拦截跨站）。
 */
import type { IncomingMessage } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

/** 连接对端是否 loopback（TCP 层事实，不可伪造；不信任任何请求头）。 */
export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 监听地址是否 loopback（CLI/库层 fail-closed 与请求守卫共用；缺省 = loopback）。 */
export function isLoopbackBindHost(host: string | undefined): boolean {
  if (host === undefined || host.length === 0) return true
  const h = host.toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]' || h === '::ffff:127.0.0.1'
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end === -1 ? host : host.slice(0, end + 1)
  }
  const colon = host.lastIndexOf(':')
  return colon === -1 ? host : host.slice(0, colon)
}

/** 防御性取头（畸形请求/测试假件可能缺 headers 对象，守卫不因读取而崩）。 */
function header(req: IncomingMessage, name: string): string {
  const headers = (req as { headers?: Record<string, string | string[] | undefined> }).headers
  if (headers === undefined) return ''
  const raw = headers[name]
  return Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
}

/** DNS rebinding 防护：Host 头（去端口后）必须是本机名；缺失/外域拒绝。 */
export function isLocalHostHeader(req: IncomingMessage): boolean {
  const trimmed = header(req, 'host').trim().toLowerCase()
  if (trimmed.length === 0) return false
  return isLocalHostname(stripPort(trimmed))
}

/**
 * 浏览器 CSRF 防护：带 Origin 的请求必须与本机源一致；原生客户端（curl/MCP）无
 * Origin 放行。Origin: null 拒绝——攻击者可用沙箱 iframe 产生 null Origin 绕过。
 */
export function hasAllowedLoopbackOrigin(req: IncomingMessage): boolean {
  const trimmed = header(req, 'origin').trim()
  if (trimmed.length === 0) return true
  if (trimmed === 'null') return false
  try {
    return isLocalHostname(new URL(trimmed).hostname)
  } catch {
    return false
  }
}

function isJsonContentType(req: IncomingMessage): boolean {
  return header(req, 'content-type').toLowerCase().startsWith('application/json')
}

function requestHasBody(req: IncomingMessage): boolean {
  if (header(req, 'transfer-encoding').length > 0) return true
  const value = header(req, 'content-length')
  return value.length > 0 && value !== '0'
}

/** 带 body 的请求必须声明 application/json（空体/无体请求放行，无注入面）。 */
export function allowsJsonBody(req: IncomingMessage): boolean {
  return !requestHasBody(req) || isJsonContentType(req)
}

/** Bearer token 恒时比较（长度不等先短路——本地威胁模型下侧信道意义有限，成本为零）。 */
export function bearerTokenEquals(expected: string, req: IncomingMessage): boolean {
  const a = Buffer.from('Bearer ' + expected, 'utf8')
  const b = Buffer.from(header(req, 'authorization').trim(), 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}
