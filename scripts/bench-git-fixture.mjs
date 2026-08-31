/**
 * 量化：测试 fixture 里那串 git 子进程的真实耗时分布（串行，无并发）。
 *
 * 为什么要测：全套测试偶发 "Hook timed out in 5000ms" 假失败，每次落在不同的
 * 文件（apply-patch / launch-atomicity / verifier…）。判断到底是「fixture 本身就慢」
 * 还是「并行下被拖慢」，决定了该逐文件放宽还是调全局阈值。
 *
 * 用法：node scripts/bench-git-fixture.mjs [次数]
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const N = Number(process.argv[2] ?? 15)
const times = []

for (let i = 0; i < N; i++) {
  const root = mkdtempSync(join(tmpdir(), 'pod-bench-'))
  const t0 = performance.now()
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' })
    writeFileSync(join(root, 'a.txt'), 'x\n')
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root })
    execFileSync('git', ['add', '-A'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' })
  } finally {
    times.push(performance.now() - t0)
    rmSync(root, { recursive: true, force: true })
  }
}

times.sort((a, b) => a - b)
const at = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))]
console.log(`n=${N}  min ${at(0).toFixed(0)}ms  中位 ${at(0.5).toFixed(0)}ms  p90 ${at(0.9).toFixed(0)}ms  max ${at(0.999).toFixed(0)}ms`)
console.log(`全局 hookTimeout=5000ms 的余量：中位 ${(5000 / at(0.5)).toFixed(1)}×，p90 ${(5000 / at(0.9)).toFixed(1)}×`)
