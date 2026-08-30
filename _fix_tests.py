# -*- coding: utf-8 -*-
"""测试基建：假 cwd → 真实 git 仓库（cwd git 预检是正确行为，测试随之升级）。"""
import io, re, os

def patch(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        assert old in s, f'{path}: NOT FOUND: {old[:70]!r}'
        s = s.replace(old, new)
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print('ok', path)

GIT_HELPER = """
  /** cwd git 预检要求真实仓库：测试用临时 git 仓库（单 EMPTY_COMMIT，零内容）。 */
  function initRepo(dir: string): string {
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' })
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'init'], { stdio: 'ignore' })
    return dir
  }
"""

# ── pod-service.test.ts ──
p = 'tests/pod-service.test.ts'
s = io.open(p, encoding='utf-8').read()
if 'execFileSync' not in s:
    old = "import { JsonStore } from '../src/core/store.js'"
    assert old in s
    s = s.replace(old, "import { execFileSync } from 'node:child_process'\nimport { JsonStore } from '../src/core/store.js'")
# beforeEach 里建仓库（找 root 赋值）
m = re.search(r"(beforeEach\(\(\) => \{\n(?:.*\n)*?    store\.open\(\)\n)", s)
assert m, 'pod-service beforeEach'
s = s.replace(m.group(1), m.group(1) + "    const repo = initRepo(join(root, 'repo'))\n", 1)
s = s.replace(GIT_HELPER, '')  # helper 注入 beforeEach 前面（class 外？测试文件顶层 describe 内）
# helper 放 describe 内第一个位置
anchor = "describe("
first = s.index(anchor)
# 插在 import 后第一个 describe 前
s = s.replace("\ndescribe(", "\n" + GIT_HELPER + "\ndescribe(", 1)
s = s.replace("    const repo = initRepo(join(root, 'repo'))\n", "    const repo = initRepo(join(root, 'repo'))\n")
# 全部假 cwd 换 repo 变量
s = s.replace("cwd: 'C:\\\\repo'", "cwd: repo").replace("cwd: 'C:\\repo'", "cwd: repo")
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok pod-service.test.ts')

# ── cron-service.test.ts ──
p = 'tests/cron-service.test.ts'
s = io.open(p, encoding='utf-8').read()
if 'execFileSync' not in s:
    old = "import { JsonStore } from '../src/core/store.js'"
    assert old in s
    s = s.replace(old, "import { execFileSync } from 'node:child_process'\nimport { JsonStore } from '../src/core/store.js'")
m = re.search(r"(beforeEach\(\(\) => \{\n(?:.*\n)*?    service = new PodService\([^\n]*\n)", s)
if m is None:
    m = re.search(r"(beforeEach\(\(\) => \{\n(?:.*\n)*?    store\.open\(\)\n)", s)
assert m, 'cron beforeEach'
s = s.replace(m.group(1), m.group(1) + "    const repo = initRepo(join(root, 'repo'))\n", 1)
s = s.replace("\ndescribe(", "\n" + GIT_HELPER + "\ndescribe(", 1)
s = s.replace("cwd: 'C:\\\\repo'", "cwd: repo").replace("cwd: 'C:\\repo'", "cwd: repo")
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok cron-service.test.ts')
