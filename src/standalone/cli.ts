#!/usr/bin/env node
/**
 * dsh-pod 独立控制台 CLI 入口（CR-38 P0）——对标 block/berd 的本地服务形态。
 *
 * 用法：dsh-pod [--port 3930] [--host 127.0.0.1] [--data-dir <dir>] [--token <t>] [--opencode-bin <path>]
 * 安全（CR-29 纪律）：默认 loopback-only；--host 非 loopback 时必须 --token，否则拒绝启动。
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isLoopbackHost, listenStandalone, type StandaloneOptions } from './server.js'

export interface StandaloneCliArgs extends StandaloneOptions {
  help: boolean
}

/** 解析 CLI 参数；非法项抛 Error（cli: 前缀，机器可读）。 */
export function parseStandaloneArgs(argv: string[]): StandaloneCliArgs {
  const out: StandaloneCliArgs = { help: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = (): string => {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Error(`cli: ${flag} 缺少值`)
      i += 1
      return v
    }
    switch (flag) {
      case '--help':
      case '-h':
        out.help = true
        break
      case '--port': {
        const p = Number(value())
        if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error(`cli: --port 非法: ${p}`)
        out.port = p
        break
      }
      case '--host':
        out.host = value()
        break
      case '--data-dir':
        out.dataDir = value()
        break
      case '--token':
        out.token = value()
        break
      case '--opencode-bin':
        out.opencodeBin = value()
        break
      default:
        throw new Error(`cli: 未知参数 ${flag}`)
    }
  }
  return out
}

export function printUsage(): string {
  return [
    'dsh-pod —— 多智能体驾驶舱独立控制台',
    '',
    '用法: dsh-pod [options]',
    '  --port <n>          监听端口（默认 3930；0 = 随机）',
    '  --host <addr>       监听地址（默认 127.0.0.1；0.0.0.0 必须配 --token）',
    '  --data-dir <dir>    数据根（默认 ~/.dsh/pod，与 DSH 插件形态共用磁盘事实源）',
    '  --token <t>         Bearer token（非 loopback 监听时必填）',
    '  --opencode-bin <p>  opencode 可执行文件路径（缺省走候选探测）',
    '  -h, --help          显示本帮助',
  ].join('\n')
}

/** 启动并阻塞直至进程收到 SIGINT/SIGTERM。 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseStandaloneArgs(argv)
  if (args.help) {
    console.log(printUsage())
    return
  }
  if (!isLoopbackHost(args.host) && (args.token ?? '').trim().length === 0) {
    console.error('拒绝启动：--host 非 loopback（如 0.0.0.0）时必须提供 --token（CR-29 安全纪律）。')
    process.exitCode = 2
    return
  }
  const s = await listenStandalone(args)
  const display = s.host === '0.0.0.0' || s.host === '::' ? '127.0.0.1' : s.host
  console.log(`[dsh-pod] standalone console: http://${display}:${s.port}  (data: ${s.runtime.dataDir})`)
  const shutdown = (): void => {
    s.close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) await main()
