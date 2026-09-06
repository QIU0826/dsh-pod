/**
 * 设备配对与会话（远程访问片 A，docs/远程访问-设计.md）——参照 dsh-remote-web-ui 机制：
 *
 *   铸造面（loopback-only）：mint 一次性令牌（同时仅一枚，TTL 默认 10 分钟）；
 *   配对面（凭令牌，无 Cookie）：accept → 换发设备凭据（deviceId + secret）；
 *   撤销面（loopback-only）：revoke 单设备 / 全部；
 *   校验面（守卫每请求调用）：validate(deviceId, secret) 恒时比较 + lastSeen 更新。
 *
 * 状态持久化 `<dataDir>/pairing.json`（atomicWrite 同款：tmp→bak→rename，绝不静默丢会话）。
 * 安全模型（设计文档 §4）：设备会话是完全控制凭据——逐设备可撤销、永不渲染原始凭据；
 * 令牌过期/撤销后 accept 一律拒绝（fail-closed）。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './atomic-write.js'
import { PodError } from './errors.js'

export interface PairToken {
  value: string
  mintedAt: number
  expiresAt: number
}

export interface PairDevice {
  /** 设备 id（UUID 形态；凭据第一半）。 */
  id: string
  /** 设备凭据第二半（随机 hex；与 id 一起随 Cookie/头提交）。 */
  secret: string
  /** 设备名（由 User-Agent 推断，供 UI 列表展示；原始 UA 不落盘不渲染）。 */
  name: string
  pairedAt: number
  lastSeenAt: number
  revoked: boolean
}

export interface PairingData {
  schemaVersion: 1
  token: PairToken | null
  devices: Record<string, PairDevice>
}

export interface PairingStoreOptions {
  /** 持久化目录（<dataDir>）；pairing.json 放这里。 */
  dataDir: string
  clock?: () => number
  idFn?: () => string
  /** 令牌 TTL（默认 10 分钟）。 */
  tokenTtlMs?: number
}

export const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000

function emptyData(): PairingData {
  return { schemaVersion: 1, token: null, devices: {} }
}

/** 设备名推断（UA → 短名；不存原始 UA）。 */
export function deviceNameFromUa(ua: string | undefined): string {
  const s = ua ?? ''
  if (/iphone/i.test(s)) return 'iPhone'
  if (/ipad/i.test(s)) return 'iPad'
  if (/android/i.test(s)) return /mobile/i.test(s) ? 'Android 手机' : 'Android 平板'
  if (/mobile|safari/i.test(s)) return '移动浏览器'
  return '电脑设备'
}

export class PairingStore {
  private readonly dataDir: string
  private readonly clock: () => number
  private readonly idFn: () => string
  private readonly tokenTtlMs: number
  private data: PairingData | undefined

  constructor(options: PairingStoreOptions) {
    this.dataDir = options.dataDir
    this.clock = options.clock ?? (() => Date.now())
    this.idFn = options.idFn ?? (() => cryptoRandomHex(16))
    this.tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS
  }

  private get path(): string {
    return join(this.dataDir, 'pairing.json')
  }

  open(): void {
    this.data = this.load() ?? emptyData()
  }

  private load(): PairingData | undefined {
    // 崩溃窗口自愈与 memory.json 同款：主文件缺失先试 .bak（atomicWrite 双 rename 间隙）
    for (const p of [this.path, `${this.path}.bak`]) {
      if (!existsSync(p)) continue
      try {
        const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'))
        if (typeof parsed === 'object' && parsed !== null && (parsed as PairingData).schemaVersion === 1) {
          const d = parsed as PairingData
          return { schemaVersion: 1, token: d.token ?? null, devices: d.devices ?? {} }
        }
      } catch {
        /* 损坏：试下一候选（.bak），全坏则空库起步（fail-safe：重新配对即可，不阻塞启动） */
      }
    }
    return undefined
  }

  private persist(): void {
    atomicWrite(this.path, JSON.stringify(this.data, null, 2) + '\n', {
      backupPath: `${this.path}.bak`,
      fsync: false,
    })
  }

  private require(): PairingData {
    if (this.data === undefined) throw new Error('pairing store not opened: call open() first')
    return this.data
  }

  /**
   * 铸造一次性配对令牌（loopback-only 调用）：同时仅一枚——重复铸造使旧令牌失效。
   * 返回明文凭据（仅此一次；不落日志）。
   */
  mintToken(): { token: string; expiresAt: number } {
    const data = this.require()
    const now = this.clock()
    const token = cryptoRandomHex(24)
    data.token = { value: token, mintedAt: now, expiresAt: now + this.tokenTtlMs }
    this.persist()
    return { token, expiresAt: data.token.expiresAt }
  }

  /**
   * 配对：一次性令牌 → 设备会话。令牌过期/不匹配/已撤销 → 拒绝（fail-closed）。
   * 同 deviceId 再配对 = 换发 secret（原凭据失效）。
   */
  accept(token: string, ua: string | undefined): { deviceId: string; secret: string; name: string } {
    const data = this.require()
    const now = this.clock()
    const t = data.token
    if (t === null || t.value !== token || now > t.expiresAt) {
      throw new PodError('pairing token invalid or expired', 'PAIR_TOKEN_INVALID', {}, false)
    }
    data.token = null // 一次性：配对即作废（设计文档 §4.1）
    const deviceId = this.idFn()
    const secret = cryptoRandomHex(24)
    const name = deviceNameFromUa(ua)
    data.devices[deviceId] = { id: deviceId, secret, name, pairedAt: now, lastSeenAt: now, revoked: false }
    this.persist()
    return { deviceId, secret, name }
  }

  /** 守卫校验：设备会话有效（未撤销、凭据恒时匹配）。命中即更新 lastSeen。 */
  validate(deviceId: string, secret: string): boolean {
    const data = this.require()
    const d = data.devices[deviceId]
    if (d === undefined || d.revoked) return false
    if (!timingSafeEqualHex(d.secret, secret)) return false
    d.lastSeenAt = this.clock()
    return true
  }

  /** 撤销：deviceId 缺省 = 撤销全部（「停止」按钮语义）。 */
  revoke(deviceId?: string): number {
    const data = this.require()
    let n = 0
    for (const d of Object.values(data.devices)) {
      if (d.revoked) continue
      if (deviceId === undefined || d.id === deviceId) {
        d.revoked = true
        n += 1
      }
    }
    if (n > 0) this.persist()
    return n
  }

  /** 设备列表（UI 面）：凭据字段剥离，永不渲染。 */
  listDevices(): Array<{ id: string; name: string; pairedAt: number; lastSeenAt: number; revoked: boolean }> {
    return Object.values(this.require().devices)
      .map(({ id, name, pairedAt, lastSeenAt, revoked }) => ({ id, name, pairedAt, lastSeenAt, revoked }))
      .sort((a, b) => b.pairedAt - a.pairedAt)
  }
}

/** 恒时比较（先做等长检查——timingSafeEqual 长度不等会抛错，长度不同即视为不等）。 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

function cryptoRandomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}
