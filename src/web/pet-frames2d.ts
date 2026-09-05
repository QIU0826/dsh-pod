/**
 * frames2d 桌宠渲染引擎（对齐 dsh-web/dsh-pet 的 petManifestVersion 2 契约，2026-09-05）。
 *
 * 与 pet-sprite.ts（sprite2d：单图集 9 行 + CSS background-position）互补：frames2d 是
 * 「每轨道一个目录、每帧一个 webp」的清单式契约（miku 等新代角色）：
 *   <base>/<character>/pet.json  →  { frames2d: { dir, defaultFrameMs, tracks, phases } }
 *   <base>/<character>/<dir>/<track>/<frame>.webp
 *
 * 诚实边界：
 *   - 只支持**显式 frames[]** 的清单（静态文件托管无法列目录）；生态角色的 pet.json
 *     由 scripts/pet-asset-resolve.mjs 预解析出显式帧表后放置（demo-data/pet-assets/）。
 *   - 任何加载/校验失败 → 返回 undefined，调用方回落内置 sprite2d 鲸鱼娘（桌宠永不全裸）。
 *   - 帧图按轨道惰性加载（miku 单轨道 4-10 帧 × ~150KB），播过的轨道进缓存。
 */

import { createElement, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

/** 生态资产基址（raw.githubusercontent 直读；中国大陆可达性由部署侧镜像/覆盖解决）。 */
export const DEFAULT_PET_ASSETS_BASE =
  'https://raw.githubusercontent.com/zhu1090093659/dsh-web/main/packages/dsh-pet/assets'

/** 一条 frames2d 轨道：显式帧表 + 每帧时长（解析后的形态）。 */
export interface Frames2dTrack {
  frames: string[]
  durations: number[]
  loop: boolean
  fallback?: string
}

/** 解析后的 frames2d 清单（dsh-pod 消费形态；显式帧表，与生态 pet.json 同源）。 */
export interface Frames2dManifest {
  id: string
  displayName: string
  /** 资产基址（帧 URL = base/id/dir/frame）。 */
  base: string
  dir: string
  tracks: Record<string, Frames2dTrack>
  /** dsh-pod PetPhase → 轨道名（manifest.phases 优先，缺省走 DEFAULT_PHASE_TRACK）。 */
  phases: Partial<Record<string, string>>
}

/** dsh-pod PetPhase → 生态轨道的缺省映射（miku 轨道词汇）。 */
export const DEFAULT_PHASE_TRACK: Record<string, string> = {
  idle: 'idle',
  thinking: 'work',
  tool: 'work',
  review: 'work',
  waiting: 'idle',
  done: 'success',
  failed: 'fail',
}

/** 帧文件名安全校验（防路径穿越：只允许字母数字-_ 与一层 .webp/.png/.gif 后缀）。 */
export function isSafeFrameName(name: string): boolean {
  return /^[A-Za-z0-9_-]+\.(webp|png|gif)$/.test(name)
}

/** manifest JSON → 强类型（校验失败 throw，调用方回落）。容忍生态原格式（无显式帧表则报缺）。 */
export function parseFrames2dManifest(raw: unknown, base: string): Frames2dManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('manifest is not an object')
  const m = raw as Record<string, unknown>
  const f2 = m.frames2d as Record<string, unknown> | undefined
  if (f2 === undefined || typeof f2 !== 'object') throw new Error('manifest.frames2d missing')
  const id = typeof m.id === 'string' ? m.id : ''
  if (id.length === 0) throw new Error('manifest.id missing')
  const dir = typeof f2.dir === 'string' && f2.dir.length > 0 ? f2.dir : '.'
  const defaultFrameMs = typeof f2.defaultFrameMs === 'number' && f2.defaultFrameMs >= 40 ? f2.defaultFrameMs : 200
  const rawTracks = f2.tracks
  if (typeof rawTracks !== 'object' || rawTracks === null) throw new Error('manifest.tracks missing')
  const tracks: Record<string, Frames2dTrack> = {}
  for (const [name, t] of Object.entries(rawTracks as Record<string, unknown>)) {
    if (typeof t !== 'object' || t === null) continue
    const tr = t as Record<string, unknown>
    const frames = tr.frames
    if (!Array.isArray(frames) || frames.length === 0 || frames.some((f) => typeof f !== 'string' || !isSafeFrameName(f))) {
      // 目录式清单（无显式帧表）在静态托管上不可解析：跳过该轨道（resolve 脚本负责产出显式帧表）
      continue
    }
    const rawDurations = tr.frameMs
    const durations: number[] = frames.map((_, i) => {
      const v = Array.isArray(rawDurations) ? rawDurations[i] : undefined
      return typeof v === 'number' && v >= 40 && v <= 5_000 ? v : defaultFrameMs
    })
    tracks[name] = {
      frames: frames as string[],
      durations,
      loop: tr.loop === undefined ? true : tr.loop === true,
      fallback: typeof tr.fallback === 'string' ? tr.fallback : undefined,
    }
  }
  if (tracks['idle'] === undefined) throw new Error('manifest.tracks.idle required (resolved manifests must include it)')
  const rawPhases = f2.phases
  const phases: Partial<Record<string, string>> =
    typeof rawPhases === 'object' && rawPhases !== null
      ? Object.fromEntries(Object.entries(rawPhases as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
      : {}
  return {
    id,
    displayName: typeof m.displayName === 'string' ? m.displayName : id,
    base: base.replace(/\/$/, ''),
    dir,
    tracks,
    phases,
  }
}

/** 拉取并解析清单；任何失败 → undefined（调用方回落内置角色）。 */
export async function loadFrames2dManifest(base: string, character: string, fetchImpl: typeof fetch = fetch): Promise<Frames2dManifest | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const res = await fetchImpl(`${base.replace(/\/$/, '')}/${character}/pet.json`, { signal: controller.signal })
    if (!res.ok) return undefined
    const raw: unknown = await res.json()
    return parseFrames2dManifest(raw, base)
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** phase → 轨道名：manifest.phases 优先 → dsh-pod 缺省映射 → 兜底 idle；fallback 链防环。 */
export function resolvePhaseTrack(manifest: Frames2dManifest, phase: string): string {
  const visited = new Set<string>()
  let track = manifest.phases[phase] ?? DEFAULT_PHASE_TRACK[phase] ?? 'idle'
  for (let hop = 0; hop < 8; hop++) {
    if (manifest.tracks[track] !== undefined || visited.has(track)) break
    visited.add(track)
    const fb = manifest.tracks[track]?.fallback
    track = fb ?? DEFAULT_PHASE_TRACK[phase] ?? 'idle'
  }
  return manifest.tracks[track] !== undefined ? track : (manifest.tracks['idle'] !== undefined ? 'idle' : track)
}

/** 帧序列推进状态（纯函数，单测覆盖）。phase = 进入当前轨道时的 phase 值（变化才切轨）。 */
export interface Frames2dState {
  track: string
  index: number
  elapsed: number
  phase: string
}

/**
 * 推进一帧。轨道切换语义（对齐生态 phase-stream 的「变化才派发」）：
 *   - phase 值变化 → 立即切到 want（重置帧序）；
 *   - phase 未变：非循环轨道播完 → 进 fallback（链式），循环轨道驻留播放；
 *   - want/fallback 无效 → 回 idle（清单保证 idle 存在，此处纯防御）。
 */
export function advanceFrames2d(
  st: Frames2dState,
  deltaMs: number,
  manifest: Frames2dManifest,
  phase: string,
): Frames2dState & { track: string; frame: number } {
  const want = resolvePhaseTrack(manifest, phase)
  let track = st.track
  let index = st.index
  let elapsed = st.elapsed + deltaMs

  if (st.phase !== phase || manifest.tracks[track] === undefined) {
    track = want
    index = 0
    elapsed = 0
  }
  let def = manifest.tracks[track]
  if (def === undefined) {
    track = 'idle'
    def = manifest.tracks['idle']!
    index = 0
    elapsed = 0
  }
  let guard = 0
  while (elapsed >= (def.durations[index] ?? def.durations[0] ?? 200) && guard++ < 32) {
    elapsed -= def.durations[index] ?? def.durations[0] ?? 200
    index += 1
    if (index >= def.frames.length) {
      if (def.loop) {
        index = 0
      } else {
        // 一次性轨道播完 → fallback（缺省 idle）；新轨道沿用当前 phase（驻留到 phase 真变化）
        const fb = def.fallback !== undefined && manifest.tracks[def.fallback] !== undefined ? def.fallback : 'idle'
        track = fb
        def = manifest.tracks[track]!
        index = 0
        if (!def.loop) break
      }
    }
  }
  const frame = Math.min(index, def.frames.length - 1)
  return { track, index: frame, elapsed, phase, frame }
}

/** 帧 URL：base/id/dir/track/frame。 */
export function frameUrl(manifest: Frames2dManifest, track: string, index: number): string {
  const def = manifest.tracks[track]
  const frame = def?.frames[Math.max(0, Math.min(index, (def?.frames.length ?? 1) - 1))] ?? ''
  return `${manifest.base}/${manifest.id}/${manifest.dir === '.' ? '' : manifest.dir + '/'}${track}/${frame}`
}

/** 惰性预加载一整条轨道的帧图（播放前调用；失败帧跳过不炸渲染）。 */
export function preloadTrack(manifest: Frames2dManifest, track: string): void {
  const def = manifest.tracks[track]
  if (def === undefined) return
  for (const f of def.frames) {
    const img = new Image()
    img.src = frameUrl(manifest, track, def.frames.indexOf(f))
  }
}

/**
 * frames2d 桌宠组件：堆叠 <img> 按 rAF 推进切换可见性（与 pet-sprite 同款零依赖方案，
 * 不用 Canvas）。轨道切换时惰性预加载。manifest 为 undefined 时不渲染（调用方回落）。
 */
export function Frames2dPet(props: {
  manifest: Frames2dManifest | undefined
  phase: string
  sizePx: number
  flip?: boolean
  shaking?: boolean
  className?: string
  style?: CSSProperties
}): ReactElement | null {
  const { manifest, phase, sizePx, flip = false, shaking = false, className, style } = props
  const stateRef = useRef<Frames2dState>({ track: 'idle', index: 0, elapsed: 0, phase })
  const [, setTick] = useState(0)
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  useEffect(() => {
    if (manifest === undefined) return
    let raf = 0
    let last = performance.now()
    const step = (now: number): void => {
      const delta = Math.min(now - last, 250)
      last = now
      const next = advanceFrames2d(stateRef.current, delta, manifest, phaseRef.current)
      const changed = next.track !== stateRef.current.track || next.index !== stateRef.current.index
      stateRef.current = { track: next.track, index: next.index, elapsed: next.elapsed, phase: next.phase }
      if (changed) setTick((t: number) => t + 1)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [manifest])

  if (manifest === undefined) return null
  const st = stateRef.current
  const track = manifest.tracks[st.track] !== undefined ? st.track : 'idle'
  const def = manifest.tracks[track]
  const frame = def !== undefined ? Math.min(st.index, def.frames.length - 1) : 0
  const url = frameUrl(manifest, track, frame)
  return createElement(
    'img',
    {
      src: url,
      alt: manifest.displayName,
      draggable: false,
      className: (shaking ? 'dsh-pet-frames2d dsh-pet-shaking' : 'dsh-pet-frames2d') + (className !== undefined ? ' ' + className : ''),
      style: {
        width: sizePx,
        height: 'auto',
        transform: flip ? 'scaleX(-1)' : undefined,
        imageRendering: 'auto',
        ...style,
      } as CSSProperties,
    },
  )
}
