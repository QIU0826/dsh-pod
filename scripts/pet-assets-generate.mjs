/**
 * 桌宠角色素材生成器（scripts/pet-assets-generate.mjs）
 *
 * 按 docs/桌宠角色生产规格.md §5「三视图 → 动作帧」流程，为 dsh-pod 自产角色生成
 * frames2d 六轨帧素材：
 *   - 三视图定稿：正/侧/背全身立绘（Q 版 2.5 头身、192×208 画布、透明底、厂商品牌元素）
 *   - 动作帧派生：以正视图为基准逐帧改姿态（眨眼/干活/拖拽/庆祝/趴下/叉腰），
 *     同轨道头部大小与地平线恒定（同一模板参数化 → 帧间零跳动）
 *   - 导出：每帧独立 webp（192×208 透明底），命名 `<角色>-pet-<轨道><序号>.webp`
 *   - 注册：帧落位 `<out>/<id>/<track>/`，pet.json 由 scripts/pet-asset-slice.mjs 产出
 *
 * 渲染管线：SVG 模板 → Chrome 无头（CDP）→ canvas → image/webp。Chrome 是唯一外部依赖
 * （本机既有安装；可用 --chrome 指定路径）。产物直接可被 pet-frames2d 引擎加载。
 *
 * 用法：
 *   node scripts/pet-assets-generate.mjs                # 全部角色（SVG 平涂线）
 *   node scripts/pet-assets-generate.mjs zcode-girl     # 只生成指定角色
 *   POD_PET_ASSETS_OUT=<dir> node scripts/pet-assets-generate.mjs
 *
 * 角色清单（SVG 平涂线；2026-09-07 起 claude-girl / codex-girl / opencode-girl
 * 已迁移到贴纸线 scripts/pet-assets-sticker.mjs——AI 贴纸主视觉派生六轨连接帧，
 * 形象见 docs/桌宠角色生产规格.md 与用户角色提示词；deepseek-girl 仅贴纸线。
 * 本脚本只保留 SVG 线角色，勿把迁移角色加回，以免覆盖贴纸帧）：
 *   zcode-girl    智谱蓝 #2E6BE6 + 终端元素（Zcode 娘，规格 §4 模板角色）
 *   ark-girl      火山引擎品牌蓝 #1664FF + 火山元素（Ark 娘，harness=ark/火山方舟）
 *   dsh-girl      dsh-pod 主色青 #22D3EE + 六边形鲸群元素（DSH 娘，harness=dsh 原生）
 *   gemini-girl   Gemini 蓝紫 #7B6CF6 + 四色四芒星元素（Gemini 娘，开放厂商注册线/可换装）
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const OUT = process.env.POD_PET_ASSETS_OUT ?? 'demo-data/pet-assets'
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
]
function chromeBin() {
  const flag = process.argv.indexOf('--chrome')
  if (flag >= 0 && process.argv[flag + 1] !== undefined) return process.argv[flag + 1]
  for (const c of CHROME_CANDIDATES) if (c !== undefined && existsSync(c)) return c
  throw new Error('未找到 Chrome/Edge：用 --chrome <path> 指定')
}

// ─── 角色定义（规格 §5 品牌方向） ────────────────────────────────────────────

const SKIN = { base: '#FFE9D8', shade: '#F6D3B6', line: '#E8B48E' }

const CHARACTERS = {
  // claude-girl / codex-girl / opencode-girl 已迁移贴纸线（pet-assets-sticker.mjs），勿加回
  'zcode-girl': {
    displayName: 'Zcode 娘',
    description: 'zcode 专属小萝莉：智谱蓝 #2E6BE6 主色 + 终端元素发饰，冷静的代码接线员。',
    palette: { hair: '#2E6BE6', hairHi: '#5B8DEF', dress: '#EEF3FF', trim: '#2E6BE6', accent: '#1F4FC4', eye: '#22304A' },
    hairStyle: 'twintails',
    motif: 'terminal',
  },
  'ark-girl': {
    displayName: 'Ark 娘',
    description: '火山方舟（Volcengine Ark）专属小萝莉：品牌蓝 #1664FF 主色 + 火山元素，稳稳压住算力的方舟领航员。',
    palette: { hair: '#1664FF', hairHi: '#6BA0FF', dress: '#EAF1FF', trim: '#1664FF', accent: '#0E4FD6', eye: '#1F2D4D' },
    hairStyle: 'bun',
    motif: 'volcano',
  },
  'dsh-girl': {
    displayName: 'DSH 娘',
    description: 'dsh-pod 原生 harness 专属小萝莉：主色青 #22D3EE + 六边形鲸群元素，鲸群里的调度小队长。',
    palette: { hair: '#22D3EE', hairHi: '#86ECF5', dress: '#E7FBFD', trim: '#0E9BB0', accent: '#0E7490', eye: '#12343B' },
    hairStyle: 'braid',
    motif: 'hexagon',
  },
  'gemini-girl': {
    displayName: 'Gemini 娘',
    description: 'Gemini 专属小萝莉：蓝紫 #7B6CF6 波浪长发 + 四色四芒星发饰，灵感闪个不停的多模态少女。',
    palette: { hair: '#7B6CF6', hairHi: '#B7AEFF', dress: '#F5F3FF', trim: '#4285F4', accent: '#9334E6', eye: '#2E2A55' },
    hairStyle: 'wavy',
    motif: 'sparkle',
  },
}

/** Gemini 四色四芒星（上蓝/右紫/下粉/左琥珀，多模态意象）；s=整体缩放。 */
function sparkleSvg(cx, cy, s) {
  const p = (d, fill) => `<path d="${d}" fill="${fill}" stroke="#FFFFFFAA" stroke-width="${0.8 * s}" stroke-linejoin="round"/>`
  return `${p(`M ${cx} ${cy} Q ${cx + 3 * s} ${cy - 3 * s} ${cx} ${cy - 11 * s} Q ${cx - 3 * s} ${cy - 3 * s} ${cx} ${cy} Z`, '#4285F4')}
    ${p(`M ${cx} ${cy} Q ${cx + 3 * s} ${cy - 3 * s} ${cx + 11 * s} ${cy} Q ${cx + 3 * s} ${cy + 3 * s} ${cx} ${cy} Z`, '#9334E6')}
    ${p(`M ${cx} ${cy} Q ${cx + 3 * s} ${cy + 3 * s} ${cx} ${cy + 11 * s} Q ${cx - 3 * s} ${cy + 3 * s} ${cx} ${cy} Z`, '#EE4597')}
    ${p(`M ${cx} ${cy} Q ${cx - 3 * s} ${cy + 3 * s} ${cx - 11 * s} ${cy} Q ${cx - 3 * s} ${cy - 3 * s} ${cx} ${cy} Z`, '#F9AB00')}
    <circle cx="${cx}" cy="${cy}" r="${2.2 * s}" fill="#FFFFFF"/>`
}
const CHAR_IDS = Object.keys(CHARACTERS)

// ─── 动作帧轨道（规格 §3 MVP 六轨；pose 是模板参数） ───────────────────────

/**
 * pose 字段：
 *   bob   身体整体垂直偏移（px，正=下沉 负=上跳）
 *   tilt  头部旋转角（deg）
 *   headDy 头部垂直偏移
 *   armL/armR: down | up | typing | wave | cross | cheer | hold | fist
 *   legL/legR: stand | bent | tuck | stomp
 *   eye: open | blink | happy | sad | angry | wide | closed
 *   brow: normal | angry | sad | worried
 *   mouth: smile | open | o | frown | wavy | flat | shout
 *   blush: 是否脸红
 *   extras: 轨道附加元素开关（hud/panel glyph / stars / tear / sweat / anger / steam / motion）
 */
const TRACKS = {
  idle: {
    loop: true,
    frames: [
      { bob: 0, eye: 'open', mouth: 'smile', armL: 'down', armR: 'down' },
      { bob: 2, eye: 'blink', mouth: 'smile', armL: 'down', armR: 'down' },
      { bob: -1, eye: 'open', mouth: 'flat', armL: 'down', armR: 'down' },
      { bob: 0, eye: 'open', mouth: 'smile', armL: 'down', armR: 'wave', blush: true },
    ],
  },
  work: {
    loop: true,
    frames: [
      { bob: 0, headDy: 2, eye: 'open', mouth: 'flat', armL: 'typing', armR: 'typing', extras: { hud: 1 } },
      { bob: 1, headDy: 1, eye: 'open', mouth: 'flat', armL: 'typing', armR: 'typing', extras: { hud: 2 } },
      { bob: -1, headDy: 2, eye: 'blink', mouth: 'flat', armL: 'typing', armR: 'typing', extras: { hud: 3 } },
      { bob: 0, headDy: 1, eye: 'open', mouth: 'smile', armL: 'typing', armR: 'typing', extras: { hud: 4 } },
    ],
  },
  drag: {
    loop: true,
    frames: [
      { bob: 0, eye: 'wide', mouth: 'o', armL: 'up', armR: 'up', legL: 'tuck', legR: 'tuck', extras: { motion: 1 } },
      { bob: 3, tilt: 2, eye: 'wide', mouth: 'o', armL: 'up', armR: 'wave', legL: 'tuck', legR: 'tuck', extras: { motion: 1 } },
      { bob: -2, eye: 'wide', mouth: 'flat', armL: 'up', armR: 'up', legL: 'tuck', legR: 'tuck', extras: { motion: 1 } },
      { bob: 1, tilt: -2, eye: 'wide', mouth: 'o', armL: 'up', armR: 'up', legL: 'tuck', legR: 'tuck', extras: { motion: 2 } },
    ],
  },
  success: {
    loop: false,
    fallback: 'idle',
    frames: [
      { bob: 3, eye: 'happy', mouth: 'open', armL: 'down', armR: 'down', legL: 'bent', legR: 'bent' },
      { bob: -24, eye: 'happy', mouth: 'open', armL: 'cheer', armR: 'cheer', legL: 'tuck', legR: 'tuck', extras: { stars: 3 } },
      { bob: 0, eye: 'happy', mouth: 'smile', armL: 'cheer', armR: 'cheer', extras: { stars: 1 } },
    ],
  },
  fail: {
    loop: false,
    fallback: 'idle',
    frames: [
      { bob: 1, headDy: 4, eye: 'sad', brow: 'sad', mouth: 'frown', armL: 'down', armR: 'down', extras: { sweat: 1 } },
      { bob: 2, headDy: 7, eye: 'closed', brow: 'sad', mouth: 'wavy', armL: 'hold', armR: 'hold', extras: { tear: 1 } },
      { bob: 0, headDy: 5, eye: 'sad', brow: 'sad', mouth: 'frown', armL: 'down', armR: 'down', extras: { sweat: 1 } },
    ],
  },
  angry: {
    loop: false,
    fallback: 'idle',
    frames: [
      { eye: 'angry', brow: 'angry', mouth: 'wavy', armL: 'cross', armR: 'cross', blush: true, extras: { anger: 1 } },
      { tilt: -4, eye: 'angry', brow: 'angry', mouth: 'frown', armL: 'cross', armR: 'cross', extras: { anger: 1 } },
      { eye: 'angry', brow: 'angry', mouth: 'shout', armL: 'fist', armR: 'cross', legR: 'stomp', extras: { anger: 1, steam: 1 } },
    ],
  },
}

// ─── SVG 模板（192×208 透明底，Q 版 2.5 头身） ──────────────────────────────

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 手臂：肩 → 手的圆角曲线 + 手。sx/sy=肩，hx/hy=手，bend=控制点偏移方向 */
function arm(sx, sy, hx, hy, bend, color) {
  const mx = (sx + hx) / 2 + bend
  const my = (sy + hy) / 2 + 6
  return `<path d="M ${sx} ${sy} Q ${mx} ${my} ${hx} ${hy}" stroke="${color}" stroke-width="11" stroke-linecap="round" fill="none"/>
  <circle cx="${hx}" cy="${hy}" r="6.5" fill="${color}"/>`
}

/** 腿：髋 → 脚的圆角曲线 + 鞋 */
function leg(hx, hy, fx, fy, color, shoe) {
  const bend = fx > hx ? 3 : -3
  const mx = (hx + fx) / 2 + bend
  const my = (hy + fy) / 2
  return `<path d="M ${hx} ${hy} Q ${mx} ${my} ${fx} ${fy - 6}" stroke="${color}" stroke-width="12" stroke-linecap="round" fill="none"/>
  <rect x="${fx - 8}" y="${fy - 10}" width="17" height="10" rx="5" fill="${shoe}"/>`
}

const EYES = {
  open: (x, y, eyeC) =>
    `<ellipse cx="${x}" cy="${y}" rx="6.5" ry="8" fill="#fff"/>
     <circle cx="${x}" cy="${y + 1}" r="3.4" fill="${eyeC}"/>
     <circle cx="${x - 2}" cy="${y - 2.6}" r="1.3" fill="#fff"/>`,
  blink: (x, y) => `<path d="M ${x - 6} ${y} Q ${x} ${y + 4} ${x + 6} ${y}" stroke="#2A2118" stroke-width="2.6" stroke-linecap="round" fill="none"/>`,
  happy: (x, y) => `<path d="M ${x - 6} ${y + 2} Q ${x} ${y - 4} ${x + 6} ${y + 2}" stroke="#2A2118" stroke-width="2.6" stroke-linecap="round" fill="none"/>`,
  sad: (x, y) => `<path d="M ${x - 6} ${y - 1} Q ${x} ${y + 4} ${x + 6} ${y - 1}" stroke="#2A2118" stroke-width="2.4" stroke-linecap="round" fill="none"/>`,
  angry: (x, y, eyeC) =>
    `<path d="M ${x - 6.5} ${y + 1.5} L ${x + 6.5} ${y - 1.5}" stroke="#2A2118" stroke-width="3.2" stroke-linecap="round"/>
     <circle cx="${x}" cy="${y + 3}" r="2.6" fill="${eyeC}"/>`,
  wide: (x, y, eyeC) =>
    `<ellipse cx="${x}" cy="${y}" rx="7.5" ry="9.5" fill="#fff"/>
     <circle cx="${x}" cy="${y + 1}" r="4.4" fill="${eyeC}"/>
     <circle cx="${x - 2.6}" cy="${y - 3}" r="1.6" fill="#fff"/>`,
  closed: (x, y) => `<path d="M ${x - 6} ${y} Q ${x} ${y - 3} ${x + 6} ${y}" stroke="#2A2118" stroke-width="2.6" stroke-linecap="round" fill="none"/>`,
}

const BROWS = {
  normal: (x, y) => `<path d="M ${x - 5.5} ${y} Q ${x} ${y - 3.5} ${x + 5.5} ${y}" stroke="#2A2118" stroke-width="2.2" stroke-linecap="round" fill="none"/>`,
  angry: (x, y) => `<path d="M ${x - 6} ${y - 2} L ${x + 6} ${y + 1}" stroke="#2A2118" stroke-width="3" stroke-linecap="round"/>`,
  sad: (x, y) => `<path d="M ${x - 6} ${y - 1} Q ${x} ${y + 1} ${x + 6} ${y - 3}" stroke="#2A2118" stroke-width="2.4" stroke-linecap="round" fill="none"/>`,
  worried: (x, y) => `<path d="M ${x - 5.5} ${y} Q ${x} ${y - 1} ${x + 5.5} ${y + 2}" stroke="#2A2118" stroke-width="2.2" stroke-linecap="round" fill="none"/>`,
}

const MOUTHS = {
  smile: `<path d="M -5 0 Q 0 5 5 0" stroke="#B3574A" stroke-width="2.4" stroke-linecap="round" fill="none"/>`,
  open: `<ellipse cx="0" cy="1" rx="4.2" ry="5" fill="#8C3B33"/>`,
  o: `<circle cx="0" cy="1" r="3" fill="#8C3B33"/>`,
  frown: `<path d="M -5 4 Q 0 -1 5 4" stroke="#B3574A" stroke-width="2.4" stroke-linecap="round" fill="none"/>`,
  wavy: `<path d="M -5 1 Q -2.5 -1 0 1 Q 2.5 3 5 1" stroke="#B3574A" stroke-width="2.2" stroke-linecap="round" fill="none"/>`,
  flat: `<path d="M -4 1 L 4 1" stroke="#B3574A" stroke-width="2.4" stroke-linecap="round"/>`,
  shout: `<ellipse cx="0" cy="1" rx="5" ry="6.2" fill="#8C3B33"/>`,
}

/** 刘海（分缝样式按角色） */
function bangs(style, hair, hairHi) {
  const base = `<path d="M 60 52 Q 66 26 96 24 Q 126 26 132 52 Q 126 40 112 42 Q 102 34 96 40 Q 88 34 80 42 Q 66 40 60 52 Z" fill="${hair}"/>`
  if (style === 'twintails') {
    // 中分：两撇刘海 + 顶部小呆毛
    return `<path d="M 60 52 Q 66 28 88 26 L 96 40 L 104 26 Q 126 28 132 52 Q 118 40 108 44 L 96 46 L 84 44 Q 72 40 60 52 Z" fill="${hair}"/>
    <path d="M 96 22 Q 100 14 97 8 Q 101 15 103 21 Z" fill="${hairHi}"/>`
  }
  if (style === 'ponytail') {
    return `<path d="M 58 54 Q 64 24 96 23 Q 128 24 134 54 Q 122 42 108 46 L 96 48 L 84 46 Q 70 42 58 54 Z" fill="${hair}"/>
    <path d="M 70 32 Q 78 26 90 25 Q 82 33 74 38 Z" fill="${hairHi}"/>`
  }
  if (style === 'bob') {
    return `<path d="M 58 54 Q 64 22 96 21 Q 128 22 134 54 Q 128 40 116 38 L 96 34 L 76 38 Q 64 40 58 54 Z" fill="${hair}"/>`
  }
  if (style === 'bun') {
    // 丸子头：齐整眉上刘海（底边微锯齿）
    return `<path d="M 58 52 Q 62 26 96 24 Q 130 26 134 52 L 126 52 Q 124 43 114 45 L 96 41 L 78 45 Q 68 43 66 52 Z" fill="${hair}"/>`
  }
  if (style === 'braid') {
    // 麻花辫：中分碎刘海（两撇向中间收）
    return `<path d="M 58 54 Q 62 24 96 22 Q 130 24 134 54 Q 126 40 114 42 Q 104 48 96 44 Q 88 50 78 42 Q 68 40 58 54 Z" fill="${hair}"/>
    <path d="M 96 24 L 96 44" stroke="${hairHi}" stroke-width="2" stroke-linecap="round"/>`
  }
  if (style === 'wavy') {
    // 波浪长发：中分空气刘海，底边呈连续波浪
    return `<path d="M 58 54 Q 62 24 96 22 Q 130 24 134 54
      Q 128 45 122 53 Q 116 44 110 53 Q 104 44 96 49 Q 88 44 82 53 Q 76 44 70 53 Q 64 45 58 54 Z" fill="${hair}"/>
    <path d="M 70 30 Q 80 23 92 23 Q 82 31 74 39 Z" fill="${hairHi}"/>
    <path d="M 100 23 Q 112 23 122 30 Q 114 33 106 39 Z" fill="${hairHi}" opacity=".7"/>`
  }
  // long（claude）：侧分长刘海
  return `<path d="M 58 54 Q 62 24 96 22 Q 130 24 134 54 Q 122 40 112 42 L 96 36 L 84 44 Q 70 42 58 54 Z" fill="${hair}"/>
  <path d="M 66 30 Q 74 22 88 21 Q 80 30 72 38 Z" fill="${hairHi}"/>`
}

/** 角色专属发饰/眼镜（品牌元素，规格 §5） */
function hairAccessory(motif, palette) {
  if (motif === 'star') {
    // 星芒发饰：陶土橙八芒星
    return `<g transform="translate(116 36)">
      <path d="M 0 -10 L 2.6 -3.2 L 10 0 L 2.6 3.2 L 0 10 L -2.6 3.2 L -10 0 L -2.6 -3.2 Z" fill="#D97757" stroke="#F5C98A" stroke-width="1.4"/>
      <circle cx="0" cy="0" r="2.6" fill="#F5C98A"/>
    </g>`
  }
  if (motif === 'terminal') {
    // 终端 `>_` 发饰：智谱蓝小终端窗
    return `<g transform="translate(76 34)">
      <rect x="-14" y="-10" width="28" height="20" rx="5" fill="#1F4FC4" stroke="#5B8DEF" stroke-width="1.4"/>
      <path d="M -14 -10 Q -7 -16 0 -10" stroke="#5B8DEF" stroke-width="1.4" fill="#1F4FC4"/>
      <text x="0" y="5" text-anchor="middle" font-family="monospace" font-size="11" font-weight="700" fill="#BFE0FF">&gt;_</text>
    </g>`
  }
  if (motif === 'shell') {
    // 命令行窗口发饰：暖橙小窗口 + `$ _`
    return `<g transform="translate(118 38)">
      <rect x="-15" y="-11" width="30" height="22" rx="4.5" fill="#E16E20" stroke="#FFB27A" stroke-width="1.4"/>
      <circle cx="-9" cy="-5.5" r="2" fill="#FFD9B0"/>
      <circle cx="-3" cy="-5.5" r="2" fill="#FFD9B0"/>
      <circle cx="3" cy="-5.5" r="2" fill="#FFD9B0"/>
      <text x="0" y="7" text-anchor="middle" font-family="monospace" font-size="10.5" font-weight="700" fill="#FFF4E6">$_</text>
    </g>`
  }
  if (motif === 'volcano') {
    // 火山发饰：火山引擎品牌蓝小火山 + 橙红焰尖（方舟/火山意象）
    return `<g transform="translate(76 34)">
      <path d="M -13 9 L -5 -5 L -1 1 L 4 -8 L 13 9 Z" fill="#0E4FD6" stroke="#6BA0FF" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M 4 -8 Q 9 -15 3 -19 Q 8 -13 2 -7 Z" fill="#FF6A3D"/>
      <path d="M -2 2 L 1 6 L 5 2" stroke="#BFD4FF" stroke-width="1.4" fill="none" stroke-linecap="round"/>
    </g>`
  }
  if (motif === 'hexagon') {
    // 六边形鲸群发饰：dsh-pod 六边形 logo 形 + 小鲸尾
    return `<g transform="translate(116 36)">
      <polygon points="0,-10 8.7,-5 8.7,5 0,10 -8.7,5 -8.7,-5" fill="#0E7490" stroke="#86ECF5" stroke-width="1.4" stroke-linejoin="round"/>
      <path d="M -4.5 3 Q -1.5 -4 0 2.5 Q 1.5 -4 4.5 3" stroke="#E7FBFD" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      <path d="M 0 -1 L 0 4" stroke="#E7FBFD" stroke-width="1.6" stroke-linecap="round"/>
    </g>`
  }
  if (motif === 'sparkle') {
    // Gemini 四色四芒星发饰（斜斜别在右侧刘海）
    return `<g transform="translate(119 35) rotate(14)">${sparkleSvg(0, 0, 1)}</g>`
  }
  return '' // codex：圆框眼镜在面部绘制（见 face）
}

/** 面部（含 codex 眼镜） */
function face(pose, palette, style) {
  const eyeC = palette.eye
  const lx = 82.5
  const rx = 109.5
  const ey = 57
  const eyeL = EYES[pose.eye] ?? EYES.open
  const browL = BROWS[pose.brow ?? 'normal']
  const mouth = MOUTHS[pose.mouth] ?? MOUTHS.smile
  const blush = pose.blush === true
    ? `<ellipse cx="74" cy="68" rx="5" ry="3" fill="#FFB7A0" opacity=".65"/>
       <ellipse cx="118" cy="68" rx="5" ry="3" fill="#FFB7A0" opacity=".65"/>`
    : ''
  const glasses = style === 'bob'
    ? `<circle cx="${lx}" cy="${ey}" r="9.5" fill="rgba(255,255,255,.10)" stroke="#101217" stroke-width="2.6"/>
       <circle cx="${rx}" cy="${ey}" r="9.5" fill="rgba(255,255,255,.10)" stroke="#101217" stroke-width="2.6"/>
       <path d="M ${lx + 9} ${ey - 1} Q 96 ${ey - 6} ${rx - 9} ${ey - 1}" stroke="#101217" stroke-width="2.4" fill="none"/>
       <path d="M ${lx + 9.5} ${ey} L ${lx + 14} ${ey + 3}" stroke="#101217" stroke-width="2.4" stroke-linecap="round"/>`
    : ''
  return `<g>
    ${browL(lx, 45)}${browL(rx, 45)}
    ${eyeL(lx, ey, eyeC)}${eyeL(rx, ey, eyeC)}
    ${glasses}
    <g transform="translate(96 76)">${mouth}</g>
    ${blush}
  </g>`
}

/** 身体/裙子（按角色配色）+ 品牌纹样 */
function body(pose, palette, motif) {
  const { dress, trim, accent } = palette
  const collar = `<path d="M 86 100 L 96 112 L 106 100 Z" fill="#fff" opacity=".92"/>`
  const belt = `<path d="M 72 130 Q 96 136 120 130 L 120 136 Q 96 142 72 136 Z" fill="${accent}"/>`
  const motifSvg =
    motif === 'star'
      ? `<path d="M 96 148 L 97.8 152.2 L 102 154 L 97.8 155.8 L 96 160 L 94.2 155.8 L 90 154 L 94.2 152.2 Z" fill="${trim}"/>`
      : motif === 'terminal'
        ? `<text x="96" y="156" text-anchor="middle" font-family="monospace" font-size="9" font-weight="700" fill="${trim}">&gt;_</text>`
        : motif === 'shell'
          ? `<text x="96" y="156" text-anchor="middle" font-family="monospace" font-size="10" font-weight="700" fill="${trim}">$</text>`
          : motif === 'volcano'
            ? `<path d="M 90 157 L 93.5 149 L 96 153 L 98.5 147 L 102 157 Z" fill="${trim}"/>
               <path d="M 98.5 147 Q 101 143 98 141 Q 100.5 144 97.5 147 Z" fill="#FF6A3D"/>`
            : motif === 'hexagon'
              ? `<polygon points="96,146 102,149.5 102,155.5 96,159 90,155.5 90,149.5" fill="none" stroke="${trim}" stroke-width="1.8" stroke-linejoin="round"/>
                 <path d="M 93 154 Q 95 150 96 153.5 Q 97 150 99 154" stroke="${trim}" stroke-width="1.4" fill="none" stroke-linecap="round"/>`
              : motif === 'sparkle'
                ? sparkleSvg(96, 153, 0.55)
                : `<rect x="91" y="146" width="10" height="2.4" rx="1.2" fill="#00E676"/>
                 <rect x="93" y="150" width="6" height="2.4" rx="1.2" fill="#00E676" opacity=".7"/>`
  return `<g>
    <path d="M 76 102 Q 73 128 74 146 Q 96 152 118 146 Q 119 128 116 102 Z" fill="${dress}"/>
    <path d="M 74 146 Q 96 152 118 146 Q 118 158 96 160 Q 74 158 74 146 Z" fill="${dress}" stroke="${trim}" stroke-width="2" stroke-linejoin="round"/>
    ${collar}
    ${belt}
    ${motifSvg}
  </g>`
}

/** 后发（按发型的背面体积） */
function backHair(style, palette) {
  const hair = palette.hair
  if (style === 'long') {
    return `<path d="M 62 52 Q 54 96 60 150 Q 68 172 82 178 L 92 150 Q 88 120 96 96 Q 104 120 100 150 L 110 178 Q 124 172 132 150 Q 138 96 130 52 Z" fill="${hair}"/>
      <path d="M 96 96 Q 88 130 90 152 L 96 152 L 102 152 Q 104 130 96 96 Z" fill="#00000022"/>`
  }
  if (style === 'twintails') {
    return `<path d="M 56 54 Q 48 96 58 138 Q 70 166 92 172 L 94 148 Q 84 130 84 110 Q 88 92 96 88 Q 104 92 108 110 Q 108 130 98 148 L 100 172 Q 122 166 134 138 Q 144 96 136 54 Z" fill="${hair}"/>`
  }
  if (style === 'ponytail') {
    return `<path d="M 62 54 Q 56 92 62 130 Q 78 162 104 168 L 104 146 Q 92 134 88 116 Q 88 96 96 90 Q 104 96 104 116 Q 100 134 88 146 L 88 166 Q 118 158 130 128 Q 138 92 130 54 Z" fill="${hair}"/>
      <circle cx="94" cy="36" r="5" fill="${'#E16E20'}"/>`
  }
  if (style === 'bun') {
    // 丸子头：头顶圆发髻 + 齐颌短发背
    return `<circle cx="96" cy="15" r="13.5" fill="${hair}"/>
      <circle cx="96" cy="15" r="7" fill="${palette.hairHi}" opacity=".45"/>
      <path d="M 60 54 Q 54 92 62 122 Q 70 138 96 140 Q 122 138 130 122 Q 138 92 132 54 Z" fill="${hair}"/>`
  }
  if (style === 'braid') {
    // 单侧麻花辫：中长背发 + 左肩前一串编发节 + 青色发绳
    return `<path d="M 62 52 Q 56 96 64 130 Q 72 148 96 150 Q 120 148 128 130 Q 136 96 130 52 Z" fill="${hair}"/>
      <ellipse cx="63" cy="118" rx="9" ry="8" fill="${hair}"/>
      <ellipse cx="61" cy="132" rx="8.5" ry="8" fill="${hair}"/>
      <ellipse cx="60" cy="145" rx="7.5" ry="7.5" fill="${hair}"/>
      <circle cx="59" cy="157" r="5" fill="${palette.trim}"/>`
  }
  if (style === 'wavy') {
    // 波浪长发：及肩披发，下摆连续波浪 + 两缕垂在脸侧的波浪发束
    return `<path d="M 60 54 Q 53 94 58 128 Q 60 137 66 132 Q 72 141 79 132 Q 85 143 96 138 Q 107 143 113 132 Q 120 141 126 132 Q 132 137 134 128 Q 139 94 132 54 Z" fill="${hair}"/>
      <path d="M 60 60 Q 55 92 60 124 Q 66 118 68 92 Q 68 72 66 58 Z" fill="${palette.hairHi}" opacity=".35"/>
      <path d="M 132 60 Q 137 92 132 124 Q 126 118 124 92 Q 124 72 126 58 Z" fill="${palette.hairHi}" opacity=".25"/>`
  }
  // bob
  return `<path d="M 60 54 Q 54 92 62 128 Q 70 146 96 150 Q 122 146 130 128 Q 138 92 132 54 Z" fill="${hair}"/>
    <path d="M 120 40 Q 130 62 128 92 L 134 84 Q 136 56 128 34 Z" fill="#00E676"/>`
}

/** 头部整体（后发 + 脸 + 刘海 + 发饰） */
function head(pose, c, style, motif) {
  const { hair, hairHi } = c.palette
  const dy = (pose.headDy ?? 0) + (pose.tilt !== undefined ? 0 : 0)
  return `<g transform="translate(0 ${dy}) rotate(${pose.tilt ?? 0} 96 52)">
    <ellipse cx="96" cy="54" rx="42" ry="46" fill="${hair}"/>
    ${backHair(style, c.palette)}
    <rect x="64" y="22" width="64" height="74" rx="27" fill="${SKIN.base}"/>
    ${face(pose, c.palette, style)}
    ${bangs(style, hair, hairHi)}
    ${hairAccessory(motif, c.palette)}
  </g>`
}

/** 轨道附加元素（HUD/粒子/泪滴/蒸汽/运动线） */
function extras(pose, c, track, idx) {
  const { palette } = c
  const parts = []
  const ex = pose.extras ?? {}
  if (track === 'work' && ex.hud !== undefined) {
    const glyphs = ['run', 'ok', 'fix', '✓✓']
    const glyph = glyphs[(ex.hud - 1) % glyphs.length]
    parts.push(`<g transform="translate(124 14)">
      <rect x="0" y="0" width="58" height="36" rx="6" fill="rgba(10,16,28,.92)" stroke="${palette.trim}" stroke-width="1.4"/>
      <circle cx="10" cy="8" r="2.2" fill="#EF4444"/><circle cx="18" cy="8" r="2.2" fill="#F59E0B"/><circle cx="26" cy="8" r="2.2" fill="#22C55E"/>
      <text x="8" y="26" font-family="monospace" font-size="10" fill="${palette.trim}">&gt; ${glyph}${ex.hud % 2 === 0 ? '▍' : ''}</text>
    </g>`)
  }
  if (track === 'drag' && ex.motion !== undefined) {
    const n = ex.motion === 1 ? 2 : 3
    for (let i = 0; i < n; i++) {
      const y = 70 + i * 34 + (idx % 2) * 8
      parts.push(`<path d="M 40 ${y} L 32 ${y - 10}" stroke="#7DD3FC" stroke-width="3" stroke-linecap="round" opacity=".7"/>
        <path d="M 152 ${y + 14} L 160 ${y + 4}" stroke="#7DD3FC" stroke-width="3" stroke-linecap="round" opacity=".7"/>`)
    }
  }
  if (track === 'success' && ex.stars !== undefined) {
    const sc = palette.trim
    for (let i = 0; i < ex.stars; i++) {
      const x = 52 + i * 44 + (idx % 2) * 10
      const y = 24 + (i % 2) * 30
      const r = 3 + (i % 2) * 1.5
      parts.push(`<path transform="translate(${x} ${y}) rotate(${i * 24})" d="M 0 ${-r} L ${r * 0.35} ${-r * 0.35} L ${r} 0 L ${r * 0.35} ${r * 0.35} L 0 ${r} L ${-r * 0.35} ${r * 0.35} L ${-r} 0 L ${-r * 0.35} ${-r * 0.35} Z" fill="${sc}"/>`)
    }
  }
  if (track === 'fail') {
    if (ex.tear !== undefined) {
      parts.push(`<path d="M 120 60 Q 127 66 121 74 Q 116 67 120 60 Z" fill="#7DD3FC"/>`)
    }
    if (ex.sweat !== undefined) {
      parts.push(`<path d="M 66 50 Q 61 54 65 59 Q 70 55 66 50 Z" fill="#A5D8FF"/>`)
    }
  }
  if (track === 'angry') {
    if (ex.anger !== undefined) {
      parts.push(`<g transform="translate(140 26)">
        <path d="M 0 -8 A 8 8 0 1 1 -0.01 -8" stroke="#EF4444" stroke-width="3" fill="none"/>
        <path d="M -8 0 L -11 0 M 8 0 L 11 0 M 0 -8 L 0 -11" stroke="#EF4444" stroke-width="2.6" stroke-linecap="round"/>
      </g>`)
    }
    if (ex.steam !== undefined) {
      parts.push(`<path d="M 150 78 Q 156 72 150 64 Q 144 58 150 50" stroke="#8B93A7" stroke-width="2.6" stroke-linecap="round" fill="none" opacity=".8"/>
        <path d="M 160 88 Q 166 82 160 74" stroke="#8B93A7" stroke-width="2.2" stroke-linecap="round" fill="none" opacity=".6"/>`)
    }
  }
  return parts.join('')
}

/** 组装单帧 SVG */
function frameSvg(c, track, idx) {
  const pose = TRACKS[track].frames[idx]
  const { palette } = c
  const arms = armSpec(pose, palette)
  const legs = legSpec(pose, palette)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="208" viewBox="0 0 192 208">
  <g transform="translate(0 ${pose.bob ?? 0})">
    ${legs}
    ${body(pose, palette, c.motif)}
    ${arms}
    ${head(pose, c, c.hairStyle, c.motif)}
    ${extras(pose, c, track, idx)}
  </g>
</svg>`
}

/** 手臂姿势 → SVG */
function armSpec(pose, palette) {
  const skin = SKIN.base
  const L = 74 // 左肩
  const R = 118 // 右肩
  const SY = 108
  const P = pose
  const targets = {
    down: [L, 158, R, 158],
    up: [L, 122, R, 122],
    typing: [L - 14, 128, R + 14, 128],
    wave: [R + 22, 104, R + 20, 92],
    cross: [R, 116, L, 116],
    cheer: [L - 18, 78, R + 18, 78],
    hold: [L - 6, 126, R + 6, 126],
    fist: [L - 16, 98, R, 118],
  }
  const lT = targets[P.armL] ?? targets.down
  const rT = targets[P.armR] ?? targets.down
  let out = ''
  if (P.armR === 'wave') {
    // 挥手：右手抬起摆动（帧 4 待机萌点）
    out += arm(L, SY, lT[0], lT[1], 4, skin)
    out += arm(R, SY, rT[2], rT[3], -8, skin)
  } else {
    out += arm(L, SY, lT[0], lT[1], 4, skin)
    out += arm(R, SY, rT[2], rT[3], 4, skin)
  }
  return out
}

/** 腿姿势 → SVG */
function legSpec(pose, palette) {
  const skin = SKIN.base
  const shoe = palette.trim
  const P = pose
  const hipL = 84
  const hipR = 108
  const HIPY = 150
  if (P.legL === 'tuck' && P.legR === 'tuck') {
    // 被拎起/跳跃：双腿蜷起
    return leg(hipL, HIPY, 76, 172, skin, shoe) + leg(hipR, HIPY, 116, 172, skin, shoe)
  }
  if (P.legL === 'bent' && P.legR === 'bent') {
    // 蹲下蓄力
    return leg(hipL, HIPY, 74, 192, skin, shoe) + leg(hipR, HIPY, 118, 192, skin, shoe)
  }
  if (P.legR === 'stomp') {
    return leg(hipL, HIPY, 80, 194, skin, shoe) + leg(hipR, HIPY, 126, 186, skin, shoe)
  }
  return leg(hipL, HIPY, 80, 194, skin, shoe) + leg(hipR, HIPY, 112, 194, skin, shoe)
}

/** 三视图（规格 §5 步骤 1：正/侧/背全身立绘，横向三联画布） */
function threeViewSvg(c) {
  const { palette } = c
  const front = frameSvg(c, 'idle', 0)
  // 侧面：头部侧轮廓 + 身体侧影
  const side = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="208" viewBox="0 0 192 208">
    <g transform="translate(0 0)">
      <path d="M 108 52 Q 96 30 84 54 Q 76 96 80 150 Q 86 172 100 178 L 106 150 Q 100 120 100 96 Q 100 120 94 150 L 88 176 Q 112 170 120 148 Q 128 96 124 54 Q 122 44 108 52 Z" fill="${palette.hair}"/>
      <ellipse cx="104" cy="54" rx="30" ry="42" fill="${palette.hair}"/>
      <rect x="92" y="26" width="28" height="70" rx="13" fill="${SKIN.base}"/>
      <path d="M 92 44 Q 92 26 104 26 Q 116 26 120 44 L 112 36 L 96 40 Z" fill="${palette.hair}"/>
      <path d="M 104 56 Q 106 62 104 68" stroke="#2A2118" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M 92 74 L 100 96 L 108 96 L 116 74" fill="none"/>
      <path d="M 76 102 Q 72 128 76 146 Q 100 152 122 146 Q 124 128 120 102 Z" fill="${palette.dress}"/>
      <path d="M 76 146 Q 100 152 122 146 Q 124 158 100 160 Q 76 158 76 146 Z" fill="${palette.dress}" stroke="${palette.trim}" stroke-width="2"/>
      <path d="M 84 150 Q 88 172 92 194 L 102 194 Q 106 172 104 150" stroke="${SKIN.base}" stroke-width="12" stroke-linecap="round" fill="none"/>
      <path d="M 96 150 Q 100 174 98 194" stroke="${SKIN.base}" stroke-width="12" stroke-linecap="round" fill="none"/>
      <rect x="86" y="184" width="20" height="10" rx="5" fill="${palette.trim}"/>
    </g>
  </svg>`
  // 背面：只有后发与裙背
  const back = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="208" viewBox="0 0 192 208">
    <g>
      <path d="M 62 52 Q 54 96 60 150 Q 68 172 82 178 L 92 150 Q 88 120 96 96 Q 104 120 100 150 L 110 178 Q 124 172 132 150 Q 138 96 130 52 Z" fill="${palette.hair}"/>
      <ellipse cx="96" cy="54" rx="42" ry="46" fill="${palette.hair}"/>
      <path d="M 76 102 Q 73 128 74 146 Q 96 152 118 146 Q 119 128 116 102 Z" fill="${palette.dress}"/>
      <path d="M 74 146 Q 96 152 118 146 Q 118 158 96 160 Q 74 158 74 146 Z" fill="${palette.dress}" stroke="${palette.trim}" stroke-width="2" stroke-linejoin="round"/>
      <rect x="70" y="122" width="52" height="4" rx="2" fill="${palette.accent}"/>
      <path d="M 84 150 Q 88 172 92 194 L 102 194 Q 106 172 104 150" stroke="${SKIN.base}" stroke-width="12" stroke-linecap="round" fill="none"/>
      <rect x="84" y="184" width="24" height="10" rx="5" fill="${palette.trim}"/>
    </g>
  </svg>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="576" height="208" viewBox="0 0 576 208">
    <g transform="translate(0 0)">${inline(front)}</g>
    <g transform="translate(192 0)">${inline(side)}</g>
    <g transform="translate(384 0)">${inline(back)}</g>
  </svg>`
  function inline(s) {
    return s.replace(/^<\?xml[^>]*\?>/, '').replace(/<svg[^>]*>/, '').replace(/<\/svg>$/, '')
  }
}

// ─── Chrome CDP 渲染（SVG → webp / png） ────────────────────────────────────

let cdpClient = null
async function getCdp() {
  if (cdpClient !== null) return cdpClient
  const port = 9337
  const profile = join(process.env.TEMP ?? '.', 'dsh-pod-assets-profile')
  const proc = spawn(chromeBin(), [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' })
  let wsUrl
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (r.ok) {
        const list = await r.json()
        const page = list.find((t) => t.type === 'page')
        if (page !== undefined) { wsUrl = page.webSocketDebuggerUrl; break }
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  if (wsUrl === undefined) { proc.kill(); throw new Error('Chrome CDP 未就绪') }
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data))
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  const cdp = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++msgId
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  cdpClient = { ws, proc, cdp }
  return cdpClient
}

/** 批量把 SVG 字符串渲染成 data URL（webp 或 png）。返回 [{ name, dataUrl }] */
async function renderBatch(items, fmt, quality) {
  const { cdp } = await getCdp()
  const mime = fmt === 'webp' ? 'image/webp' : 'image/png'
  const fn = `(async (items, fmt, q) => {
    const out = [];
    for (const it of items) {
      const img = new Image();
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(it.svg)));
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('svg load fail')) });
      const c = document.createElement('canvas');
      c.width = it.w; c.height = it.h;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, it.w, it.h);
      ctx.drawImage(img, 0, 0, it.w, it.h);
      const blob = await new Promise((res) => c.toBlob(res, fmt, q));
      const dataUrl = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
      out.push({ name: it.name, dataUrl });
    }
    return out;
  })`
  const r = await cdp('Runtime.evaluate', {
    expression: `(${fn})(${JSON.stringify(items)}, ${JSON.stringify(mime)}, ${quality})`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.result?.exceptionDetails !== undefined) {
    throw new Error('渲染失败: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  }
  return r.result?.result?.value ?? []
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────

function frameName(shortId, track, idx) {
  return `${shortId}-pet-${track}${idx + 1}.webp`
}

async function generateCharacter(id) {
  const c = CHARACTERS[id]
  if (c === undefined) throw new Error(`未知角色: ${id}（可用: ${CHAR_IDS.join(', ')}）`)
  const shortId = id.replace('-girl', '')
  const root = join(OUT, id)
  // 1) 动作帧 SVG 全量
  const jobs = []
  for (const [track, def] of Object.entries(TRACKS)) {
    for (let i = 0; i < def.frames.length; i++) {
      jobs.push({ name: frameName(shortId, track, i), svg: frameSvg(c, track, i), w: 192, h: 208 })
    }
  }
  // 三视图（规格 §5 步骤 1 产物，供角色定稿使用；不进运行时轨道）
  jobs.push({ name: 'three-views.webp', svg: threeViewSvg(c), w: 576, h: 208 })
  process.stdout.write(`[gen] ${id} 渲染 ${jobs.length} 帧（六轨 ${Object.values(TRACKS).reduce((a, t) => a + t.frames.length, 0)} + 三视图）…`)
  const results = await renderBatch(jobs, 'webp', 0.92)
  if (results.length !== jobs.length) throw new Error(`${id}: 期望 ${jobs.length} 帧，实际 ${results.length}`)
  // 2) 落位 <out>/<id>/<track>/<帧>.webp
  for (const { name, dataUrl } of results) {
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64')
    let track = ''
    if (name !== 'three-views.webp') {
      for (const t of Object.keys(TRACKS)) {
        if (name.startsWith(`${shortId}-pet-${t}`)) { track = t; break }
      }
    }
    const dir = track.length > 0 ? join(root, track) : root
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), buf)
  }
  process.stdout.write(` 完成（${Math.round(results.reduce((a, r) => a + r.dataUrl.length, 0) / 1024)}KB data）\n`)
}

async function main() {
  const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const ids = targets.length > 0 ? targets : CHAR_IDS
  for (const id of ids) {
    try {
      await generateCharacter(id)
    } catch (error) {
      console.error(`[gen] ${id} FAILED: ${error.message}`)
      process.exitCode = 1
    }
  }
  const client = cdpClient
  if (client !== null) {
    try { client.ws.close() } catch { /* ignore */ }
    setTimeout(() => client.proc.kill(), 100)
  }
  console.log(`[gen] 完成。帧落位 ${join(OUT, '<id>/<track>/*.webp')}；pet.json 由 scripts/pet-asset-slice.mjs 产出。`)
}

// 供预览/测试脚本复用
export { CHARACTERS, CHAR_IDS, TRACKS, frameSvg, threeViewSvg }

import { pathToFileURL } from 'node:url'
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry) await main()
