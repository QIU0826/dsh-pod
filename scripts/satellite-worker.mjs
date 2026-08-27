/**
 * Satellite worker —— 卫星机进程入口（多机 satellite，docs/satellite.md，v0.3）。
 *
 * 在卫星机上跑一个 loopback HTTP 端点，供本机 RemoteBackend 派发任务执行。
 *   默认用确定性 stub 后端（不发网络/不调模型，纯验证线协议）；
 *   POD_SATELLITE_BACKEND=stub|ark 切换后端（ark 走 ARK_API_KEY / ~/.claude/settings.json）。
 *
 * 用法（先 build）：
 *   node scripts/satellite-worker.mjs                                # 默认 127.0.0.1:3950，stub 后端
 *   POD_SATELLITE_PORT=3950 POD_SATELLITE_TOKEN=<secret> node scripts/satellite-worker.mjs
 *   POD_SATELLITE_BACKEND=ark ARK_API_KEY=<key> node scripts/satellite-worker.mjs
 */

import { listenSatellite, StubBackend } from '../dist/workers/satellite-server.js'
import { ArkBackend } from '../dist/workers/ark-headless.js'

async function main() {
  const host = (process.env.POD_SATELLITE_HOST ?? '127.0.0.1').trim()
  const port = Number(process.env.POD_SATELLITE_PORT ?? 3950)
  const token = (process.env.POD_SATELLITE_TOKEN ?? '').trim()
  const backendName = (process.env.POD_SATELLITE_BACKEND ?? 'stub').trim()

  let backend
  if (backendName === 'stub') {
    backend = new StubBackend('dsh')
  } else if (backendName === 'ark') {
    const key = (process.env.ARK_API_KEY ?? '').trim()
    backend = new ArkBackend({ apiKey: key })
  } else {
    throw new Error('POD_SATELLITE_BACKEND unsupported: ' + backendName + ' (use stub|ark)')
  }

  const started = await listenSatellite({ backend, host, port, token })
  console.error('[dsh-satellite] on ' + started.url + ' backend=' + backendName + (token ? ' (token auth)' : ' (no token, loopback-only)'))
  const shutdown = async () => { await started.close(); process.exit(0) }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main().catch((error) => {
  console.error('[dsh-satellite] fatal:', error)
  process.exit(1)
})
