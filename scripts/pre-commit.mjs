#!/usr/bin/env node
/**
 * pre-commit 门禁（Berd-F / EN-3）：拦截坏提交。
 * 只对本次暂存涉及 src/ 的变更跑 tsc --noEmit（快速门），失败即拒绝提交。
 * 安装：just install-hooks 或 `node scripts/pre-commit.mjs --install`
 */
import { execFileSync } from 'node:child_process'

if (process.argv.includes("--install")) {
  const { copyFileSync, existsSync, mkdirSync, chmodSync } = await import('node:fs')
  const { join } = await import('node:path')
  const hooksDir = join(process.cwd(), '.git', 'hooks')
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true })
  copyFileSync(new URL('./pre-commit.mjs', import.meta.url), join(hooksDir, 'pre-commit'))
  try { chmodSync(join(hooksDir, "pre-commit"), 0o755) } catch { /* Windows 无需执行位 */ }
  console.log("[pre-commit] installed -> .git/hooks/pre-commit")
  process.exit(0)
}

const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter((f) => f.startsWith('src/') && f.endsWith('.ts'))
if (staged.length === 0) {
  console.log("[pre-commit] no staged src/*.ts changes, skip")
  process.exit(0)
}

console.log("[pre-commit] typechecking " + staged.length + " staged src file(s)...")
try {
  execFileSync('npx', ['tsc', '--noEmit'], { stdio: 'inherit', shell: process.platform === 'win32' })
  console.log("[pre-commit] typecheck ok")
} catch {
  console.error("[pre-commit] BLOCKED: tsc --noEmit failed. Fix type errors before committing.")
  process.exit(1)
}
