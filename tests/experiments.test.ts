import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Experiments, DEFAULT_EXPERIMENTS } from '../src/core/experiments.js'

/**
 * Berd-E：experiments 灰度开关框架（~/.dsh/pod/experiments.json）。
 * 默认关、dev 构建默认开；首批 key = 审批模式2/3、第三栏、拓扑动画。
 */

let root: string

function makeExperiments(overrides?: Record<string, boolean>) {
  root = mkdtempSync(join(tmpdir(), 'pod-exp-'))
  return new Experiments({ filePath: join(root, 'experiments.json'), defaults: overrides })
}

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
})

describe('experiments 灰度开关（Berd-E）', () => {
  it('默认关闭（保守立场）', () => {
    const exp = makeExperiments()
    exp.load()
    for (const key of Object.keys(DEFAULT_EXPERIMENTS)) {
      expect(exp.isEnabled(key)).toBe(false)
    }
  })

  it('DEFAULT_EXPERIMENTS 首批 key：审批2/3、第三栏、拓扑动画', () => {
    for (const key of ['approval-mode-2', 'approval-mode-3', 'canvas-third-column', 'topology-animation']) {
      expect(key in DEFAULT_EXPERIMENTS).toBe(true)
    }
  })

  it('开启后持久化并可跨实例读取（experiments.json 磁盘事实源）', () => {
    const exp = makeExperiments()
    exp.load()
    exp.setEnabled('topology-animation', true)
    exp.flush()
    const reloaded = new Experiments({ filePath: join(root, 'experiments.json') })
    reloaded.load()
    expect(reloaded.isEnabled('topology-animation')).toBe(true)
    expect(reloaded.isEnabled('approval-mode-2')).toBe(false)
  })

  it('未知 key：isEnabled 返回 false（fail-closed，不静默开启）', () => {
    const exp = makeExperiments()
    exp.load()
    expect(exp.isEnabled('not-a-real-key')).toBe(false)
  })

  it('自定义默认（dev 构建默认开）', () => {
    const exp = makeExperiments({ 'topology-animation': true })
    exp.load()
    expect(exp.isEnabled('topology-animation')).toBe(true)
    expect(exp.isEnabled('approval-mode-2')).toBe(false)
  })
})
