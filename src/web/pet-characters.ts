/**
 * 厂商 → 桌宠角色注册表（2026-09-05 多角色桌宠切片）。
 *
 * 角色来源：dsh-web/packages/dsh-pet/assets（生态角色包，外部加载——仓库不内联大资产，
 * 内置鲸鱼娘 data URL 作万能兜底）。两类渲染契约：
 *   - frames2d（miku：每轨道一目录逐帧 webp，帧流畅度最好）→ Frames2dPet
 *   - sprite2d（ouo-neko/whale-refined：9 行图集，与内置鲸鱼娘同契约）→ PetSprite(atlas)
 *
 * 加载基址：默认生态 raw.githubusercontent；浏览器侧可用 localStorage
 * `dsh-pod.petAssetsBase` 覆盖（镜像/本地目录部署，中国大陆可达性由部署侧解决）。
 * 角色映射可用 localStorage `dsh-pod.petCharacterMap`（JSON：vendor → character id）覆盖。
 *
 * 许可注记：miku MIT / ouo-neko MIT / whale-refined MIT / starry-doll CC-BY-NC-SA（非商用，
 * 默认不映射到内置组合，需要时在映射里自行启用）/ whale BSD-3（内置）。
 */
import { useEffect, useState } from 'react'
import { DEFAULT_PET_ASSETS_BASE, loadFrames2dManifest, type Frames2dManifest } from './pet-frames2d.js'

/** 桌宠角色渲染契约。 */
export type PetCharacterKind = 'frames2d' | 'sprite2d' | 'builtin'

export interface PetCharacterBinding {
  character: string
  kind: PetCharacterKind
  license: string
}

/** 默认厂商映射（每个 harness 一只桌宠；覆盖见上）。 */
export const VENDOR_CHARACTER: Record<string, PetCharacterBinding> = {
  claude: { character: 'miku', kind: 'frames2d', license: 'MIT' },
  codex: { character: 'ouo-neko', kind: 'sprite2d', license: 'MIT' },
  ark: { character: 'whale-refined', kind: 'sprite2d', license: 'MIT' },
  opencode: { character: 'whale-refined', kind: 'sprite2d', license: 'MIT' },
  dsh: { character: 'whale', kind: 'builtin', license: 'BSD-3-Clause' },
}

const ASSETS_BASE_KEY = 'dsh-pod.petAssetsBase'
const CHARACTER_MAP_KEY = 'dsh-pod.petCharacterMap'

/** 候选资产基址（按序探测，第一个成功解析清单的胜出）：
 *  1. localStorage 覆盖（部署侧镜像/本地目录）
 *  2. 同源 /pet-assets（standalone 静态面：<dataDir>/pet-assets/——内网/离线可用）
 *  3. 生态 raw.githubusercontent（部分网络不可达 → 落到下一候选）
 *  基址探测结果缓存（每页面生命周期一次，防每角色重复探测）。 */
let resolvedBase: string | undefined

export function petAssetsBase(): string {
  try {
    const v = window.localStorage.getItem(ASSETS_BASE_KEY)
    if (v !== null && v.trim().length > 0) return v.trim().replace(/\/$/, '')
  } catch {
    /* SSR / storage 禁用：回默认 */
  }
  return resolvedBase ?? DEFAULT_PET_ASSETS_BASE
}

/** 按序探测可用基址（loadFrames2dManifest 失败即下一候选；全部失败返回 undefined）。 */
export async function resolveAssetsBase(): Promise<string | undefined> {
  if (resolvedBase !== undefined) return resolvedBase
  const candidates: string[] = []
  try {
    const v = window.localStorage.getItem(ASSETS_BASE_KEY)
    if (v !== null && v.trim().length > 0) candidates.push(v.trim().replace(/\/$/, ''))
  } catch {
    /* 忽略 */
  }
  candidates.push(window.location.origin + '/pet-assets')
  candidates.push(DEFAULT_PET_ASSETS_BASE)
  for (const base of candidates) {
    const m = await loadFrames2dManifest(base, 'miku')
    if (m !== undefined) {
      resolvedBase = base
      return base
    }
  }
  return undefined
}

/** 覆盖映射（JSON：vendor → character id）；解析失败静默回默认映射。 */
export function vendorCharacterOverrides(): Record<string, string> {
  try {
    const v = window.localStorage.getItem(CHARACTER_MAP_KEY)
    if (v !== null) {
      const parsed: unknown = JSON.parse(v)
      if (typeof parsed === 'object' && parsed !== null) {
        return Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'),
        )
      }
    }
  } catch {
    /* 回默认 */
  }
  return {}
}

/** 解析 vendor 的角色绑定（用户覆盖优先）。 */
export function bindingForVendor(vendor: string): PetCharacterBinding {
  const overrides = vendorCharacterOverrides()
  const character = overrides[vendor]
  if (character !== undefined) {
    // 覆盖只换 character id，契约类型按内置表同 id 继承，未知 id 按 frames2d 尝试
    const known = Object.values(VENDOR_CHARACTER).find((b) => b.character === character)
    return { character, kind: known?.kind ?? 'frames2d', license: known?.license ?? 'unknown' }
  }
  return VENDOR_CHARACTER[vendor] ?? { character: 'whale', kind: 'builtin', license: 'BSD-3-Clause' }
}

// ─── frames2d 清单缓存（每角色只拉一次；失败不重试直到重载页面，防风暴） ──────────

/** 基址 hook：resolveAssetsBase 完成后返回探测到的基址（sprite2d 图集 URL 同源使用）。 */
export function usePetAssetsBase(): string {
  const [base, setBase] = useState(() => petAssetsBase())
  useEffect(() => {
    let cancelled = false
    void resolveAssetsBase().then((b) => {
      if (!cancelled && b !== undefined) setBase(b)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return base
}

const manifestCache = new Map<string, Frames2dManifest | undefined>()

/**
 * frames2d 清单加载 hook：基址探测（同源优先）→ 命中缓存同步返回；未命中异步拉取。
 * 返回 undefined = 该角色不可用（调用方回落 sprite2d/内置鲸鱼娘）。
 */
export function useFrames2dManifest(character: string | undefined): Frames2dManifest | undefined {
  const key = character ?? ''
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (character === undefined || manifestCache.has(character)) return
    let cancelled = false
    void resolveAssetsBase()
      .then((base) => (base === undefined ? undefined : loadFrames2dManifest(base, character)))
      .then((m) => {
        if (cancelled) return
        manifestCache.set(character, m)
        setVersion((v) => v + 1)
      })
    return () => {
      cancelled = true
    }
  }, [character])
  void version
  if (key.length === 0) return undefined
  return manifestCache.get(key)
}
