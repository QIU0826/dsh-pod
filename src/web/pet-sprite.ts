/**
 * 桌宠精灵渲染引擎（学习 dsh-web/dsh-pet 的 sprite2d 契约，2026-09-02）。
 *
 * 渲染方式：div + background-image(atlas) + background-size(整图×scale) +
 * background-position(-col×cellW×scale, -row×cellH×scale)，requestAnimationFrame
 * 按每帧 durations 推进——与 dsh-pet PetSprite 相同的 CSS 帧动画方案
 * （无 Canvas、无第三方库，宿主/standalone 两形态零依赖可用）。
 *
 * 9 行动画契约（atlas 行序）：
 *   0 idle / 1 running-right / 2 running-left / 3 waving / 4 jumping /
 *   5 failed / 6 waiting / 7 running / 8 review
 * 每行帧数：[6, 8, 8, 4, 5, 8, 6, 6, 6]（whale-girl 原版 manifest）。
 * sequences：phase → 多轨轮换序列（thinking = running↔running-right/left 跑动）。
 */
import { createElement, useEffect, useRef, type CSSProperties, type ReactElement } from 'react'
import { WHALE_ATLAS_DATA_URL } from './pet-atlas-data.js'

// ─── 图集契约（纯函数，单测覆盖） ────────────────────────────────────────────

export type PetAnimation =
  | 'idle'
  | 'running-right'
  | 'running-left'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review'

/** phase = 桌宠房间语义（harness 工作状态映射层见 pet-room.ts）。 */
export type PetPhase = 'idle' | 'thinking' | 'tool' | 'review' | 'waiting' | 'done' | 'failed'

const ROW_OF: Record<PetAnimation, number> = {
  idle: 0,
  'running-right': 1,
  'running-left': 2,
  waving: 3,
  jumping: 4,
  failed: 5,
  waiting: 6,
  running: 7,
  review: 8,
}

export const CELL = { width: 192, height: 208 } as const
export const COLUMNS = 8
/** 每行实际使用的帧数（whale-girl manifest；index = 行号）。 */
export const ROW_FRAMES: readonly number[] = [6, 8, 8, 4, 5, 8, 6, 6, 6]

/** 一帧在缩放图集内的 background-position（负偏移）。 */
export function framePosition(animation: PetAnimation, frameIndex: number, scale = 1): { x: number; y: number } {
  return { x: -frameIndex * CELL.width * scale, y: -ROW_OF[animation] * CELL.height * scale }
}

/** phase → 单轨动画（无 sequences 时的直接映射）。 */
export function animationForPhase(phase: PetPhase): PetAnimation {
  switch (phase) {
    case 'thinking':
      return 'running'
    case 'tool':
      return 'running-right'
    case 'review':
      return 'review'
    case 'waiting':
      return 'waiting'
    case 'done':
      return 'jumping'
    case 'failed':
      return 'failed'
    default:
      return 'idle'
  }
}

/** 每帧时长（ms），whale-girl manifest 的 durations（循环取用）。 */
const DURATIONS: Record<PetAnimation, readonly number[]> = {
  idle: [500, 500, 600, 500, 500, 600],
  'running-right': [300, 300, 300, 300, 300, 300, 300, 400],
  'running-left': [300, 300, 300, 300, 300, 300, 300, 400],
  waving: [450, 450, 450, 450],
  jumping: [400, 400, 400, 450, 450],
  failed: [550, 550, 550, 600, 650, 700, 550, 550],
  waiting: [550, 550, 600, 550, 550, 600],
  running: [330, 330, 330, 330, 330, 400],
  review: [650, 650, 650, 650, 650, 650],
}

/** phase → 轨道轮换序列（每项一个 track，各自跑完完整时长再切下一条，整体循环）。 */
const SEQUENCES: Record<PetPhase, readonly PetAnimation[]> = {
  idle: ['idle', 'waving', 'idle', 'waiting', 'idle', 'idle'],
  waiting: ['waiting', 'idle', 'waving', 'waiting', 'idle', 'waiting'],
  thinking: ['running', 'running-right', 'running', 'running-left', 'running', 'waiting', 'running'],
  tool: ['running-right', 'running', 'running-left', 'running', 'running-right', 'running'],
  review: ['review', 'waiting', 'review', 'running', 'review', 'idle'],
  done: ['jumping', 'waving', 'jumping', 'waving', 'jumping', 'idle'],
  failed: ['failed', 'waiting', 'failed', 'idle', 'waiting', 'failed'],
}

interface SequenceState {
  track: PetAnimation
  index: number
  elapsed: number
  seqIndex: number
  seqElapsed: number
}

/** 推进序列状态一帧（纯函数，单测覆盖）：返回新状态与应渲染的动画/帧号。 */
export function advanceSequence(st: SequenceState, deltaMs: number, phase: PetPhase): SequenceState & { animation: PetAnimation; frame: number } {
  const seq = SEQUENCES[phase] ?? SEQUENCES.idle
  let s: SequenceState = { ...st }
  s.seqElapsed += deltaMs
  let track = seq[s.seqIndex % seq.length] ?? 'idle'
  let durations = DURATIONS[track]
  let guard = 0
  // 整条 track 跑完 → 序列推进到下一条（guard 防异常 durations 死循环）
  while (s.seqElapsed >= totalDuration(track) && guard++ < 16) {
    s.seqElapsed -= totalDuration(track)
    s.seqIndex = (s.seqIndex + 1) % seq.length
    track = seq[s.seqIndex] ?? 'idle'
    durations = DURATIONS[track]
  }
  // track 内帧推进
  s.track = track
  s.elapsed += deltaMs
  let index = 0
  let remaining = s.elapsed
  while (index < durations.length - 1 && remaining >= (durations[index] ?? 0)) {
    remaining -= durations[index] ?? 0
    index += 1
  }
  if (remaining >= (durations[index] ?? 0)) {
    // track 循环（所有轨道都 loop）
    s.elapsed = 0
    index = 0
  } else {
    s.elapsed = remaining
  }
  s.index = index
  const frames = ROW_FRAMES[ROW_OF[track]] ?? durations.length
  return { ...s, animation: track, frame: Math.min(index, Math.max(0, frames - 1)) }
}

function totalDuration(track: PetAnimation): number {
  return DURATIONS[track].reduce((a, b) => a + b, 0)
}

export function initialSequenceState(phase: PetPhase): SequenceState {
  return { track: animationForPhase(phase), index: 0, elapsed: 0, seqIndex: 0, seqElapsed: 0 }
}

// ─── 组件 ──────────────────────────────────────────────────────────────────

export interface Sprite2dAtlas {
  /** 图集图片源（URL 或 data URL）。缺省内置鲸鱼娘。 */
  src: string
  /** 单帧 cell 尺寸（默认鲸鱼娘 192x208）。 */
  cellWidth?: number
  cellHeight?: number
  columns?: number
}

export interface PetSpriteProps {
  phase: PetPhase
  /** 显示高度 px（宽度按 cell 比例 192:208）。 */
  size?: number
  /** 品牌色滤镜（harness 区分：CSS filter，如 hue-rotate）。 */
  filter?: string
  className?: string
  style?: CSSProperties
  /** 外部图集（生态 sprite2d 角色，如 ouo-neko/whale-refined）；缺省内置鲸鱼娘。 */
  atlas?: Sprite2dAtlas
}

/** 桌宠精灵：atlas 帧动画。prefers-reduced-motion 时保持首帧（无动画）。 */
export function PetSprite(props: PetSpriteProps): ReactElement {
  const { phase, size = 128, filter, className, style, atlas } = props
  const spriteRef = useRef<HTMLDivElement | null>(null)
  const seqRef = useRef<SequenceState>(initialSequenceState(phase))
  const cellW = atlas?.cellWidth ?? CELL.width
  const cellH = atlas?.cellHeight ?? CELL.height
  const columns = atlas?.columns ?? COLUMNS
  const atlasSrc = atlas?.src ?? WHALE_ATLAS_DATA_URL

  useEffect(() => {
    const el = spriteRef.current
    if (el === null) return
    const scale = size / cellH
    el.style.backgroundImage = 'url(' + atlasSrc + ')'
    el.style.backgroundSize = cellW * columns * scale + 'px ' + cellH * 9 * scale + 'px'
    el.style.backgroundRepeat = 'no-repeat'
    if (filter !== undefined) el.style.filter = filter
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
    // 先画首帧（永不空白）
    const lead = advanceSequence(initialSequenceState(phase), 0, phase)
    el.style.backgroundPosition = framePosition(lead.animation, lead.frame, scale).x + 'px ' + framePosition(lead.animation, lead.frame, scale).y + 'px'
    if (reduceMotion) return
    let raf = 0
    let last = performance.now()
    let phaseCurrent = phase
    const tick = (ts: number): void => {
      const delta = Math.min(ts - last, 250) // 后台 tab 回来不跳帧爆走
      last = ts
      if (phaseCurrent !== phase) {
        phaseCurrent = phase
        seqRef.current = initialSequenceState(phase) // 状态切换重置序列（立即可见反馈）
      }
      const next = advanceSequence(seqRef.current, delta, phase)
      seqRef.current = { track: next.track, index: next.index, elapsed: next.elapsed, seqIndex: next.seqIndex, seqElapsed: next.seqElapsed }
      const pos = framePosition(next.animation, next.frame, scale)
      el.style.backgroundPosition = pos.x + 'px ' + pos.y + 'px'
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase, size, filter, atlasSrc, cellW, cellH, columns])

  return createElement('div', {
    ref: spriteRef,
    className,
    style: {
      width: Math.round((size * cellW) / cellH) + 'px',
      height: size + 'px',
      imageRendering: 'auto',
      pointerEvents: 'none',
      ...style,
    },
  })
}
