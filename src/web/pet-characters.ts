/**
 * 厂商 → 桌宠角色注册表（2026-09-05 多角色桌宠切片；2026-09-07 贴纸线角色重构）。
 *
 * 角色来源：
 *   - 本地自产 frames2d 角色（demo-data/pet-assets，按 docs/桌宠角色生产规格.md §5
 *     生成）。贴纸线（scripts/pet-assets-sticker.mjs，AI 贴纸主视觉派生六轨连接帧）：
 *     claude-girl 珊瑚橙猫头鹰娘·笔记本羽毛笔 / codex-girl 翠绿猫娘·笔记本终端齿轮 /
 *     opencode-girl 紫靛狐娘·终端窗口·六边形开源徽章 / deepseek-girl 深蓝鲸娘·厚书金环
 *     （风格基准）；SVG 平涂线（scripts/pet-assets-generate.mjs）：ark-girl 品牌蓝+火山、
 *     dsh-girl 主色青+六边形鲸群、zcode-girl 智谱蓝+终端、gemini-girl 蓝紫+四色四芒星。
 *     全部本地角色见 LOCAL_PET_CATALOG，房间内「换装」面板（setVendorCharacter）或
 *     localStorage 均可换装。仓库内联小资产，部署时拷入资产基址即被直接加载）→ 默认映射
 *   - 生态角色包 dsh-web/packages/dsh-pet/assets（外部加载，仓库不内联大资产）→ 覆盖可用
 *   - 内置鲸鱼娘 data URL 作万能兜底。两类渲染契约：
 *     - frames2d（每轨道一目录逐帧 webp，帧流畅度最好）→ Frames2dPet
 *     - sprite2d（ouo-neko/whale-refined：9 行图集，与内置鲸鱼娘同契约）→ PetSprite(atlas)
 *
 * 加载基址：默认同源 /pet-assets（standalone 静态面：<dataDir>/pet-assets/）→ 生态
 * raw.githubusercontent；浏览器侧可用 localStorage `dsh-pod.petAssetsBase` 覆盖
 * （镜像/本地目录部署，中国大陆可达性由部署侧解决）。基址探测优先用本地自产角色，
 * 探测不到再退回生态角色（miku），保证「本地角色齐 + 生态兜底」两不误。
 * 角色映射可用 localStorage `dsh-pod.petCharacterMap`（JSON：vendor → character id）覆盖。
 *
 * 许可注记：本地自产角色 MIT / miku MIT / ouo-neko MIT / whale-refined MIT /
 * starry-doll CC-BY-NC-SA（非商用，默认不映射到内置组合，需要时在映射里自行启用）/
 * whale BSD-3（内置）。
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

/** 默认厂商映射（每个内置 harness 一只按规格自产的专属桌宠；覆盖见上）。
 *  任何 frames2d 清单加载失败 → VendorPet 逐级回落内置鲸鱼娘（桌宠永不全裸）。 */
export const VENDOR_CHARACTER: Record<string, PetCharacterBinding> = {
  claude: { character: 'claude-girl', kind: 'frames2d', license: 'MIT' },
  codex: { character: 'codex-girl', kind: 'frames2d', license: 'MIT' },
  opencode: { character: 'opencode-girl', kind: 'frames2d', license: 'MIT' },
  ark: { character: 'ark-girl', kind: 'frames2d', license: 'MIT' },
  dsh: { character: 'dsh-girl', kind: 'frames2d', license: 'MIT' },
  // DeepSeek 模型线/对照风格基准：深蓝鲸娘（贴纸线，换装面板亦可选）
  deepseek: { character: 'deepseek-girl', kind: 'frames2d', license: 'MIT' },
}

/** 本地自产 frames2d 角色目录（demo-data/pet-assets，规格 §5；房间换装器的唯一数据源）。 */
export interface LocalPetCharacter {
  id: string
  displayName: string
  /** 一句话品牌方向（换装器选项说明）。 */
  hint: string
}
export const LOCAL_PET_CATALOG: readonly LocalPetCharacter[] = [
  { id: 'claude-girl', displayName: 'Claude 娘', hint: '珊瑚橙猫头鹰 · 笔记本羽毛笔' },
  { id: 'codex-girl', displayName: 'Codex 娘', hint: '翠绿猫娘 · 笔记本终端齿轮' },
  { id: 'opencode-girl', displayName: 'OpenCode 娘', hint: '紫靛狐娘 · 终端 · 开源徽章' },
  { id: 'deepseek-girl', displayName: 'DeepSeek 娘', hint: '深蓝鲸娘 · 厚书金环' },
  { id: 'zcode-girl', displayName: 'Zcode 娘', hint: '智谱蓝 + 终端' },
  { id: 'ark-girl', displayName: 'Ark 娘', hint: '品牌蓝 + 火山' },
  { id: 'dsh-girl', displayName: 'DSH 娘', hint: '青 + 六边形鲸群' },
  { id: 'gemini-girl', displayName: 'Gemini 娘', hint: '蓝紫波浪发 + 四色四芒星' },
]
const LOCAL_BY_ID = new Map(LOCAL_PET_CATALOG.map((c) => [c.id, c]))

/** 角色 id → 显示名（本地目录优先；生态/内置角色给常用名；未知回退 id）。 */
export function characterDisplayName(character: string): string {
  const local = LOCAL_BY_ID.get(character)
  if (local !== undefined) return local.displayName
  if (character === 'whale-refined') return '精绘鲸鱼娘'
  if (character === 'ouo-neko') return 'Ouo 猫娘'
  if (character === 'miku') return 'Miku'
  if (character === 'whale') return '内置鲸鱼娘'
  return character
}

const ASSETS_BASE_KEY = 'dsh-pod.petAssetsBase'
const CHARACTER_MAP_KEY = 'dsh-pod.petCharacterMap'
/** 换装覆盖变更事件（同页写入后通知房间重渲染；跨标签页由原生 storage 事件兜底）。 */
export const PET_CHARS_CHANGED_EVENT = 'dsh-pod-petchars-changed'

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

/** 基址探测用角色：先本地自产（claude-girl），再生态（miku）——本地角色齐时优先同源，
 * 只部署了生态角色时也能命中生态基址。 */
const PROBE_CHARACTERS = ['claude-girl', 'miku']

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
    for (const probe of PROBE_CHARACTERS) {
      const m = await loadFrames2dManifest(base, probe)
      if (m !== undefined) {
        resolvedBase = base
        return base
      }
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

/** 已知角色 id → 契约绑定（内置默认表 + 本地自产目录；未知 id 按 frames2d 尝试）。 */
function bindingForCharacter(character: string): PetCharacterBinding {
  const known = Object.values(VENDOR_CHARACTER).find((b) => b.character === character)
  if (known !== undefined) return known
  if (LOCAL_BY_ID.has(character)) return { character, kind: 'frames2d', license: 'MIT' }
  return { character, kind: 'frames2d', license: 'unknown' }
}

/** 解析 vendor 的角色绑定（用户覆盖优先）。 */
export function bindingForVendor(vendor: string): PetCharacterBinding {
  const overrides = vendorCharacterOverrides()
  const character = overrides[vendor]
  if (character !== undefined) return bindingForCharacter(character)
  return VENDOR_CHARACTER[vendor] ?? { character: 'whale', kind: 'builtin', license: 'BSD-3-Clause' }
}

/** 写换装覆盖（characterId=null/空串 = 移除该 vendor 覆盖回默认）；写完派发变更事件。 */
export function setVendorCharacter(vendor: string, characterId: string | null): void {
  const overrides = vendorCharacterOverrides()
  if (characterId === null || characterId.length === 0 || VENDOR_CHARACTER[vendor]?.character === characterId) {
    if (overrides[vendor] === undefined) return
    delete overrides[vendor]
  } else {
    if (overrides[vendor] === characterId) return
    overrides[vendor] = characterId
  }
  try {
    window.localStorage.setItem(CHARACTER_MAP_KEY, JSON.stringify(overrides))
    window.dispatchEvent(new Event(PET_CHARS_CHANGED_EVENT))
  } catch {
    /* storage 禁用：换装不持久化，也不炸房间 */
  }
}

/** 清空全部换装覆盖（一键恢复默认）。 */
export function clearVendorCharacters(): void {
  const overrides = vendorCharacterOverrides()
  if (Object.keys(overrides).length === 0) return
  try {
    window.localStorage.removeItem(CHARACTER_MAP_KEY)
    window.dispatchEvent(new Event(PET_CHARS_CHANGED_EVENT))
  } catch {
    /* 同上 */
  }
}

/** 换装版本号 hook：覆盖被改写（本页/跨标签页）时自增，驱动房间重渲染。 */
export function usePetCharacterVersion(): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const bump = (): void => setVersion((v) => v + 1)
    const onStorage = (e: StorageEvent): void => {
      if (e.key === null || e.key === CHARACTER_MAP_KEY) bump()
    }
    window.addEventListener(PET_CHARS_CHANGED_EVENT, bump)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(PET_CHARS_CHANGED_EVENT, bump)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return version
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
