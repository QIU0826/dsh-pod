/**
 * 网络信息（远程访问片 B）回归测试：
 *   - lanIPv4Addresses：过滤内部/非 IPv4、family 数字与字符串两取值、稳定排序
 *   - /api/dsh-pod/net：真实 HTTP 暴露绑定/端口/局域网候选/配对开关（仅 standalone 注册）
 *   - 局域网访问命令（纯函数）：只生成、由用户自行执行（不静默提权/不改防火墙）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lanIPv4Addresses } from '../src/core/net-info.js'
import { listenStandalone } from '../src/standalone/server.js'
import { firewallCommand, lanEnableCommand, lanUrls } from '../src/web/remote-panel.js'

describe('lanIPv4Addresses（局域网候选地址）', () => {
  it('过滤 internal 与非 IPv4，只留真实网卡 IPv4', () => {
    const out = lanIPv4Addresses({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      eth0: [
        { address: '192.168.1.5', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
      ],
    })
    expect(out).toEqual([{ iface: 'eth0', address: '192.168.1.5' }])
  })

  it('兼容 family 数字取值（Node 18.0-18.3）', () => {
    const out = lanIPv4Addresses({ eth0: [{ address: '10.0.0.2', family: 4, internal: false }] })
    expect(out).toEqual([{ iface: 'eth0', address: '10.0.0.2' }])
  })

  it('按网卡名稳定排序；缺省/空表返回空', () => {
    const out = lanIPv4Addresses({
      wifi: [{ address: '192.168.1.9', family: 'IPv4', internal: false }],
      eth0: [{ address: '192.168.1.2', family: 'IPv4', internal: false }],
      tun: undefined,
    })
    expect(out.map((a) => a.iface)).toEqual(['eth0', 'wifi'])
    expect(lanIPv4Addresses({})).toEqual([])
  })
})

describe('局域网访问命令（纯函数，用户自行执行）', () => {
  it('开启命令带 --host 0.0.0.0 + token + 端口', () => {
    expect(lanEnableCommand(3930)).toBe('dsh-pod --host 0.0.0.0 --token <你的令牌> --port 3930')
  })

  it('防火墙命令只生成、不执行（含端口）', () => {
    const cmd = firewallCommand(3930)
    expect(cmd).toContain('netsh advfirewall firewall add rule')
    expect(cmd).toContain('localport=3930')
  })

  it('可达地址逐 IP 拼接', () => {
    expect(lanUrls(['192.168.1.5', '10.0.0.2'], 3930)).toEqual([
      'http://192.168.1.5:3930',
      'http://10.0.0.2:3930',
    ])
  })
})

describe('GET /api/dsh-pod/net（standalone 网络信息端点）', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pod-net-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('loopback 绑定：返回 host/port/loopbackOnly/lanIps/pairing', async () => {
    const s = await listenStandalone({ host: '127.0.0.1', port: 0, dataDir: dir })
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/dsh-pod/net`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        host: string
        port: number
        loopbackOnly: boolean
        lanIps: string[]
        pairing: boolean
      }
      expect(body.host).toBe('127.0.0.1')
      expect(body.port).toBe(s.port)
      expect(body.loopbackOnly).toBe(true)
      expect(Array.isArray(body.lanIps)).toBe(true)
      expect(body.pairing).toBe(false)
    } finally {
      await s.close()
    }
  })

  it('--pairing 开启时 pairing=true', async () => {
    const s = await listenStandalone({ host: '127.0.0.1', port: 0, dataDir: dir, pairing: true })
    try {
      const body = (await (await fetch(`http://127.0.0.1:${s.port}/api/dsh-pod/net`)).json()) as { pairing: boolean }
      expect(body.pairing).toBe(true)
    } finally {
      await s.close()
    }
  })
})
