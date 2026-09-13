/**
 * 远程访问面板（远程访问片 B，2026-09-06）：桌面（回环）侧的配对面板。
 *
 * - 铸造：一次性令牌 → 二维码（手机扫码直达 `?pair=` 自动配对）+ 可复制链接；
 *   同时仅一枚——重复铸造使旧二维码失效（面板明示）。
 * - 设备列表：名称/最近活跃/逐设备撤销 + 全部撤销（凭据字段服务端已剥离）。
 * - 未开启 --pairing → 显示开启指引（诚实化，不渲染失效面板）。
 *
 * 竖屏/移动端此面板不出现（手机本身就是配对主体，见 console-css 触控适配层）。
 */
import { QRCodeSVG } from 'qrcode.react'
import { createElement, useEffect, useState, type ReactElement } from 'react'
import { Icon } from './icons.js'
import { fetchNetInfo, listPairDevices, pairUrl, postPairMint, postPairRevoke, type NetInfo, type PairDevice } from './api.js'

export type RemotePanelState = 'idle' | 'minting' | 'active' | 'error'

export interface RemotePanelProps {
  /** 是否开启设备配对（standalone --pairing；未开启渲染指引）。 */
  pairingEnabled: boolean
}

/** 面板标题与文案（纯数据，单测可断言）。 */
export const REMOTE_PANEL_COPY = {
  title: '远程访问',
  hint: '手机扫码（或复制链接到手机浏览器打开）即可获得同一控制台：桌宠房间 / 对话 / 审批全功能。配对是一次性凭据，停止后立即失效。',
  mint: '生成配对二维码',
  stop: '停止并撤销全部设备',
  expired: '二维码已失效，请重新生成',
} as const

/** 扫码提示行（手机端完成配对后的预期状态）。 */
export function pairingHintText(devices: PairDevice[]): string {
  const active = devices.filter((d) => !d.revoked)
  if (active.length === 0) return '等待设备连接…'
  const latest = active.reduce((a, b) => (b.lastSeenAt > a.lastSeenAt ? b : a))
  return `已连接 ${active.length} 台设备（最近：${latest.name}）`
}

// ─── 局域网访问（远程访问片 B，2026-09-13）──────────────────────────────
// 只读展示 + 命令列给用户自行执行——不做静默提权、不自动改防火墙、不代启动隧道。

/** 局域网访问区块文案（纯数据，单测可断言）。 */
export const LAN_ACCESS_COPY = {
  title: '局域网访问',
  loopbackHint: '当前仅本机（回环）可访问——同一网络下的手机/平板无法连入。',
  boundHint: '已绑定到局域网地址，同一网络下的手机可直接打开下面的地址。',
  enableHint: '要让手机连入，以局域网地址重启控制台（非回环监听必须带 token，否则拒绝启动）：',
  firewallHint: 'Windows 还需放行防火墙端口（需「管理员」终端，由你自行执行）：',
  tunnelHint:
    '公网触达：自备 cloudflared quick tunnel / 命名隧道指向本端口即可；控制台只显示可达地址，不代你启动隧道。',
  copy: '复制',
  copied: '已复制',
} as const

/** 开启局域网访问的启动命令（用户自行执行）。 */
export function lanEnableCommand(port: number): string {
  return `dsh-pod --host 0.0.0.0 --token <你的令牌> --port ${port}`
}

/** Windows 防火墙放行命令（需管理员，用户自行执行）。 */
export function firewallCommand(port: number): string {
  return `netsh advfirewall firewall add rule name="dsh-pod" dir=in action=allow protocol=TCP localport=${port}`
}

/** 绑定 LAN 后手机可达地址（逐 IP，同端口）。 */
export function lanUrls(ips: readonly string[], port: number): string[] {
  return ips.map((ip) => `http://${ip}:${port}`)
}

/** 一行可复制命令（含复制按钮）。 */
function CommandRow(label: string, command: string): ReactElement {
  return createElement(
    'div',
    { className: 'dsh-net-row' },
    createElement('div', { className: 'dsh-net-label' }, label),
    createElement('div', { className: 'dsh-net-cmd' },
      createElement('code', { title: command }, command),
      createElement(CopyButton, { text: command }),
    ),
  )
}

/** 复制按钮（无剪贴板权限时静默失败，不阻塞渲染）。 */
function CopyButton(props: { text: string }): ReactElement {
  const [done, setDone] = useState(false)
  return createElement('button', {
    className: 'dsh-btn sm ghost', type: 'button',
    onClick: () => {
      void navigator.clipboard?.writeText(props.text).then(() => setDone(true)).catch(() => setDone(false))
    },
  }, done ? LAN_ACCESS_COPY.copied : LAN_ACCESS_COPY.copy)
}

/** 局域网访问区块：当前绑定 + 开启指引 + 可达地址（net 由能力探测注入）。 */
export function LanAccessSection(props: { net: NetInfo }): ReactElement {
  const { net } = props
  const urls = lanUrls(net.lanIps, net.port)
  return createElement(
    'div',
    { className: 'dsh-net-panel', 'data-testid': 'lan-access' },
    createElement('h3', null, LAN_ACCESS_COPY.title),
    createElement('p', { className: 'dsh-remote-hint' },
      net.loopbackOnly ? LAN_ACCESS_COPY.loopbackHint : LAN_ACCESS_COPY.boundHint),
    createElement('div', { className: 'dsh-net-current' },
      createElement('span', null, '当前绑定：'), createElement('code', null, `${net.host}:${net.port}`)),
    createElement('div', null,
      net.loopbackOnly
        ? CommandRow(LAN_ACCESS_COPY.enableHint, lanEnableCommand(net.port))
        : null,
      // 防火墙放行与绑定与否无关（Windows 常在绑定后仍拦入站），故始终给出
      CommandRow(LAN_ACCESS_COPY.firewallHint, firewallCommand(net.port)),
    ),
    urls.length > 0
      ? createElement('div', { className: 'dsh-net-urls' },
          createElement('div', { className: 'dsh-net-label' },
            net.loopbackOnly ? '开启后手机可达地址（本机局域网 IP）：' : '手机可达地址：'),
          ...urls.map((u) => createElement('div', { className: 'dsh-net-url', key: u },
            createElement('code', { title: u }, u), createElement(CopyButton, { text: u }))),
        )
      : createElement('p', { className: 'dsh-remote-hint' }, '未探测到局域网 IPv4 地址。'),
    createElement('p', { className: 'dsh-remote-hint' }, LAN_ACCESS_COPY.tunnelHint),
  )
}

export function RemotePanel(props: RemotePanelProps): ReactElement {
  const { pairingEnabled } = props
  const [state, setState] = useState<RemotePanelState>('idle')
  const [mint, setMint] = useState<{ url: string; expiresAt: number } | undefined>()
  const [devices, setDevices] = useState<PairDevice[]>([])
  const [error, setError] = useState<string | undefined>()
  const [copied, setCopied] = useState(false)
  // 网络信息（片 B）：能力探测——插件形态无 /api/dsh-pod/net（404）→ 区块隐藏
  const [net, setNet] = useState<NetInfo | undefined>()

  async function refreshDevices(): Promise<void> {
    try {
      setDevices((await listPairDevices()).devices)
    } catch {
      setDevices([])
    }
  }

  useEffect(() => {
    if (pairingEnabled) void refreshDevices()
  }, [pairingEnabled])

  useEffect(() => {
    void fetchNetInfo().then(setNet).catch(() => setNet(undefined))
  }, [])

  const lanSection = net !== undefined ? createElement(LanAccessSection, { net }) : null

  if (!pairingEnabled) {
    return createElement(
      'div',
      { className: 'dsh-remote-panel' },
      lanSection,
      createElement('h3', null, REMOTE_PANEL_COPY.title),
      createElement('p', { className: 'dsh-remote-hint' },
        '当前未开启设备配对。以 ', createElement('code', null, '--pairing'), ' 重启控制台后，这里会出现配对二维码（手机扫码即得同一控制台）。',
      ),
    )
  }

  const doMint = (): void => {
    setState('minting')
    setError(undefined)
    void postPairMint()
      .then((m) => {
        setMint({ url: pairUrl(window.location.origin, m.token), expiresAt: m.expiresAt })
        setState('active')
        setCopied(false)
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
        setState('error')
      })
  }

  const doStop = (): void => {
    void postPairRevoke().then(() => {
      setMint(undefined)
      setState('idle')
      void refreshDevices()
    })
  }

  return createElement(
    'div',
    { className: 'dsh-remote-panel' },
    lanSection,
    createElement('h3', null, REMOTE_PANEL_COPY.title),
    createElement('p', { className: 'dsh-remote-hint' }, REMOTE_PANEL_COPY.hint),
    state === 'error'
      ? createElement('p', { className: 'dsh-remote-error' }, '配对失败：', error)
      : null,
    mint === undefined
      ? createElement('button', { className: 'dsh-btn primary', type: 'button', onClick: doMint, disabled: state === 'minting' },
          Icon('plus', 14), state === 'minting' ? '生成中…' : REMOTE_PANEL_COPY.mint)
      : createElement(
          'div',
          { className: 'dsh-remote-qr-card' },
          createElement('div', { className: 'dsh-remote-qr', 'data-testid': 'remote-qr' },
            createElement(QRCodeSVG, { value: mint.url, size: 184, level: 'M', marginSize: 1 })),
          createElement('div', { className: 'dsh-remote-url', title: mint.url }, mint.url),
          createElement('div', { className: 'dsh-remote-actions' },
            createElement('button', {
              className: 'dsh-btn sm', type: 'button',
              onClick: () => {
                void navigator.clipboard?.writeText(mint.url).then(() => setCopied(true))
              },
            }, copied ? '已复制' : '复制链接'),
            createElement('button', { className: 'dsh-btn sm ghost', type: 'button', onClick: doMint }, Icon('refresh', 13), ' 刷新二维码'),
            createElement('button', { className: 'dsh-btn sm danger', type: 'button', onClick: doStop }, REMOTE_PANEL_COPY.stop)),
        ),
    createElement('div', { className: 'dsh-remote-devices' },
      createElement('div', { className: 'dsh-remote-devices-title' }, pairingHintText(devices)),
      ...devices.map((d) =>
        createElement('div', { className: 'dsh-remote-device' + (d.revoked ? ' revoked' : ''), key: d.id },
          createElement('span', { className: 'dsh-remote-device-name' }, d.name),
          createElement('span', { className: 'dsh-remote-device-meta' }, d.revoked ? '已撤销' : new Date(d.lastSeenAt).toLocaleTimeString()),
          d.revoked
            ? null
            : createElement('button', {
                className: 'dsh-btn sm ghost', type: 'button',
                onClick: () => {
                  void postPairRevoke(d.id).then(refreshDevices)
                },
              }, Icon('x', 12), ' 取消配对'),
        ),
      ),
    ),
  )
}
