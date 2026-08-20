// One-shot: re-encode PS5.1 UTF-16 fixtures to UTF-8 (native > redirect writes UTF-16LE).
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const roots = ['tests/fixtures']

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

let converted = 0
for (const root of roots) {
  for (const file of walk(root)) {
    const buf = readFileSync(file)
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      writeFileSync(file, buf.toString('utf16le').replace(/^\uFEFF/, ''), 'utf8')
      converted++
      console.log('converted', file)
    }
  }
}
console.log('done, converted', converted)
