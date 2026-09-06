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
import { listPairDevices, pairUrl, postPairMint, postPairRevoke, type PairDevice } from './api.js'

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

export function RemotePanel(props: RemotePanelProps): ReactElement {
  const { pairingEnabled } = props
  const [state, setState] = useState<RemotePanelState>('idle')
  const [mint, setMint] = useState<{ url: string; expiresAt: number } | undefined>()
  const [devices, setDevices] = useState<PairDevice[]>([])
  const [error, setError] = useState<string | undefined>()
  const [copied, setCopied] = useState(false)

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

  if (!pairingEnabled) {
    return createElement(
      'div',
      { className: 'dsh-remote-panel' },
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
