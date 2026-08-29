/**
 * Agent 虚拟形象 —— 毕加索（立体主义）风格动物头像，纯几何多边形拼接：
 * 正侧脸同框、双色切面、错位不对称的双眼、撞色。每个 agent 可自选动物；
 * 动作随工作状态变化（呼吸/敲击/前倾/张望/抖动/打盹），动画在 CSS（console-css.ts）。
 */
import { createElement, type ReactElement } from 'react'

/** inner SVG（viewBox 0 0 64 64）：多边形切面 + 不对称眼。 */
const ART: Record<string, string> = {
  cat: `
    <polygon points="12,6 24,10 16,26" fill="#22d3ee"/>
    <polygon points="52,4 56,22 40,12" fill="#f59e0b"/>
    <polygon points="10,22 34,20 32,56 14,52" fill="#3b3b4f"/>
    <polygon points="34,20 54,24 52,54 32,56" fill="#252532"/>
    <circle cx="22" cy="34" r="4.5" fill="#e8e8ec"/><circle cx="23" cy="34" r="2" fill="#22d3ee"/>
    <polygon points="44,29 53,33 44,38" fill="#e8e8ec"/><circle cx="46" cy="33" r="1.8" fill="#0b0b0f"/>
    <polygon points="29,44 36,44 32.5,49" fill="#fb7185"/>
    <path d="M8 38 L18 40 M8 44 L18 43 M56 40 L46 42 M56 46 L46 44" stroke="#5e5e6b" stroke-width="1.4"/>`,
  fox: `
    <polygon points="10,26 4,6 22,20" fill="#3b3b4f"/>
    <polygon points="54,26 60,6 42,20" fill="#f59e0b"/>
    <polygon points="32,58 8,26 32,26" fill="#f59e0b"/>
    <polygon points="32,26 56,26 32,58" fill="#fb923c"/>
    <circle cx="22" cy="33" r="3.2" fill="#22d3ee"/>
    <circle cx="43" cy="32" r="4.2" fill="#e8e8ec"/><circle cx="43" cy="32" r="2" fill="#22d3ee"/>
    <polygon points="29,49 36,49 32.5,56" fill="#0b0b0f"/>`,
  owl: `
    <polygon points="24,5 32,16 16,16" fill="#a78bfa"/>
    <polygon points="40,5 48,16 32,16" fill="#22d3ee"/>
    <polygon points="12,14 32,14 32,56 12,54" fill="#3b3b4f"/>
    <polygon points="32,14 52,14 52,54 32,56" fill="#4c4c63"/>
    <circle cx="22" cy="31" r="8" fill="#e8e8ec"/><circle cx="22" cy="31" r="3.6" fill="#22d3ee"/>
    <circle cx="43" cy="30" r="5.6" fill="#22d3ee"/><circle cx="43" cy="30" r="2.4" fill="#e8e8ec"/>
    <polygon points="29,41 36,41 32.5,48" fill="#f59e0b"/>`,
  bear: `
    <circle cx="16" cy="14" r="7.5" fill="#34d399"/>
    <circle cx="48" cy="14" r="7.5" fill="#f59e0b"/>
    <polygon points="8,18 32,18 32,56 8,54" fill="#3b3b4f"/>
    <polygon points="32,18 56,18 56,54 32,56" fill="#252532"/>
    <circle cx="22" cy="32" r="3.2" fill="#e8e8ec"/>
    <circle cx="42" cy="30" r="3.8" fill="#fb7185"/>
    <circle cx="32" cy="44" r="5.4" fill="#e8e8ec"/><circle cx="32" cy="44" r="2.2" fill="#0b0b0f"/>`,
  rabbit: `
    <rect x="18" y="2" width="8" height="26" rx="4" fill="#22d3ee"/>
    <polygon points="38,4 50,8 44,26 38,20" fill="#fb7185"/>
    <polygon points="10,24 32,22 30,56 12,52" fill="#3b3b4f"/>
    <polygon points="32,22 54,26 52,54 30,56" fill="#252532"/>
    <circle cx="21" cy="36" r="3.2" fill="#e8e8ec"/><circle cx="21" cy="36" r="1.6" fill="#22d3ee"/>
    <circle cx="43" cy="34" r="4" fill="#e8e8ec"/><circle cx="43" cy="34" r="2" fill="#a78bfa"/>
    <polygon points="29,46 36,46 32.5,51" fill="#fb7185"/>`,
  wolf: `
    <polygon points="12,8 22,14 13,21" fill="#5e5e6b"/>
    <polygon points="52,8 51,21 42,14" fill="#22d3ee"/>
    <polygon points="10,18 26,12 32,20 38,12 54,18 50,46 32,60 14,46" fill="#3b3b4f"/>
    <polygon points="32,20 38,12 54,18 50,46 32,60" fill="#252532"/>
    <polygon points="15,30 26,32 23,37" fill="#f59e0b"/>
    <circle cx="44" cy="32" r="3.4" fill="#e8e8ec"/><circle cx="44" cy="32" r="1.7" fill="#fb7185"/>
    <polygon points="27,47 37,47 32,58" fill="#0b0b0f"/>`,
  frog: `
    <polygon points="6,26 58,26 54,56 10,56" fill="#34d399"/>
    <polygon points="32,26 58,26 54,56 32,56" fill="#0e9f6e"/>
    <circle cx="20" cy="17" r="8.5" fill="#34d399" stroke="#0b0b0f" stroke-width="1.5"/><circle cx="20" cy="15" r="4" fill="#f59e0b"/>
    <circle cx="44" cy="16" r="10.5" fill="#252532" stroke="#0b0b0f" stroke-width="1.5"/><circle cx="44" cy="14" r="5" fill="#22d3ee"/>
    <polygon points="9,36 18,34 16,44" fill="#f59e0b"/>
    <path d="M17,45 Q32,52 47,45" fill="none" stroke="#0b0b0f" stroke-width="2.2" stroke-linecap="round"/>`,
  deer: `
    <path d="M20,26 L18,6 M20,16 L10,10 M20,18 L28,12" stroke="#22d3ee" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M44,26 L46,6 M44,16 L54,10 M44,18 L36,12" stroke="#f59e0b" stroke-width="3" fill="none" stroke-linecap="round"/>
    <polygon points="20,18 44,18 40,56 24,56" fill="#3b3b4f"/>
    <polygon points="32,18 44,18 40,56 32,56" fill="#4c4c63"/>
    <circle cx="26" cy="32" r="4.4" fill="#e8e8ec"/><circle cx="26" cy="32" r="2.2" fill="#a78bfa"/>
    <circle cx="38" cy="30" r="3.2" fill="#f59e0b"/>
    <circle cx="32" cy="49" r="3.4" fill="#fb7185"/>`,
}

/** 可选形象（点选词表）。 */
export const AVATAR_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'cat', label: '猫' },
  { id: 'fox', label: '狐' },
  { id: 'owl', label: '鸮' },
  { id: 'bear', label: '熊' },
  { id: 'rabbit', label: '兔' },
  { id: 'wolf', label: '狼' },
  { id: 'frog', label: '蛙' },
  { id: 'deer', label: '鹿' },
]

export function avatarLabel(id: string | undefined | null): string {
  if (id === undefined || id === null || id.length === 0) return '未设置'
  return AVATAR_OPTIONS.find((a) => a.id === id)?.label ?? id
}

/** 工作状态 → 动作（CSS 动画类）。 */
export function avatarMotion(status: string | undefined): string {
  if (status === 'working' || status === 'running') return 'work'
  if (status === 'dispatched') return 'lean'
  if (status === 'waiting_approval') return 'look'
  if (status === 'error') return 'shake'
  if (status === 'rate_limited') return 'sleep'
  return 'idle'
}

/** 毕加索动物头像（随 slot 状态做动作）。 */
export function Avatar(animal: string | undefined | null, status: string | undefined, size = 28, frame = true): ReactElement {
  const art = ART[animal ?? ''] ?? ART.cat
  return createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 64 64',
    className: `dsh-av ${avatarMotion(status)}`,
    role: 'img',
    'aria-label': `形象 ${avatarLabel(animal)}`,
    style: frame
      ? { background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: '22%', padding: 2, flex: 'none' }
      : { flex: 'none' },
    dangerouslySetInnerHTML: { __html: art },
  })
}
