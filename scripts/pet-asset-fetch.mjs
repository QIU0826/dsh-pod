/**
 * 生态角色资产下载（scripts/pet-asset-fetch.mjs）：把 dsh-web/dsh-pet 的角色包
 * （pet.json + 帧图/图集）拉到本地资产目录 `<out>/<character>/**`，
 * 供 standalone 同源静态面 `/pet-assets/` 提供（内网/离线/中国网络可达性兜底）。
 *
 * 用法：
 *   node scripts/pet-asset-fetch.mjs                       # 默认 miku + ouo-neko + whale-refined
 *   node scripts/pet-asset-fetch.mjs miku                  # 只拉一个角色
 *   POD_PET_ASSETS_OUT=<dir> node scripts/pet-asset-fetch.mjs
 *
 * 网络：GitHub API + raw.githubusercontent；被墙环境用 HTTPS_PROXY 环境变量走代理。
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const REPO = 'zhu1090093659/dsh-web'
const ASSETS_DIR = 'packages/dsh-pet/assets'
const RAW = (p) => `https://raw.githubusercontent.com/${REPO}/main/${ASSETS_DIR}/${p}`
const API = (p) => `https://api.github.com/repos/${REPO}/contents/${ASSETS_DIR}/${p}`
const UA = 'dsh-pod-asset-fetch'
const OUT = process.env.POD_PET_ASSETS_OUT ?? 'pet-assets-downloaded'
const CHARACTERS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['miku', 'ouo-neko', 'whale-refined']

async function ghJson(path) {
  const res = await fetch(API(path), { headers: { 'user-agent': UA } })
  if (!res.ok) throw new Error(`GitHub API ${path} -> ${res.status}`)
  return res.json()
}

async function download(path, dest) {
  const res = await fetch(RAW(path), { headers: { 'user-agent': UA } })
  if (!res.ok) throw new Error(`raw ${path} -> ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, buf)
  return buf.length
}

/** 目录式轨道（frames2d thumb/<track>/）与单文件资产都走这里递归。 */
async function fetchDir(rel, dest) {
  const listing = await ghJson(rel)
  for (const item of listing) {
    if (item.type === 'file') {
      const target = join(dest, item.name)
      if (existsSync(target)) continue
      const size = await download(`${rel}/${item.name}`, target)
      process.stdout.write(`  ${rel}/${item.name} (${Math.round(size / 1024)}KB)\n`)
    } else if (item.type === 'dir') {
      await fetchDir(`${rel}/${item.name}`, join(dest, item.name))
    }
  }
}

for (const character of CHARACTERS) {
  process.stdout.write(`[fetch] ${character} ...\n`)
  try {
    await fetchDir(character, join(OUT, character))
    console.log(`[fetch] ${character} -> ${join(OUT, character)} 完成`)
  } catch (error) {
    console.error(`[fetch] ${character} FAILED: ${error.message}`)
  }
}
console.log(`[fetch] 完成。把 ${OUT}/ 整个目录拷到 <dataDir>/pet-assets/（standalone 同源静态面），或本地静态托管后设 localStorage["dsh-pod.petAssetsBase"]`)
