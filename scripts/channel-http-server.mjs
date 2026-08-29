/**
 * Channel HTTP server —— 外部协作通道（Berd-H）webhook 交付（v0.3，docs/external-channels.md）。
 *
 * 通道 adapter 框架（src/core/channel.ts：InstructionRouter + handleChannelCommand + 出站净化）
 * 经一个 loopback HTTP webhook 暴露：POST { text } 入站指令 -> 映射 pod_* 面 -> 净化回复。
 *
 * 设计约束落地：
 *   - 上下文只进（text 进），代码/diff/凭据不出（出站走 sanitizeOutboundSignal 白名单）；
 *   - 合并仍只走 service.approve（pod_approve 门，通道不绕过状态机）；
 *   - 凭据永不出会话：webhook 只收指令文本，不采集任何凭据；
 *   - 默认 loopback-only + 可选 POD_CHANNEL_TOKEN；绑非 loopback 且无 token -> 拒绝启动（fail-closed）。
 *
 * 用法（先 build）：
 *   node scripts/channel-http-server.mjs
 *   curl -X POST -H "content-type: application/json" -d '{"text":"看板状态"}' http://127.0.0.1:3960/inbound
 */

import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { createPodRuntime } from '../dist/plugin.js'
import { PodService } from '../dist/pod-service.js'
import { parseInstruction, handleChannelCommand, sanitizeOutboundSignal } from '../dist/core/channel.js'

const MAX_CHANNEL_BODY_BYTES = 64 * 1024

class BodyTooLargeError extends Error {}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > MAX_CHANNEL_BODY_BYTES) {
        // 立即拒绝但不 destroy：后续 data 继续丢弃消费，不回压死客户端
        chunks.length = 0
        reject(new BodyTooLargeError('body exceeds 64KB limit'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw.length ? JSON.parse(raw) : {})
      } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

/** 恒时 Bearer 比较（与 src/core/http-guard.ts 同款；脚本侧自包含，避免 build 顺序耦合）。 */
function tokenEquals(expected, actual) {
  const a = Buffer.from('Bearer ' + expected, 'utf8')
  const b = Buffer.from(actual, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** loopback 无 token 模式的浏览器侧防线：Host 白名单堵 DNS rebinding，Origin 堵跨站写。 */
function isLocalHostHeader(req) {
  const host = (req.headers.host ?? '').trim().toLowerCase()
  if (host.length === 0) return false
  const stripped = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1 || undefined) : host.slice(0, host.lastIndexOf(':') > 0 ? host.lastIndexOf(':') : undefined)
  const hostname = stripped.length > 0 ? stripped : host
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

async function main() {
  const host = (process.env.POD_CHANNEL_HOST ?? '127.0.0.1').trim()
  const port = Number(process.env.POD_CHANNEL_PORT ?? 3960)
  const token = (process.env.POD_CHANNEL_TOKEN ?? '').trim()
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  if (!isLoopback && token.length === 0) {
    console.error('[dsh-pod-channel] refusing to bind non-loopback host without POD_CHANNEL_TOKEN (external entry must be explicitly enabled)')
    process.exit(1)
  }

  const dataDir = process.env.POD_DATA_DIR
  const runtime = createPodRuntime(dataDir && dataDir.length > 0 ? dataDir : undefined)
  const service = new PodService({ store: runtime.store, memory: runtime.memory, dataDir: runtime.dataDir })

  const target = {
    status: () => {
      const status = service.status()
      const mission = status.mission ?? null
      const pending = (status.pendingApprovals ?? []).map((a) => a.id)
      return { mission, pendingApprovalIds: pending }
    },
    launch: (input) => {
      const m = service.launch({
        name: input.name, goal: input.goal, cwd: input.cwd,
        budgetUsd: input.budgetUsd ?? 3,
        slots: input.slots ?? [],
      })
      return { mission_id: m.id, status: m.status }
    },
    approve: (id, note) => {
      const r = service.approve(id, 'channel', note ? { merge_note: note } : undefined)
      return { ok: r.ok, message: r.ok ? undefined : r.message }
    },
    deny: (id, reason) => service.deny(id, 'channel', reason),
    steer: (id, instruction) => service.steer(id, instruction),
    pause: () => service.pauseMission(),
    resume: () => service.resumeMission(),
    abort: (reason) => service.abort(reason),
  }

  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, name: 'dsh-pod-channel', transport: 'http-webhook' }))
      return
    }
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/inbound') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    if (token.length > 0) {
      const auth = (req.headers.authorization ?? '').trim()
      if (!tokenEquals(token, auth)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
    } else if (!isLocalHostHeader(req)) {
      // P1：无 token（loopback 信任模式）叠加 Host 白名单，堵 DNS rebinding
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'forbidden: non-local Host header (DNS rebinding guard)' }))
      return
    }
    let body
    try {
      body = await readBody(req)
    } catch (error) {
      const tooLarge = error instanceof BodyTooLargeError
      res.writeHead(tooLarge ? 413 : 400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: tooLarge ? 'body too large (64KB limit)' : 'invalid json' }))
      return
    }
    const text = typeof body.text === 'string' ? body.text : ''
    const cmd = parseInstruction(text)
    // 无 active mission 时 pause/deny/steer 等经 requireOrchestrator 抛错——
    // async handler 的 rejection 无人接 = unhandledRejection 直接打崩进程（Node 22 默认退出）
    let reply
    try {
      reply = await handleChannelCommand(target, cmd)
    } catch (error) {
      console.error('[dsh-pod-channel] command failed:', error)
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'command failed', detail: error instanceof Error ? error.message : String(error) }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ...reply, outbound: sanitizeOutboundSignal({ kind: 'channel_reply' }) }))
  })

  await new Promise((resolve) => server.listen(port, host, resolve))
  console.error('[dsh-pod-channel] webhook on http://' + host + ':' + port + '/inbound' + (token ? ' (token auth)' : ' (no token, loopback-only)'))
  const shutdown = async () => { server.close(); process.exit(0) }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main().catch((error) => {
  console.error('[dsh-pod-channel] fatal:', error)
  process.exit(1)
})
