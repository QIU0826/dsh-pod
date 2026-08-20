/**
 * 真实环境 preflight 冒烟测试（DoD-14 的数据源）。
 * 只在 POD_LIVE_PREFLIGHT=1 时运行：真实调用本机 CLI，验证
 * 探测逻辑与真实输出格式的契约（版本 pin、登录态、codex 缺失如实报告）。
 * 常规 CI/单测不运行（不依赖机器环境，保持确定性）。
 */
import { describe, expect, it } from 'vitest'
import { execCommandRunner, runPreflight } from '../src/workers/preflight'

const live = process.env.POD_LIVE_PREFLIGHT === '1'

describe.runIf(live)('live preflight（真实 CLI，Windows 本机）', () => {
  it('claude 已安装已登录；codex 如实报告未安装（CR-01-0）', async () => {
    const report = await runPreflight({ runner: execCommandRunner, cwd: 'D:\\玩具' })
    const claude = report.checks.find((c) => c.id === 'claude')!
    expect(claude.status).toBe('ok')
    expect(claude.detail).toMatch(/2\.1\.\d+/)
    const codex = report.checks.find((c) => c.id === 'codex')!
    expect(codex.status).toBe('fail')
    expect(codex.detail).toMatch(/not installed/)
    const node = report.checks.find((c) => c.id === 'node')!
    expect(node.status).toBe('ok')
  }, 30_000)
})
