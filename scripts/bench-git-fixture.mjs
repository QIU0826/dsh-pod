/**
 * 量化：测试 fixture 里那串 git 子进程的真实耗时分布。
 *
 * 两种模式：
 *   - 串行（默认）：node scripts/bench-git-fixture.mjs [次数]
 *   - 并行：node scripts/bench-git-fixture.mjs --parallel [并发] [轮数]
 *     模拟全套测试（vitest 多 worker 同时跑多个带 git fixture 的文件）下的真实争用。
 *
 * 为什么要测：全套测试偶发 "Hook timed out in 5000ms" 假失败，每次落在不同的
 * 文件（apply-patch / launch-atomicity / verifier / orchestrator…）。串行量过是
 * 364ms（中位），但那是无争用下的数——并行下 Windows 进程创建 + Defender 扫描
 * 会让单个 fixture 飙到远超 5s。这个脚本就是要把「争用下到底多慢」量出来。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function makeFixture(withWorktree = false) {
  const root = mkdtempSync(join(tmpdir(), 'pod-bench-'))
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
  writeFileSync(join(repo, 'README.md'), '# d\n')
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' })
  if (withWorktree) {
    // orchestrator / apply-patch 每个用例还会再 spawn 一个 worktree add
    execFileSync('git', ['worktree', 'add', join(root, 'wt'), '-b', 'pod-x'], { cwd: repo, stdio: 'ignore' })
  }
  return root
}

const isParallel = process.argv[2] === '--parallel'

if (isParallel) {
  const CONCURRENCY = Number(process.argv[3] ?? 8)
  const ROUNDS = Number(process.argv[4] ?? 3)
  const peaks = []
  for (let r = 0; r < ROUNDS; r++) {
    const roots = []
    const t0 = performance.now()
    const times = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => {
        const s = performance.now()
        const root = makeFixture(true)
        roots.push(root)
        return Promise.resolve(performance.now() - s)
      }),
    )
    const wall = performance.now() - t0
    const max = Math.max(...times)
    peaks.push(max)
    console.log(`round ${r + 1}: 墙钟 ${wall.toFixed(0)}ms  单 fixture 最慢 ${max.toFixed(0)}ms`)
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
  const peak = Math.max(...peaks)
  console.log(`并发=${CONCURRENCY}（含 worktree add）  单 fixture 峰值 ${peak.toFixed(0)}ms  vs hookTimeout=5000ms`)
  console.log(`结论：峰值 ${peak < 5000 ? '未超' : '超 ' + (peak / 5000).toFixed(1) + '×'} 5s 阈值`)
} else {
  const N = Number(process.argv[2] ?? 15)
  const times = []
  for (let i = 0; i < N; i++) {
    const t0 = performance.now()
    const root = makeFixture(false)
    times.push(performance.now() - t0)
    rmSync(root, { recursive: true, force: true })
  }
  times.sort((a, b) => a - b)
  const at = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))]
  console.log(`n=${N}  min ${at(0).toFixed(0)}ms  中位 ${at(0.5).toFixed(0)}ms  p90 ${at(0.9).toFixed(0)}ms  max ${at(0.999).toFixed(0)}ms`)
  console.log(`全局 hookTimeout=5000ms 的余量：中位 ${(5000 / at(0.5)).toFixed(1)}×，p90 ${(5000 / at(0.9)).toFixed(1)}×`)
}
