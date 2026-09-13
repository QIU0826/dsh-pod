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
    <path class="chi-tail" d="M20 50 Q13 55 15 61 Q22 58 26 52 Z" fill="#F0784D"/>
    <path class="chi-tail" d="M44 50 Q51 55 49 61 Q42 58 38 52 Z" fill="#E86A3C"/>
    <path class="chi-tail" d="M27 52 Q32 57 37 52 Q37 58 32 60 Q27 58 27 52 Z" fill="#FF9E7D"/>
    <path class="chi-leg-l" d="M26 56 L25 62 L30 62 L30 56" fill="#f5c1b8"/>
    <path class="chi-leg-r" d="M34 56 L34 62 L39 62 L38 56" fill="#f5c1b8"/>
    <path class="chi-body" d="M23 40 Q32 37.5 41 40 L39 58 Q32 60.5 25 58 Z" fill="#6B4226"/>
    <path class="chi-hair" d="M17 19 Q32 2 47 19 Q51 34 44 45 Q32 33 20 45 Q13 34 17 19" fill="#F0784D"/>
    <path class="chi-hair" d="M16 21 Q9 17 9 10 Q15 13 19 19 Z" fill="#8D5A3B"/>
    <path class="chi-hair" d="M48 21 Q55 17 55 10 Q49 13 45 19 Z" fill="#8D5A3B"/>
    <path class="chi-hair" d="M28 9 Q25 2 29 0 Q31 5 32 9 Z" fill="#F0784D"/>
    <path class="chi-hair" d="M36 9 Q39 2 35 0 Q33 5 32 9 Z" fill="#FFB199"/>
    <circle class="chi-head" cx="32" cy="28" r="13" fill="#f5c1b8"/>
    <path class="chi-hair-f" d="M19 19 Q32 10 45 19 Q45 27 38 25 Q32 19 26 25 Q19 27 19 19" fill="#FF9E7D"/>
    <g class="chi-face">
      <ellipse cx="26" cy="29" rx="2.5" ry="2.3" fill="#E8912D"/>
      <ellipse cx="38" cy="29" rx="2.5" ry="2.3" fill="#E8912D"/>
      <path d="M23.2 27.2 Q26 25.8 28.8 27.2" stroke="#3A2A1C" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <path d="M35.2 27.2 Q38 25.8 40.8 27.2" stroke="#3A2A1C" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <circle cx="26.8" cy="28.4" r="0.9" fill="#fff"/><circle cx="38.8" cy="28.4" r="0.9" fill="#fff"/>
      <ellipse cx="23" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <ellipse cx="41" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <path d="M30 34.6 Q32 36.2 34 34.6" fill="none" stroke="#a36e64" stroke-width="1" stroke-linecap="round"/>
    </g>
    <path class="chi-arm-l" d="M23 42 Q18 47 22 51" fill="none" stroke="#f5c1b8" stroke-width="3.5" stroke-linecap="round"/>
    <path class="chi-arm-r" d="M41 42 Q46 47 42 51" fill="none" stroke="#f5c1b8" stroke-width="3.5" stroke-linecap="round"/>
    <path class="chi-prop" d="M18 50 L46 50 L44 59 L20 59 Z" fill="#F7EEDD"/>
    <path class="chi-prop" d="M18 50 L46 50 L45.2 53.4 L18.8 53.4 Z" fill="#8D5A3B"/>
    <path class="chi-prop" d="M39 45 L49 39 L50 41 L41 47 Z" fill="#F0784D"/>
    <circle class="chi-star" cx="51" cy="15" r="1.8" fill="#FFD23F"/>
    <circle class="chi-star" cx="11" cy="23" r="1.4" fill="#FF8A5C"/>`,
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
    <path class="chi-tail" d="M45 47 Q56 46 56 36 Q55 29 50 27 Q53 34 49 39 Q46 43 43 44 Z" fill="#1FC16B"/>
    <circle class="chi-tail" cx="50" cy="27.5" r="2.6" fill="#FFFFFF"/>
    <path class="chi-leg-l" d="M26 56 L25 62 L30 62 L30 56" fill="#374151"/>
    <path class="chi-leg-r" d="M34 56 L34 62 L39 62 L38 56" fill="#374151"/>
    <path class="chi-body" d="M22 40 Q32 37 42 40 L40 58 Q32 60.5 24 58 Z" fill="#374151"/>
    <path class="chi-hair" d="M18 20 Q32 3 46 20 Q49 33 43 42 Q32 32 21 42 Q15 33 18 20" fill="#1FC16B"/>
    <path class="chi-hair" d="M19 18 L15 5 L27 13 Z" fill="#FFFFFF"/>
    <path class="chi-hair" d="M45 18 L49 5 L37 13 Z" fill="#FFFFFF"/>
    <path class="chi-hair" d="M19 18 L16.8 9.5 L24 13.6 Z" fill="#1FC16B"/>
    <path class="chi-hair" d="M45 18 L47.2 9.5 L40 13.6 Z" fill="#1FC16B"/>
    <path class="chi-hair" d="M32 6 Q33 0.5 37 1.5 Q34.5 4 33.5 8.5 Z" fill="#1FC16B"/>
    <circle class="chi-head" cx="32" cy="28" r="13" fill="#f5c1b8"/>
    <path class="chi-hair-f" d="M19 19 Q32 11 45 19 Q45 26 39 24 Q34 20 32 24 Q30 20 25 24 Q19 26 19 19" fill="#7BE8B0"/>
    <g class="chi-face">
      <ellipse cx="26" cy="29" rx="2.4" ry="2.7" fill="#10B981"/>
      <ellipse cx="38" cy="29" rx="2.4" ry="2.7" fill="#10B981"/>
      <path d="M23.2 27 Q26 25.5 28.8 27" stroke="#0E3B2E" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <path d="M35.2 27 Q38 25.5 40.8 27" stroke="#0E3B2E" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <circle cx="26.8" cy="28.2" r="0.9" fill="#fff"/><circle cx="38.8" cy="28.2" r="0.9" fill="#fff"/>
      <ellipse cx="23" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <ellipse cx="41" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <path d="M30 34.6 Q32 36 34 34.6" fill="none" stroke="#a36e64" stroke-width="1" stroke-linecap="round"/>
    </g>
    <path class="chi-arm-l" d="M23 42 Q19 47 23 51" fill="none" stroke="#374151" stroke-width="3.5" stroke-linecap="round"/>
    <path class="chi-arm-r" d="M41 42 Q45 47 41 51" fill="none" stroke="#374151" stroke-width="3.5" stroke-linecap="round"/>
    <path class="chi-prop" d="M16 50 L48 50 L51 56 L13 56 Z" fill="#C7CDD6"/>
    <rect class="chi-prop" x="21" y="42" width="22" height="9" rx="1.2" fill="#23262F"/>
    <path class="chi-prop" d="M23.5 45.5 L32 45.5 M23.5 48 L29 48" stroke="#34E08B" stroke-width="1.1" stroke-linecap="round"/>
    <circle class="chi-prop" cx="40" cy="53" r="1.1" fill="#8A91A0"/>
    <circle class="chi-prop" cx="43.5" cy="53.6" r="0.8" fill="#8A91A0"/>
    <circle class="chi-star" cx="52" cy="14" r="1.8" fill="#34E08B"/>
    <circle class="chi-star" cx="10" cy="21" r="1.3" fill="#FFD23F"/>`,
  opencode: `
    <path class="chi-tail" d="M19 50 Q5 51 6 38 Q7 28 15 26 Q11 36 16 42 Q21 47 24 48 Z" fill="#7C5CFC"/>
    <path class="chi-tail" d="M15 26.5 Q9.5 25.5 8 30 Q12.5 32.5 17 29.5 Z" fill="#FFFFFF"/>
    <path class="chi-leg-l" d="M26 55 L25 61 L30 61 L30 55" fill="#23222E"/>
    <path class="chi-leg-r" d="M34 55 L34 61 L39 61 L38 55" fill="#23222E"/>
    <path class="chi-body" d="M23 40 Q32 37.5 41 40 L39 55 Q32 57 25 55 Z" fill="#23222E"/>
    <polygon class="chi-prop" points="32,44 35,45.7 35,49.3 32,51 29,49.3 29,45.7" fill="#7C5CFC" stroke="#B7A8FF" stroke-width="0.9" stroke-linejoin="round"/>
    <path class="chi-hair" d="M17 19 Q32 2 47 19 Q51 34 44 46 Q32 34 20 46 Q13 34 17 19" fill="#5B4BD6"/>
    <path class="chi-hair" d="M18 18 L12 4 L28 13 Z" fill="#7C5CFC"/>
    <path class="chi-hair" d="M46 18 L52 4 L36 13 Z" fill="#7C5CFC"/>
    <path class="chi-hair" d="M19 16 L15.5 8.5 L25 13.4 Z" fill="#D9D2FF"/>
    <path class="chi-hair" d="M45 16 L48.5 8.5 L39 13.4 Z" fill="#D9D2FF"/>
    <path class="chi-hair" d="M32 7 Q29 0.5 34 0 Q39 0 37.5 4.5 Q36.5 7.5 33 8.5 Q33 7.5 32 7 Z" fill="#8B7CF6"/>
    <circle class="chi-head" cx="32" cy="28" r="13" fill="#f5c1b8"/>
    <path class="chi-hair-f" d="M19 19 Q32 10 45 19 Q45 27 38 25 Q32 19 26 25 Q19 27 19 19" fill="#9B8CFF"/>
    <g class="chi-face">
      <ellipse cx="26" cy="29" rx="2.5" ry="2.5" fill="#7C5CFC"/>
      <ellipse cx="38" cy="29" rx="2.5" ry="2.5" fill="#7C5CFC"/>
      <path d="M23.2 27 Q26 25.6 28.8 27" stroke="#2E2660" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <path d="M35.2 27 Q38 25.6 40.8 27" stroke="#2E2660" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <circle cx="26.8" cy="28.3" r="0.9" fill="#fff"/><circle cx="38.8" cy="28.3" r="0.9" fill="#fff"/>
      <ellipse cx="23" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <ellipse cx="41" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <path d="M30 34.6 Q32 36.2 34 34.6" fill="none" stroke="#a36e64" stroke-width="1" stroke-linecap="round"/>
    </g>
    <path class="chi-arm-l" d="M23 42 Q18 47 22 51" fill="none" stroke="#23222E" stroke-width="3.5" stroke-linecap="round"/>
    <path class="chi-arm-r" d="M41 42 Q46 47 42 51" fill="none" stroke="#23222E" stroke-width="3.5" stroke-linecap="round"/>
    <rect class="chi-prop" x="17" y="50" width="30" height="11" rx="1.6" fill="#15131F"/>
    <rect class="chi-prop" x="17" y="50" width="30" height="3.4" rx="1.6" fill="#2C2A3D"/>
    <path class="chi-prop" d="M20 56.5 L26 56.5 M20 59 L24 59" stroke="#B7A8FF" stroke-width="1.1" stroke-linecap="round"/>
    <path class="chi-prop" d="M40 55.5 L43 57 L40 58.5" stroke="#B7A8FF" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <circle class="chi-star" cx="52" cy="15" r="1.8" fill="#9B8CFF"/>
    <circle class="chi-star" cx="10" cy="19" r="1.3" fill="#FFD23F"/>`,
  deepseek: `
    <path class="chi-tail" d="M25 49 Q18 56 21 63 Q29 60 32 53 Q35 60 43 63 Q46 56 39 49 Q32 46 25 49 Z" fill="#1E5AA8"/>
    <path class="chi-tail" d="M21 61 Q13 61 12 54 Q18 55 23 58 Z" fill="#7FC8F8"/>
    <path class="chi-tail" d="M43 61 Q51 61 52 54 Q46 55 41 58 Z" fill="#7FC8F8"/>
    <path class="chi-body" d="M23 40 Q32 37.5 41 40 L39 51 Q32 53 25 51 Z" fill="#1E4E8C"/>
    <path class="chi-body" d="M25 48 Q32 50.5 39 48" fill="none" stroke="#F5C542" stroke-width="1.6" stroke-linecap="round"/>
    <path class="chi-hair" d="M17 19 Q32 2 47 19 Q51 34 44 45 Q32 33 20 45 Q13 34 17 19" fill="#1E5AA8"/>
    <path class="chi-hair" d="M16 22 Q8 19 8 11 Q15 13 19 19 Z" fill="#2F7FD6"/>
    <path class="chi-hair" d="M48 22 Q56 19 56 11 Q49 13 45 19 Z" fill="#2F7FD6"/>
    <path class="chi-hair" d="M32 7 Q29 0.5 34 0 Q39 0 37.5 4.5 Q36.5 7.5 33 8.5 Q33 7.5 32 7 Z" fill="#7FC8F8"/>
    <circle class="chi-head" cx="32" cy="28" r="13" fill="#f5c1b8"/>
    <path class="chi-hair-f" d="M19 19 Q32 10 45 19 Q45 27 38 25 Q32 19 26 25 Q19 27 19 19" fill="#7FC8F8"/>
    <g class="chi-face">
      <ellipse cx="26" cy="29" rx="2.5" ry="2.4" fill="#3B82F6"/>
      <ellipse cx="38" cy="29" rx="2.5" ry="2.4" fill="#3B82F6"/>
      <path d="M23.2 27.2 Q26 25.8 28.8 27.2" stroke="#153A6B" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <path d="M35.2 27.2 Q38 25.8 40.8 27.2" stroke="#153A6B" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <circle cx="26.8" cy="28.4" r="0.9" fill="#fff"/><circle cx="38.8" cy="28.4" r="0.9" fill="#fff"/>
      <ellipse cx="23" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <ellipse cx="41" cy="33" rx="2.2" ry="1.3" fill="#ffb6c1" opacity="0.55"/>
      <path d="M30 34.6 Q32 36.2 34 34.6" fill="none" stroke="#a36e64" stroke-width="1" stroke-linecap="round"/>
    </g>
    <path class="chi-arm-l" d="M23 42 Q18 47 22 50.5" fill="none" stroke="#f5c1b8" stroke-width="3.5" stroke-linecap="round"/>
    <path class="chi-arm-r" d="M41 42 Q46 47 42 50.5" fill="none" stroke="#f5c1b8" stroke-width="3.5" stroke-linecap="round"/>
    <path class="chi-prop" d="M17 49 L47 49 L45 60 L19 60 Z" fill="#2F7FD6"/>
    <path class="chi-prop" d="M19 51.5 L45 51.5 L44 58 L20 58 Z" fill="#BFE3FF"/>
    <path class="chi-prop" d="M32 51.5 L32 58" stroke="#2F7FD6" stroke-width="0.9"/>
    <circle class="chi-star" cx="51" cy="14" r="1.8" fill="#FFD23F"/>
    <circle class="chi-star" cx="10" cy="24" r="1.3" fill="#7FC8F8"/>`,
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

/** Q 版娘化小尺寸降级阈值：<28px 时只渲染头部可读层，丢弃身体/四肢/道具/星。 */
export const CHIBI_HEAD_ONLY_THRESHOLD = 28

/**
 * 从 Q 版娘化 SVG 抽取「头部可读层」（chi-hair / chi-head / chi-hair-f / chi-face），
 * 按原始层序拼接。小尺寸下整身 14 层会堆成视觉噪音——尾巴/腿/身体/手臂/道具/星在
 * 18~26px 下只剩散点，反而淹没了「头发颜色 = 角色识别色」这个最可读的特征。
 *
 * 注意：`class="chi-hair"` 与 `class="chi-hair-f"` 是不同 class，regex 精确匹配引号
 * 边界，不会互相误命中；chi-face 是 `<g>` 容器（非自闭合），单独用跨行 regex 抽取。
 */
function chibiHeadArt(art: string): string {
  const pick = (cls: string): string =>
    art.match(new RegExp(`<[^>]+class="${cls}"[^>]*\\/?>`, 'g'))?.join('\n') ?? ''
  const face = art.match(/<g class="chi-face">[\s\S]*?<\/g>/)?.[0] ?? ''
  return [pick('chi-hair'), pick('chi-head'), pick('chi-hair-f'), face]
    .filter((s) => s.length > 0)
    .join('\n')
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
  { id: 'deepseek', label: 'DeepSeek 娘' },
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
  const chibi = isChibi(animal)
  const fullArt = ART[animal ?? ''] ?? ART.cat
  // 小尺寸降级：Q 版娘化只渲染头部可读层（审计 P2：18~26px 下整身 14 层是噪音）。
  // fullArt 在 chibi 分支必已定义（chibi id 全部落在 ART），守卫仅为类型收窄。
  const art = chibi && size < CHIBI_HEAD_ONLY_THRESHOLD && fullArt !== undefined ? chibiHeadArt(fullArt) : fullArt
  const accent = avatarAccent(status)
  const active = status !== 'idle' && status !== undefined && status !== null && status !== 'done'
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
