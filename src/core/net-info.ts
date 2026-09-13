/**
 * 网络信息（远程访问片 B，docs/远程访问-设计.md）：standalone 展示「局域网可达地址」的事实源。
 *
 * 纯函数 + 注入式网卡表——单测不依赖宿主机真实网卡（对齐本仓库「可注入即纯」纪律）。
 * 只做读取与拼装，绝不做静默提权/自动改防火墙（设计文档 §3 片 B：命令列给用户自行执行）。
 */

import { networkInterfaces } from 'node:os'

/** 网卡条目最小形状（结构上兼容 node:os NetworkInterfaceInfo，便于注入 fake）。 */
export interface NetworkInterfaceLike {
  address: string
  /** Node 18 早期为数字 4/6，其后为 'IPv4'/'IPv6' —— 两种都认。 */
  family: string | number
  internal: boolean
}

/** 局域网候选地址（网卡名 + IPv4）。 */
export interface LanAddress {
  iface: string
  address: string
}

/** 是否为 IPv4（兼容 family 的字符串/数字两种取值）。 */
function isIPv4(family: string | number): boolean {
  return family === 'IPv4' || family === 4
}

/**
 * 非内部 IPv4 地址列表（局域网可达候选）。
 * 过滤 `internal`（回环/链路本地），按网卡名稳定排序——UI 展示与单测可预期。
 */
export function lanIPv4Addresses(
  ifaces: Record<string, NetworkInterfaceLike[] | undefined> = networkInterfaces(),
): LanAddress[] {
  const out: LanAddress[] = []
  for (const [iface, infos] of Object.entries(ifaces)) {
    for (const info of infos ?? []) {
      if (!isIPv4(info.family) || info.internal) continue
      out.push({ iface, address: info.address })
    }
  }
  return out.sort((a, b) => (a.iface === b.iface ? a.address.localeCompare(b.address) : a.iface.localeCompare(b.iface)))
}

/** standalone 网络信息端点的响应体（客户端 NetInfo 对应）。 */
export interface NetInfo {
  /** 当前绑定地址（如 127.0.0.1 / 0.0.0.0）。 */
  host: string
  /** 实际监听端口。 */
  port: number
  /** 是否仅回环可访问（true = 手机/LAN 不可达）。 */
  loopbackOnly: boolean
  /** 局域网候选地址（非内部 IPv4）。 */
  lanIps: string[]
  /** 设备配对（--pairing）是否开启。 */
  pairing: boolean
}
