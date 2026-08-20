// One-shot dev tool: add .js extensions to relative imports (NodeNext resolution).
// Reads/writes UTF-8 explicitly — never pipe TS through non-UTF8 shells.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const roots = ['src', 'tests']

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full)
  }
  return out
}

const STATIC = /from '(\.\.?\/[^']+?)(?<!\.js)'/g
const DYNAMIC = /import\('(\.\.?\/[^']+?)(?<!\.js)'\)/g

let touched = 0
for (const root of roots) {
  for (const file of walk(root)) {
    const before = readFileSync(file, 'utf8')
    const after = before.replace(STATIC, "from '$1.js'").replace(DYNAMIC, "import('$1.js')")
    if (after !== before) {
      writeFileSync(file, after, 'utf8')
      touched++
      console.log('fixed', file)
    }
  }
}
console.log('done, touched', touched)
