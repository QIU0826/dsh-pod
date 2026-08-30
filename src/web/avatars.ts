/**
 * Agent 虚拟形象 —— 两套风格并存：
 * 1) 经典：毕加索（立体主义）风格动物头像，纯几何多边形拼接；
 * 2) Q 版娘化：每个 harness 一个拟人 mascot，按部位分层（head/hair/arm/body/tail），
 *    由 console-css.ts 中的 .dsh-av-chibi 关键帧驱动。
 * 动作随工作状态变化（呼吸/敲击/前倾/张望/抖动/打盹），保证每个状态首尾循环衔接。
 */
import { createElement, type ReactElement } from 'react'

/** 毕加索动物 SVG（viewBox 0 0 64 64）：多边形切面 + 不对称眼。 */
const CLASSIC_ART: Record<string, string> = {
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

/**
 * Q 版娘化 SVG。
 * 统一分层 class（供 console-css.ts 按部位驱动动画）：
 *   chi-tail      尾巴/装饰尾
 *   chi-leg-l/r   腿
 *   chi-body      躯干/裙子
 *   chi-head      头（脸）
 *   chi-hair      头发主体
 *   chi-hair-f    刘海/前发
 *   chi-face      五官
 *   chi-arm-l/r   手臂
 *   chi-prop      道具（键盘/书/鲸鱼喷水等）
 *   chi-star      漂浮装饰星
 * viewBox 0 0 64 64；所有角色坐标系一致，便于同一套 keyframes 通用。
 */
const CHIBI_ART: Record<string, string> = {
  dsh: `
    <path class="chi-tail" d="M16 48 Q8 54 10 60 Q18 56 22 48" fill="#1e5a82"/>
    <path class="chi-leg-l" d="M26 56 L26 62 L30 62 L30 56" fill="#f5c1b8"/>
    <path class="chi-leg-r" d="M34 56 L34 62 L38 62 L38 56" fill="#f5c1b8"/>
    <path class="chi-body" d="M24 40 Q32 38 40 40 L38 58 Q32 60 26 58 Z" fill="#22d3ee"/>
    <path class="chi-hair" d="M18 20 Q32 4 46 20 Q48 34 42 44 Q32 34 22 44 Q16 34 18 20" fill="#155e75"/>
    <circle class="chi-head" cx="32" cy="28" r="13" fill="#f5c1b8"/>
    <path class="chi-hair-f" d="M20 20 Q32 12 44 20 Q44 28 38 26 Q32 20 26 26 Q20 28 20 20" fill="#22d3ee"/>
    <g class="chi-face">
      <circle cx="26" cy="28" r="2.8" fill="#1a1a24"/><circle cx="27" cy="27" r="1" fill="#fff"/>
      <circle cx="38" cy="28" r="2.8" fill="#1a1a24"/><circle cx="39" cy="27" r="1" fill="#fff"/>
      <ellipse cx="23" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <ellipse cx="41" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <path d="M30 35 Q32 37 34 35" fill="none" stroke="#a36e64" stroke-width="1" stroke-linecap="round"/>
    </g>
    <path class="chi-arm-l" d="M24 42 Q18 48 22 52" fill="none" stroke="#f5c1b8" stroke-width="3.5" stroke-linecap="round"/>
    <path class="chi-arm-r" d="M40 42 Q46 48 42 52" fill="none" stroke="#f5c1b8" stroke-width="3.5" stroke-linecap="round"/>
    <path class="chi-prop" d="M34 8 Q36 4 32 2 Q28 4 30 8" fill="#67e8f9"/>
    <circle class="chi-star" cx="50" cy="16" r="1.8" fill="#f59e0b"/>
    <circle class="chi-star" cx="12" cy="18" r="1.3" fill="#67e8f9"/>`,
  claude: `
    <path class="chi-leg-l" d="M25 56 L25 62 L29 62 L29 56" fill="#f5c1b8"/>
    <path class="chi-leg-r" d="M35 56 L35 62 L39 62 L39 56" fill="#f5c1b8"/>
    <path class="chi-body" d="M23 40 Q32 38 41 40 L39 58 Q32 60 25 58 Z" fill="#5b21b6"/>
    <path class="chi-hair" d="M18 18 Q32 2 46 18 Q50 32 44 42 Q32 32 20 42 Q14 32 18 18" fill="#4c1d95"/>
    <circle class="chi-head" cx="32" cy="28" r="13" fill="#f5c1b8"/>
    <path class="chi-hair-f" d="M19 18 Q32 10 45 18 Q46 26 38 24 Q32 18 26 24 Q18 26 19 18" fill="#7c3aed"/>
    <g class="chi-face">
      <circle cx="26" cy="28" r="2.8" fill="#1a1a24"/><circle cx="27" cy="27" r="1" fill="#fff"/>
      <circle cx="38" cy="28" r="2.8" fill="#1a1a24"/><circle cx="39" cy="27" r="1" fill="#fff"/>
      <ellipse cx="23" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <ellipse cx="41" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <path d="M30 35 Q32 37 34 35" fill="none" stroke="#a36e64" stroke-width="1" stroke-linecap="round"/>
    </g>
    <path class="chi-arm-l" d="M23 42 Q17 48 21 52" fill="none" stroke="#f5c1b8" stroke-width="3.5" stroke-linecap="round"/>
    <path class="chi-arm-r" d="M41 42 Q47 48 43 52" fill="none" stroke="#f5c1b8" stroke-width="3.5" stroke-linecap="round"/>
    <rect class="chi-prop" x="20" y="8" width="10" height="8" rx="1" fill="#f59e0b"/>
    <path class="chi-prop" d="M22 10 L28 10 M22 12 L28 12" stroke="#5b21b6" stroke-width="1"/>
    <circle class="chi-star" cx="50" cy="16" r="1.8" fill="#fbbf24"/>
    <circle class="chi-star" cx="12" cy="20" r="1.3" fill="#a78bfa"/>`,
  gpt: `
    <path class="chi-tail" d="M48 34 L56 30 L54 38 L60 36" fill="#22c55e"/>
    <path class="chi-leg-l" d="M25 56 L25 62 L29 62 L29 56" fill="#f5c1b8"/>
    <path class="chi-leg-r" d="M35 56 L35 62 L39 62 L39 56" fill="#f5c1b8"/>
    <path class="chi-body" d="M23 40 Q32 38 41 40 L39 58 Q32 60 25 58 Z" fill="#15803d"/>
    <path class="chi-hair" d="M18 18 Q32 2 46 18 Q50 32 44 42 Q32 32 20 42 Q14 32 18 18" fill="#22c55e"/>
    <circle class="chi-head" cx="32" cy="28" r="13" fill="#f5c1b8"/>
    <path class="chi-hair-f" d="M19 18 Q32 10 45 18 Q46 26 38 24 Q32 18 26 24 Q18 26 19 18" fill="#4ade80"/>
    <g class="chi-face">
      <circle cx="26" cy="28" r="2.8" fill="#1a1a24"/><circle cx="27" cy="27" r="1" fill="#fff"/>
      <circle cx="38" cy="28" r="2.8" fill="#1a1a24"/><circle cx="39" cy="27" r="1" fill="#fff"/>
      <ellipse cx="23" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <ellipse cx="41" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <path d="M30 35 Q32 37 34 35" fill="none" stroke="#a36e64" stroke-width="1" stroke-linecap="round"/>
    </g>
    <path class="chi-arm-l" d="M23 42 Q17 48 21 52" fill="none" stroke="#f5c1b8" stroke-width="3.5" stroke-linecap="round"/>
    <path class="chi-arm-r" d="M41 42 Q47 48 43 52" fill="none" stroke="#f5c1b8" stroke-width="3.5" stroke-linecap="round"/>
    <circle class="chi-prop" cx="38" cy="10" r="4" fill="#86efac" opacity="0.8"/>
    <path class="chi-prop" d="M35 10 L41 10 M38 7 L38 13" stroke="#14532d" stroke-width="1.5"/>
    <circle class="chi-star" cx="50" cy="18" r="1.8" fill="#86efac"/>
    <circle class="chi-star" cx="12" cy="18" r="1.3" fill="#4ade80"/>`,
  codex: `
    <path class="chi-leg-l" d="M25 56 L25 62 L29 62 L29 56" fill="#f5c1b8"/>
    <path class="chi-leg-r" d="M35 56 L35 62 L39 62 L39 56" fill="#f5c1b8"/>
    <path class="chi-body" d="M23 40 Q32 38 41 40 L39 58 Q32 60 25 58 Z" fill="#1f2937"/>
    <path class="chi-hair" d="M18 18 Q32 2 46 18 Q50 32 44 42 Q32 32 20 42 Q14 32 18 18" fill="#22c55e"/>
    <circle class="chi-head" cx="32" cy="28" r="13" fill="#f5c1b8"/>
    <path class="chi-hair-f" d="M19 18 Q32 10 45 18 Q46 26 38 24 Q32 18 26 24 Q18 26 19 18" fill="#4ade80"/>
    <g class="chi-face">
      <circle cx="26" cy="28" r="2.8" fill="#1a1a24"/><circle cx="27" cy="27" r="1" fill="#fff"/>
      <circle cx="38" cy="28" r="2.8" fill="#1a1a24"/><circle cx="39" cy="27" r="1" fill="#fff"/>
      <ellipse cx="23" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <ellipse cx="41" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <path d="M30 35 Q32 37 34 35" fill="none" stroke="#a36e64" stroke-width="1" stroke-linecap="round"/>
      <rect x="24" y="24" width="16" height="4" rx="1" fill="#111827" opacity="0.2"/>
    </g>
    <path class="chi-arm-l" d="M23 42 Q17 48 21 52" fill="none" stroke="#f5c1b8" stroke-width="3.5" stroke-linecap="round"/>
    <path class="chi-arm-r" d="M41 42 Q47 48 43 52" fill="none" stroke="#f5c1b8" stroke-width="3.5" stroke-linecap="round"/>
    <rect class="chi-prop" x="16" y="48" width="14" height="8" rx="1" fill="#374151"/>
    <path class="chi-prop" d="M18 50 L28 50 M18 52 L26 52 M18 54 L24 54" stroke="#22c55e" stroke-width="1"/>
    <circle class="chi-star" cx="50" cy="16" r="1.8" fill="#22c55e"/>
    <circle class="chi-star" cx="12" cy="18" r="1.3" fill="#4ade80"/>`,
  opencode: `
    <path class="chi-tail" d="M14 38 Q6 42 8 50 Q14 46 16 40" fill="#2563eb"/>
    <path class="chi-leg-l" d="M25 56 L25 62 L29 62 L29 56" fill="#f5c1b8"/>
    <path class="chi-leg-r" d="M35 56 L35 62 L39 62 L39 56" fill="#f5c1b8"/>
    <path class="chi-body" d="M23 40 Q32 38 41 40 L39 58 Q32 60 25 58 Z" fill="#2563eb"/>
    <path class="chi-hair" d="M18 18 Q32 2 46 18 Q50 32 44 42 Q32 32 20 42 Q14 32 18 18" fill="#1d4ed8"/>
    <circle class="chi-head" cx="32" cy="28" r="13" fill="#f5c1b8"/>
    <path class="chi-hair-f" d="M19 18 Q32 10 45 18 Q46 26 38 24 Q32 18 26 24 Q18 26 19 18" fill="#60a5fa"/>
    <g class="chi-face">
      <circle cx="26" cy="28" r="2.8" fill="#1a1a24"/><circle cx="27" cy="27" r="1" fill="#fff"/>
      <circle cx="38" cy="28" r="2.8" fill="#1a1a24"/><circle cx="39" cy="27" r="1" fill="#fff"/>
      <ellipse cx="23" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <ellipse cx="41" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <path d="M30 35 Q32 37 34 35" fill="none" stroke="#a36e64" stroke-width="1" stroke-linecap="round"/>
    </g>
    <path class="chi-arm-l" d="M23 42 Q17 48 21 52" fill="none" stroke="#f5c1b8" stroke-width="3.5" stroke-linecap="round"/>
    <path class="chi-arm-r" d="M41 42 Q47 48 43 52" fill="none" stroke="#f5c1b8" stroke-width="3.5" stroke-linecap="round"/>
    <path class="chi-prop" d="M36 6 L40 14 L44 6 Z" fill="#f97316"/>
    <circle class="chi-prop" cx="40" cy="12" r="2" fill="#fdba74"/>
    <circle class="chi-star" cx="50" cy="18" r="1.8" fill="#60a5fa"/>
    <circle class="chi-star" cx="12" cy="16" r="1.3" fill="#93c5fd"/>`,
  ark: `
    <path class="chi-tail" d="M18 40 L12 34 L16 44 L8 42" fill="#ef4444"/>
    <path class="chi-leg-l" d="M25 56 L25 62 L29 62 L29 56" fill="#f5c1b8"/>
    <path class="chi-leg-r" d="M35 56 L35 62 L39 62 L39 56" fill="#f5c1b8"/>
    <path class="chi-body" d="M23 40 Q32 38 41 40 L39 58 Q32 60 25 58 Z" fill="#dc2626"/>
    <path class="chi-hair" d="M18 18 Q32 2 46 18 Q50 32 44 42 Q32 32 20 42 Q14 32 18 18" fill="#991b1b"/>
    <circle class="chi-head" cx="32" cy="28" r="13" fill="#f5c1b8"/>
    <path class="chi-hair-f" d="M19 18 Q32 10 45 18 Q46 26 38 24 Q32 18 26 24 Q18 26 19 18" fill="#f87171"/>
    <g class="chi-face">
      <circle cx="26" cy="28" r="2.8" fill="#1a1a24"/><circle cx="27" cy="27" r="1" fill="#fff"/>
      <circle cx="38" cy="28" r="2.8" fill="#1a1a24"/><circle cx="39" cy="27" r="1" fill="#fff"/>
      <ellipse cx="23" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <ellipse cx="41" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <path d="M30 35 Q32 37 34 35" fill="none" stroke="#a36e64" stroke-width="1" stroke-linecap="round"/>
    </g>
    <path class="chi-arm-l" d="M23 42 Q17 48 21 52" fill="none" stroke="#f5c1b8" stroke-width="3.5" stroke-linecap="round"/>
    <path class="chi-arm-r" d="M41 42 Q47 48 43 52" fill="none" stroke="#f5c1b8" stroke-width="3.5" stroke-linecap="round"/>
    <path class="chi-prop" d="M36 6 L40 14 L44 6 L42 4 L38 4 Z" fill="#fbbf24"/>
    <circle class="chi-star" cx="50" cy="18" r="1.8" fill="#fbbf24"/>
    <circle class="chi-star" cx="12" cy="18" r="1.3" fill="#fca5a5"/>`,
}

const ART: Record<string, string> = { ...CLASSIC_ART, ...CHIBI_ART }

/** 是否是 Q 版娘化形象（决定动画走内部分层关键帧，而非整体 transform）。 */
export function isChibi(id: string | undefined | null): boolean {
  if (!id) return false
  return id in CHIBI_ART
}

/** 可选形象（点选词表）。 */
export const AVATAR_OPTIONS: Array<{ id: string; label: string }> = [
  // 经典动物
  { id: 'cat', label: '猫' },
  { id: 'fox', label: '狐' },
  { id: 'owl', label: '鸮' },
  { id: 'bear', label: '熊' },
  { id: 'rabbit', label: '兔' },
  { id: 'wolf', label: '狼' },
  { id: 'frog', label: '蛙' },
  { id: 'deer', label: '鹿' },
  // Q 版娘化
  { id: 'claude', label: 'Claude 娘' },
  { id: 'gpt', label: 'GPT 娘' },
  { id: 'codex', label: 'Codex 娘' },
  { id: 'opencode', label: 'OpenCode 娘' },
  { id: 'ark', label: 'ARK 娘' },
  { id: 'dsh', label: 'DSH 娘' },
]

export function avatarLabel(id: string | undefined | null): string {
  if (id === undefined || id === null || id.length === 0) return '未设置'
  return AVATAR_OPTIONS.find((a) => a.id === id)?.label ?? id
}

/** 工作状态 → 动作（CSS 动画类）。 */
export function avatarMotion(status: string | undefined): string {
  if (status === 'working' || status === 'running') return 'work'
  if (status === 'dispatched') return 'lean'
  // 协商中 = 左右张望（在跟别的槽位谈），已接受 = 前倾待命
  if (status === 'negotiating') return 'look'
  if (status === 'accepted') return 'lean'
  if (status === 'waiting_approval') return 'look'
  if (status === 'error' || status === 'rejected') return 'shake'
  if (status === 'paused' || status === 'rate_limited') return 'sleep'
  return 'idle'
}

/**
 * 状态色：动作只能表达"在动"，颜色才能表达"是什么状态"。
 * 多 agent 并行时，一眼扫过去先靠颜色分辨谁需要关注——这是纯动画给不了的。
 */
export function avatarAccent(status: string | undefined): string {
  if (status === 'error' || status === 'rejected') return 'var(--error)'
  if (status === 'waiting_approval') return 'var(--warning)'
  if (status === 'done') return 'var(--success)'
  if (status === 'paused' || status === 'rate_limited') return 'var(--ink-3)'
  if (status === 'negotiating' || status === 'dispatched') return 'var(--info)'
  if (status === 'working' || status === 'running' || status === 'accepted') return 'var(--primary)'
  return 'var(--line)'
}

/** Agent 虚拟形象（随 slot 状态做动作 + 状态色）。 */
export function Avatar(animal: string | undefined | null, status: string | undefined, size = 28, frame = true): ReactElement {
  const art = ART[animal ?? ''] ?? ART.cat
  const accent = avatarAccent(status)
  const active = status !== 'idle' && status !== undefined && status !== null && status !== 'done'
  const chibi = isChibi(animal)
  const classes = ['dsh-av']
  if (chibi) classes.push('dsh-av-chibi')
  classes.push(avatarMotion(status))
  return createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 64 64',
    className: classes.join(' '),
    role: 'img',
    'aria-label': `形象 ${avatarLabel(animal)}`,
    style: frame
      ? {
          background: 'var(--surface-2)',
          border: `1px solid ${accent}`,
          // 活跃状态加一圈同色光晕：静止的边框容易被忽略，光晕才会在余光里被注意到
          boxShadow: active ? `0 0 0 2px ${accent}22` : 'none',
          borderRadius: '22%',
          padding: 2,
          flex: 'none',
          transition: 'border-color .2s ease, box-shadow .2s ease',
        }
      : { flex: 'none' },
    dangerouslySetInnerHTML: { __html: art },
  })
}
