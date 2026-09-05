/**
 * 多角色桌宠（2026-09-05）回归测试：
 *   - pet-frames2d：manifest 校验 fail-closed / phase→轨道解析（fallback 链防环）/
 *     帧序列推进（循环取模、一次性轨道播完进 fallback、phase 立即切换）/ 帧 URL / 帧名安全
 *   - pet-room.reviewDuels：交叉审查对峙配对
 *   - pet-characters：厂商绑定 + 覆盖
 */
import { describe, expect, it } from 'vitest'
import {
  advanceFrames2d,
  frameUrl,
  isSafeFrameName,
  parseFrames2dManifest,
  resolvePhaseTrack,
  type Frames2dManifest,
  type Frames2dState,
} from '../src/web/pet-frames2d.js'
import { bindingForVendor, VENDOR_CHARACTER } from '../src/web/pet-characters.js'
import { reviewDuels } from '../src/web/pet-room.js'
import type { StatusResponse } from '../src/web/api.js'

function manifest(over: Partial<Frames2dManifest> = {}): Frames2dManifest {
  return {
    id: 'miku',
    displayName: 'Miku',
    base: 'http://x/assets',
    dir: 'thumb',
    tracks: {
      idle: { frames: ['a.webp', 'b.webp', 'c.webp'], durations: [200, 200, 200], loop: true },
      work: { frames: ['w1.webp', 'w2.webp'], durations: [300, 300], loop: true },
      success: { frames: ['s1.webp', 's2.webp', 's3.webp'], durations: [200, 200, 200], loop: false, fallback: 'idle' },
      fail: { frames: ['f1.webp', 'f2.webp'], durations: [250, 250], loop: false, fallback: 'idle' },
      standup: { frames: ['u1.webp'], durations: [400], loop: false, fallback: 'sleep' },
      sleep: { frames: ['z1.webp', 'z2.webp'], durations: [600, 600], loop: true },
    },
    phases: {},
    ...over,
  }
}

describe('parseFrames2dManifest（fail-closed 校验）', () => {
  const raw = {
    id: 'miku',
    displayName: 'Miku',
    frames2d: {
      dir: 'thumb',
      defaultFrameMs: 200,
      phases: { done: 'success' },
      tracks: {
        idle: { frames: ['miku-pet-stop1.webp', 'miku-pet-stop2.webp'] },
        blink: { frames: ['x.webp'], loop: false, fallback: 'idle' },
        dirOnly: {},
      },
    },
  }
  it('解析显式帧表；缺省时长按 defaultFrameMs 补齐；非循环保留 fallback', () => {
    const m = parseFrames2dManifest(raw, 'http://x/assets')
    expect(m.id).toBe('miku')
    expect(m.tracks['idle']!.frames).toHaveLength(2)
    expect(m.tracks['idle']!.durations).toEqual([200, 200])
    expect(m.tracks['blink']!.loop).toBe(false)
    expect(m.tracks['blink']!.fallback).toBe('idle')
    expect(m.tracks['dirOnly']).toBeUndefined() // 无显式帧表 → 跳过（resolve 脚本负责）
    expect(m.phases['done']).toBe('success')
  })
  it('缺 idle 轨道 → throw（调用方回落内置角色）', () => {
    const bad = { frames2d: { tracks: { work: { frames: ['a.webp'] } }, phases: {} }, id: 'x' }
    expect(() => parseFrames2dManifest(bad, 'http://x')).toThrow(/idle/)
  })
  it('不安全帧文件名（路径穿越）：idle 被跳过 → 整份清单拒绝（fail-closed 回落内置角色）', () => {
    const evil = {
      id: 'x',
      frames2d: {
        tracks: {
          idle: { frames: ['../evil.webp'] },
          safe: { frames: ['ok.webp'] },
        },
        phases: {},
      },
    }
    expect(() => parseFrames2dManifest(evil, 'http://x')).toThrow(/idle/)
  })
  it('非 idle 轨道含不安全帧名 → 该轨道跳过，清单其余部分可用', () => {
    const halfEvil = {
      id: 'x',
      frames2d: {
        tracks: {
          idle: { frames: ['ok.webp'] },
          work: { frames: ['../evil.webp'] },
        },
        phases: {},
      },
    }
    const m = parseFrames2dManifest(halfEvil, 'http://x')
    expect(m.tracks['idle']).toBeDefined()
    expect(m.tracks['work']).toBeUndefined()
  })
  it('isSafeFrameName：只放行一层安全文件名', () => {
    expect(isSafeFrameName('miku-pet-stop1.webp')).toBe(true)
    expect(isSafeFrameName('../evil.webp')).toBe(false)
    expect(isSafeFrameName('a/b.webp')).toBe(false)
  })
})

describe('resolvePhaseTrack（phase → 轨道，fallback 链防环）', () => {
  it('dsh-pod phase 缺省映射：thinking/tool/review → work，done → success，failed → fail', () => {
    const m = manifest()
    expect(resolvePhaseTrack(m, 'idle')).toBe('idle')
    expect(resolvePhaseTrack(m, 'thinking')).toBe('work')
    expect(resolvePhaseTrack(m, 'review')).toBe('work')
    expect(resolvePhaseTrack(m, 'done')).toBe('success')
    expect(resolvePhaseTrack(m, 'failed')).toBe('fail')
  })
  it('manifest.phases 覆盖缺省映射', () => {
    const m = manifest({ phases: { thinking: 'sleep' } })
    expect(resolvePhaseTrack(m, 'thinking')).toBe('sleep')
  })
  it('phases 指向缺失轨道 → 沿 fallback 链收敛（防环：8 跳上限）', () => {
    const m = manifest({ phases: { done: 'missing' } })
    // 'missing' 无 fallback 可走 → 缺省映射 done→success（存在）
    expect(resolvePhaseTrack(m, 'done')).toBe('success')
  })
})

describe('advanceFrames2d（帧序列推进）', () => {
  it('循环轨道：跨帧推进、末帧回绕', () => {
    const m = manifest()
    let st: Frames2dState & { frame: number } = { track: 'idle', index: 0, elapsed: 0, phase: 'idle', frame: 0 }
    st = advanceFrames2d(st, 250, m, 'idle')
    expect(st.frame).toBe(1)
    st = advanceFrames2d(st, 500, m, 'idle')
    expect(st.frame).toBe(0) // 2 帧时长后回绕
  })
  it('phase 切换：循环轨道立即换轨', () => {
    const m = manifest()
    const st = advanceFrames2d({ track: 'idle', index: 1, elapsed: 0, phase: 'idle' }, 10, m, 'thinking')
    expect(st.track).toBe('work')
    expect(st.frame).toBe(0)
  })
  it('一次性轨道：播完进入 fallback（success → idle），不被 phase 提前打断', () => {
    const m = manifest()
    // phase 值 idle→done 变化 → 立即切到 success 一次性轨道
    let st = advanceFrames2d({ track: 'idle', index: 0, elapsed: 0, phase: 'idle' }, 0, m, 'done')
    expect(st.track).toBe('success')
    // 播完 success（3×200ms）→ 落到 fallback idle
    st = advanceFrames2d(st, 650, m, 'done')
    expect(st.track).toBe('idle')
  })
  it('fallback 链：standup → sleep（sleep 是循环轨，驻留）', () => {
    const m = manifest()
    let st = advanceFrames2d({ track: 'standup', index: 0, elapsed: 0, phase: 'idle' }, 500, m, 'idle')
    expect(st.track).toBe('sleep')
    st = advanceFrames2d(st, 700, m, 'idle')
    expect(st.track).toBe('sleep')
    expect(st.frame).toBeGreaterThan(0)
  })
})

describe('frameUrl 与帧表', () => {
  it('URL 组装：base/id/dir/track/frame', () => {
    const m = manifest()
    expect(frameUrl(m, 'idle', 1)).toBe('http://x/assets/miku/thumb/idle/b.webp')
    expect(frameUrl(m, 'idle', 99)).toBe('http://x/assets/miku/thumb/idle/c.webp') // 越界钳制
  })
})

describe('reviewDuels（交叉审查对峙配对）', () => {
  function status(tasks: Array<Record<string, unknown>>, slots: Array<Record<string, unknown>> = []): StatusResponse {
    return {
      mission: { id: 'M-1', status: 'running' },
      tasks: tasks as never,
      slots: (slots.length > 0
        ? slots
        : [
            { id: 'M-1-S-1', vendor: 'claude', role: '实现', status: 'working' },
            { id: 'M-1-S-2', vendor: 'codex', role: '审查', status: 'working' },
          ]) as never,
    } as never
  }
  it('审查任务 running + 依赖的实现任务 running → 两槽配对', () => {
    const s = status([
      { id: 'T-1', type: 'implement', status: 'running', owner: 'M-1-S-1', depends_on: [] },
      { id: 'T-2', type: 'review', status: 'running', owner: 'M-1-S-2', depends_on: ['T-1'] },
    ])
    const duels = reviewDuels(s)
    expect(duels.get('M-1-S-2')).toBe('reviewer')
    expect(duels.get('M-1-S-1')).toBe('implementer')
  })
  it('实现任务已 done → 不配对（审查只是在收尾，不是对峙）', () => {
    const s = status([
      { id: 'T-1', type: 'implement', status: 'done', owner: 'M-1-S-1', depends_on: [] },
      { id: 'T-2', type: 'review', status: 'running', owner: 'M-1-S-2', depends_on: ['T-1'] },
    ])
    expect(reviewDuels(s).size).toBe(0)
  })
  it('审查任务 owner 不在槽位表 → 忽略（畸形数据 fail-safe）', () => {
    const s = status([
      { id: 'T-1', type: 'implement', status: 'running', owner: 'M-1-S-1', depends_on: [] },
      { id: 'T-2', type: 'review', status: 'running', owner: 'GHOST', depends_on: ['T-1'] },
    ])
    expect(reviewDuels(s).size).toBe(0)
  })
})

describe('角色绑定（vendor → character）', () => {
  it('默认映射：claude→miku(frames2d)、codex→ouo-neko(sprite2d)、dsh→builtin', () => {
    expect(bindingForVendor('claude')).toMatchObject({ character: 'miku', kind: 'frames2d' })
    expect(bindingForVendor('codex')).toMatchObject({ character: 'ouo-neko', kind: 'sprite2d' })
    expect(bindingForVendor('dsh')).toMatchObject({ kind: 'builtin' })
    expect(Object.keys(VENDOR_CHARACTER)).toContain('ark')
  })
  it('未知 vendor → 兜底内置鲸鱼娘', () => {
    expect(bindingForVendor('mystery-vendor')).toMatchObject({ kind: 'builtin', character: 'whale' })
  })
})
