import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { avatarAccent, avatarMotion, avatarLabel, isChibi, AVATAR_OPTIONS, Avatar } from '../src/web/avatars.js'

/**
 * 形象状态映射：把 agent 的抽象状态翻译成「动作 + 颜色」。
 * 多 agent 并行时这是最省成本的全局感知手段——一眼扫过去就知道谁需要关注。
 */
describe('形象动作映射（avatarMotion）', () => {
  it('工作中晃动 / 协商张望 / 出错抖动 / 暂停打盹', () => {
    expect(avatarMotion('working')).toBe('work')
    expect(avatarMotion('running')).toBe('work')
    expect(avatarMotion('dispatched')).toBe('lean')
    expect(avatarMotion('negotiating')).toBe('look')
    expect(avatarMotion('accepted')).toBe('lean')
    expect(avatarMotion('waiting_approval')).toBe('look')
    expect(avatarMotion('error')).toBe('shake')
    expect(avatarMotion('rejected')).toBe('shake')
    expect(avatarMotion('paused')).toBe('sleep')
    expect(avatarMotion('rate_limited')).toBe('sleep')
    expect(avatarMotion('idle')).toBe('idle')
  })

  it('生命周期新增的状态不再落到 idle（此前全都是静止的）', () => {
    // 任务生命周期协商化后新增 negotiating/accepted/rejected/paused，
    // 映射漏掉的话用户看到的就是「在跑但形象一动不动」
    for (const status of ['paused', 'negotiating', 'accepted', 'rejected']) {
      expect(avatarMotion(status), `${status} 不应落到 idle`).not.toBe('idle')
    }
  })

  it('未知状态安全回落到 idle（不抛错、不落到某个具体动作）', () => {
    expect(avatarMotion(undefined)).toBe('idle')
    expect(avatarMotion('some-future-status')).toBe('idle')
  })
})

describe('形象状态色（avatarAccent）', () => {
  it('出错红 / 待审批黄 / 工作中青 / 暂停灰 / 完成绿', () => {
    expect(avatarAccent('error')).toBe('var(--error)')
    expect(avatarAccent('rejected')).toBe('var(--error)')
    expect(avatarAccent('waiting_approval')).toBe('var(--warning)')
    expect(avatarAccent('working')).toBe('var(--primary)')
    expect(avatarAccent('running')).toBe('var(--primary)')
    expect(avatarAccent('accepted')).toBe('var(--primary)')
    expect(avatarAccent('paused')).toBe('var(--ink-3)')
    expect(avatarAccent('rate_limited')).toBe('var(--ink-3)')
    expect(avatarAccent('done')).toBe('var(--success)')
    expect(avatarAccent('negotiating')).toBe('var(--info)')
    expect(avatarAccent('dispatched')).toBe('var(--info)')
  })

  it('最易误读的几组必须异色：出错≠工作中、暂停≠工作中、待审批≠完成', () => {
    expect(avatarAccent('error')).not.toBe(avatarAccent('working'))
    expect(avatarAccent('paused')).not.toBe(avatarAccent('working'))
    expect(avatarAccent('waiting_approval')).not.toBe(avatarAccent('done'))
    expect(avatarAccent('waiting_approval')).not.toBe(avatarAccent('working'))
  })

  it('空闲用中性色（不与任何「需要关注」的状态抢注意力）', () => {
    expect(avatarAccent('idle')).toBe('var(--line)')
    const attention = ['error', 'waiting_approval', 'working', 'done']
    for (const status of attention) {
      expect(avatarAccent(status)).not.toBe(avatarAccent('idle'))
    }
  })
})

describe('Q 版娘化形象', () => {
  it('chibi id 被识别，经典动物不是 chibi', () => {
    expect(isChibi('dsh')).toBe(true)
    expect(isChibi('claude')).toBe(true)
    expect(isChibi('gpt')).toBe(true)
    expect(isChibi('codex')).toBe(true)
    expect(isChibi('opencode')).toBe(true)
    expect(isChibi('ark')).toBe(true)
    expect(isChibi('cat')).toBe(false)
    expect(isChibi(undefined)).toBe(false)
    expect(isChibi('')).toBe(false)
  })

  it('点选词表包含全部 6 个 Q 版娘和 8 个经典动物', () => {
    const ids = AVATAR_OPTIONS.map((a) => a.id)
    for (const id of ['cat', 'fox', 'owl', 'bear', 'rabbit', 'wolf', 'frog', 'deer']) {
      expect(ids).toContain(id)
    }
    for (const id of ['claude', 'gpt', 'codex', 'opencode', 'ark', 'dsh']) {
      expect(ids).toContain(id)
    }
  })

  it('中文标签可读：claude 娘 / DSH 娘等', () => {
    expect(avatarLabel('claude')).toBe('Claude 娘')
    expect(avatarLabel('gpt')).toBe('GPT 娘')
    expect(avatarLabel('codex')).toBe('Codex 娘')
    expect(avatarLabel('opencode')).toBe('OpenCode 娘')
    expect(avatarLabel('ark')).toBe('ARK 娘')
    expect(avatarLabel('dsh')).toBe('DSH 娘')
  })

  it('渲染出的 SVG 包含 chibi 标记、状态动作类、状态色与分层部位', () => {
    const statuses = ['idle', 'working', 'dispatched', 'negotiating', 'accepted', 'waiting_approval', 'error', 'rejected', 'paused', 'rate_limited', 'done'] as const
    for (const id of ['claude', 'gpt', 'codex', 'opencode', 'ark', 'dsh']) {
      for (const status of statuses) {
        const el = Avatar(id, status, 32, true)
        const svg = renderToStaticMarkup(el)
        expect(svg, `${id} ${status}: chibi class`).toContain('dsh-av-chibi')
        expect(svg, `${id} ${status}: motion class`).toContain(avatarMotion(status))
        expect(svg, `${id} ${status}: accent color`).toContain(avatarAccent(status))
        for (const part of ['chi-body', 'chi-head', 'chi-hair', 'chi-face', 'chi-arm-l', 'chi-arm-r']) {
          expect(svg, `${id} ${status}: ${part}`).toContain(part)
        }
      }
    }
  })

  it('经典动物形象仍走整体动画，不带 chibi 标记', () => {
    const el = Avatar('cat', 'working', 32, true)
    const svg = renderToStaticMarkup(el)
    expect(svg).toContain('class="dsh-av work"')
    expect(svg).not.toContain('dsh-av-chibi')
  })
})
