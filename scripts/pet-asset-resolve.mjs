/**
 * 生态桌宠清单 → 显式帧表解析（scripts/pet-asset-resolve.mjs）。
 *
 * dsh-web/dsh-pet 的部分角色清单（miku 等 frames2d）轨道不带显式帧表（"list the
 * directory" 语义），依赖服务端目录列举——静态托管（raw.githubusercontent / 本地目录）
 * 列不了。本脚本经 GitHub API 列举每个轨道目录，产出**显式帧表**的解析版 pet.json
 * 到 demo-data/pet-assets/<character>/pet.json，供 dsh-pod 的 frames2d 引擎直读。
 *
 * 用法：
 *   node scripts/pet-asset-resolve.mjs                 # 解析 VENDORED_CHARACTERS 全部
 *   node scripts/pet-asset-resolve.miku miku ouo-neko  # 只解析指定角色
 *
 * 时长解析口径（与 dsh-pet manifest-v2 一致）：frameMs > 文件名编码 > defaultFrameMs。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'zhu1090093659/dsh-web'
const ASSETS_DIR = 'packages/dsh-pet/assets'
const OUT_DIR = 'demo-data/pet-assets'
const API = (p) => `https://api.github.com/repos/${REPO}/contents/${ASSETS_DIR}/${p}`
const UA = 'dsh-pod-asset-resolve'

/** 要解析的角色（+ 每角色的用途说明，写入解析版清单的 x-dsh-pod 注记）。 */
const VENDORED_CHARACTERS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['miku', 'ouo-neko', 'whale-refined']

/** 自然排序（stop2 < stop10）。 */
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

async function ghJson(path) {
  const res = await fetch(API(path), { headers: { 'user-agent': UA } })
  if (!res.ok) throw new Error(`GitHub API ${path} -> ${res.status}`)
  return res.json()
}

async function resolveCharacter(character) {
  const raw = await ghJson(`${character}/pet.json`)
  const text = Buffer.from(raw.content, 'base64').toString('utf8')
  const manifest = JSON.parse(text)
  const f2 = manifest.frames2d
  if (f2 === undefined) throw new Error(`${character}: renderer is not frames2d (skip)`)
  const dir = f2.dir && f2.dir !== '.' ? f2.dir + '/' : ''
  const defaultFrameMs = typeof f2.defaultFrameMs === 'number' ? f2.defaultFrameMs : 200
  const resolvedTracks = {}
  const skipped = []
  for (const [track, def] of Object.entries(f2.tracks)) {
    // 显式帧表直接保留；否则列目录
    if (Array.isArray(def.frames) && def.frames.length > 0) {
      resolvedTracks[track] = def
      continue
    }
    const listing = await ghJson(`${character}/${dir}${track}`)
    const frames = listing
      .filter((f) => f.type === 'file' && /\.(webp|png|gif)$/i.test(f.name))
      .map((f) => f.name)
      .sort(naturalCompare)
    if (frames.length === 0) {
      skipped.push(track)
      continue
    }
    // 时长：文件名编码 <base>_<index>_<ms> 后缀 > defaultFrameMs
    const durations = frames.map((name) => {
      const m = /_(\d{2,4})\.(\w+)$/.exec(name)
      const ms = m !== null ? Number(m[1]) : defaultFrameMs
      return ms >= 40 && ms <= 5000 ? ms : defaultFrameMs
    })
    resolvedTracks[track] = { frames, durations, loop: def.loop === undefined ? true : def.loop, ...(def.fallback !== undefined ? { fallback: def.fallback } : {}) }
  }
  const out = {
    ...manifest,
    x_dsh_pod: {
      resolvedBy: 'scripts/pet-asset-resolve.mjs',
      resolvedAt: new Date().toISOString(),
      upstream: `https://github.com/${REPO}/tree/main/${ASSETS_DIR}/${character}`,
      skippedTracks: skipped,
    },
    frames2d: { ...f2, tracks: resolvedTracks },
  }
  const outDir = join(OUT_DIR, character)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'pet.json'), JSON.stringify(out, null, 2) + '\n', 'utf8')
  const trackNames = Object.keys(resolvedTracks)
  console.log(`[resolve] ${character}: ${trackNames.length} tracks (${trackNames.join(', ')})${skipped.length > 0 ? ` | skipped: ${skipped.join(', ')}` : ''}`)
}

const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : VENDORED_CHARACTERS
for (const c of targets) {
  try {
    await resolveCharacter(c)
  } catch (error) {
    console.error(`[resolve] ${c} FAILED: ${error.message}`)
  }
}
