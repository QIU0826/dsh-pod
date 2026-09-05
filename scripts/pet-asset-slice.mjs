/**
 * 桌宠角色切片/校验（scripts/pet-asset-slice.mjs，docs/桌宠角色生产规格.md §6）。
 *
 * 输入目录结构：`<帧目录>/<track>/<帧>.webp`（帧名按规格：`<角色>-pet-<语义><序号>.webp`）。
 * 校验：帧名安全、尺寸一致（读 webp 尺寸）、轨道非空；产出 `<out>/<id>/pet.json`
 * （显式帧表，直接可被 dsh-pod frames2d 引擎加载）。
 *
 * 用法：
 *   node scripts/pet-asset-slice.mjs ./zcode-frames --id zcode-girl --name "Zcode 娘" [--author 你] [--out demo-data/pet-assets]
 */
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const dir = args[0]
const id = arg('--id')
const name = arg('--name', id)
const author = arg('--author', 'unknown')
const out = arg('--out', 'demo-data/pet-assets')

if (dir === undefined || id === undefined) {
  console.error('用法: node scripts/pet-asset-slice.mjs <帧目录> --id <角色id> [--name 显示名] [--author 署名] [--out 输出目录]')
  process.exit(1)
}
if (!/^[a-z0-9-]+$/.test(id)) {
  console.error(`角色 id 只允许小写字母数字与连字符: ${id}`)
  process.exit(1)
}

/** webp 尺寸（VP8X / 简单 VP8 / VP8L 最小解析；解析不了返回 null 不阻断）。 */
function webpSize(buf) {
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null
  const chunk = buf.toString('ascii', 12, 16)
  if (chunk === 'VP8X') {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
  }
  if (chunk === 'VP8 ') {
    return { width: buf.readUIntLE(26, 2) & 0x3fff, height: buf.readUIntLE(28, 2) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    const b = buf.readUIntLE(21, 4)
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
  }
  return null
}

const tracksRoot = join(dir)
const trackDirs = readdirSync(tracksRoot).filter((n) => statSync(join(tracksRoot, n)).isDirectory())
if (trackDirs.length === 0) {
  console.error(`帧目录里没有任何轨道子目录: ${dir}`)
  process.exit(1)
}

const tracks = {}
let refSize = null
const problems = []
for (const track of trackDirs) {
  const files = readdirSync(join(tracksRoot, track))
    .filter((f) => /\.(webp|png|gif)$/i.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  if (files.length === 0) {
    problems.push(`轨道 ${track}: 没有帧文件`)
    continue
  }
  for (const f of files) {
    if (!/^[A-Za-z0-9_-]+\.(webp|png|gif)$/.test(f)) problems.push(`轨道 ${track}: 帧名不安全（只允许字母数字-_）: ${f}`)
  }
  // 尺寸一致性抽验（首帧 + 末帧）
  for (const f of [files[0], files[files.length - 1]]) {
    const buf = readFileSync(join(tracksRoot, track, f))
    const size = webpSize(buf)
    if (size === null) continue
    if (refSize === null) refSize = size
    else if (size.width !== refSize.width || size.height !== refSize.height) {
      problems.push(`轨道 ${track}: 帧尺寸不一致 ${f} = ${size.width}x${size.height}，基准 ${refSize.width}x${refSize.height}`)
    }
  }
  tracks[track] = { frames: files }
}

const fatal = problems.filter((p) => !p.startsWith('轨道 ') || !p.includes('帧尺寸不一致'))
if (!tracks['idle']) fatal.push('缺少 idle 轨道（必选，运行时兜底轨道）')
if (fatal.length > 0) {
  console.error('[slice] 校验失败:')
  for (const p of fatal) console.error('  -', p)
  process.exit(1)
}
if (problems.length > 0) {
  console.warn('[slice] 非致命提醒:')
  for (const p of problems.filter((p) => !fatal.includes(p))) console.warn('  -', p)
}

const manifest = {
  petManifestVersion: 2,
  id,
  displayName: name,
  author,
  license: 'MIT',
  renderer: 'frames2d',
  frames2d: {
    dir: '.',
    defaultFrameMs: 200,
    phases: {
      idle: 'idle', thinking: 'work', tool: 'drag', review: 'work',
      waiting: 'idle', done: 'success', failed: 'fail',
    },
    tracks,
  },
  x_dsh_pod: { generatedBy: 'scripts/pet-asset-slice.mjs', generatedAt: new Date().toISOString() },
}

const outDir = join(out, id)
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'pet.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(`[slice] ${id}: ${Object.keys(tracks).length} 轨道 → ${join(outDir, 'pet.json')}`)
console.log('[slice] 提示：把帧目录拷到资产基址下 <base>/' + id + '/<track>/*.webp，或本地起静态服务后设 localStorage["dsh-pod.petAssetsBase"]')
