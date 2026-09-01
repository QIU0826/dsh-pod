/**
 * IM webhook server —— 把 channel-im（Slack/飞书 vendor adapter）接到真实 HTTP 服务面
 * （审计 P2「channel-im 服务面零集成」闭环）。
 *
 * 与 scripts/channel-http-server.mjs（通用 channel.ts 裸 {text}，无 vendor 验签）不同，
 * 本入口接 src/im-http.ts 的 createImHttpHandler：入站先做 vendor 签名校验（Slack
 * HMAC-SHA256 / 飞书 sha256 或明文 verification token），再做挑战握手 / 重放去重 / 指令路由。
 *
 * 用法（先 build）：
 *   POD_SLACK_SIGNING_SECRET=<secret> node scripts/im-http-server.mjs          # Slack 模式
 *   POD_LARK_ENCRYPT_KEY=<key> POD_LARK_VERIFICATION_TOKEN=<token> node scripts/im-http-server.mjs  # 飞书加密
 *   POD_LARK_VERIFICATION_TOKEN=<token> node scripts/im-http-server.mjs        # 飞书明文模式（token 是唯一入站鉴权）
 *
 * 可选：
 *   POD_IM_HOST / POD_IM_PORT（默认 127.0.0.1:3960）
 *   POD_IM_TOKEN（传输层 Bearer，反向代理共享密钥；vendor 签名才是主鉴权，此为额外一层）
 *
 * fail-closed 纪律（Berd-H）：
 *   - 未配任何 vendor 凭据也能启动（用于健康检查），但所有 webhook 请求都会被验签拒绝；
 *   - 绑非 loopback 且未设 POD_IM_TOKEN → 拒绝启动（外部入口须显式启用 + 鉴权）；
 *   - 出站投递未接 bot token：仅 stderr 打印回复，HTTP 仍回 ack（联调可观测）。
 */

import { listenImHttp } from '../dist/im-http.js'
import { createPodRuntime } from '../dist/plugin.js'
import { PodService } from '../dist/pod-service.js'

async function main() {
  const host = (process.env.POD_IM_HOST ?? '127.0.0.1').trim()
  const port = Number(process.env.POD_IM_PORT ?? 3960)
  const token = (process.env.POD_IM_TOKEN ?? '').trim()
  const slackSigningSecret = (process.env.POD_SLACK_SIGNING_SECRET ?? '').trim()
  const larkEncryptKey = (process.env.POD_LARK_ENCRYPT_KEY ?? '').trim()
  const larkVerificationToken = (process.env.POD_LARK_VERIFICATION_TOKEN ?? '').trim()

  // fail-closed：绑非 loopback 且未设 token → 拒绝（外部入口须显式启用 + 鉴权）
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  if (!isLoopback && token.length === 0) {
    console.error('[dsh-pod-im] refusing to bind non-loopback host without POD_IM_TOKEN (external entry must be explicitly enabled)')
    process.exit(1)
  }
  const vendors = [
    slackSigningSecret.length > 0 ? 'slack' : null,
    larkEncryptKey.length > 0 || larkVerificationToken.length > 0 ? 'lark' : null,
  ].filter(Boolean)
  if (vendors.length === 0) {
    console.error('[dsh-pod-im] warning: no vendor credential configured; all webhooks will be rejected (fail-closed)')
  }

  const dataDir = process.env.POD_DATA_DIR
  const runtime = createPodRuntime(dataDir && dataDir.length > 0 ? dataDir : undefined)
  const service = new PodService({ store: runtime.store, memory: runtime.memory, dataDir: runtime.dataDir })
  const started = await listenImHttp(service, {
    host,
    port,
    token,
    ...(slackSigningSecret.length > 0 ? { slackSigningSecret } : {}),
    ...(larkEncryptKey.length > 0 ? { larkEncryptKey } : {}),
    ...(larkVerificationToken.length > 0 ? { larkVerificationToken } : {}),
  })
  console.error('[dsh-pod-im] webhook on http://' + host + ':' + started.port + '/webhook/{slack,lark}'
    + (token.length ? ' (token auth)' : ' (no token, loopback-only)')
    + (vendors.length > 0 ? ' vendors: ' + vendors.join(',') : ' (no vendor credential)'))

  const shutdown = async () => { await started.close(); process.exit(0) }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main().catch((error) => {
  console.error('[dsh-pod-im] fatal:', error)
  process.exit(1)
})
