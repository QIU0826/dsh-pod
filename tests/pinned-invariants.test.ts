/**
 * P1-6 pinned 安全层逐字不变量测试（调研 §2.5，TypeCompact / Compaction Cliff：arXiv:2608.22752）。
 *
 * 论点：压缩/重置/delta 账本/记忆注入可能静默改写安全约束（governance decay）。
 * 处置：tenets、交付纪律、路径白名单提示属于「永远逐字、永远最前」的 pinned 层，
 * 任何动态内容（spec / 记忆 / steer / 重置摘要 / diff）都不得改写或概括它们。
 *
 * 本测试不变量：对任意 buildTaskPrompt 输出，pinned 层文本与模板**逐字节相等**
 * （与 P0-2 前缀 hash 测试同源，这里显式 pin 模板文本而非只比两次输出相等）。
 */

import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  buildTaskPrompt,
  buildTaskPromptSegments,
  COMMIT_DISCIPLINE,
  FALLBACK_IDENTITY,
} from '../src/workers/claude-headless.js'
import type { Task } from '../src/core/types.js'

const now = 1_700_000_000_000

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'T-3',
    mission_id: 'M-1',
    title: '实现 rate limiter',
    spec: '实现 RFC-12 的 rate limiter 中间件',
    skill_tags: ['编码'],
    type: 'implement',
    depends_on: [],
    status: 'running',
    attempts: 0,
    soft_attempts: 0,
    max_wall_clock_ms: 3600_000,
    created_at: now,
    updated_at: now,
    ...over,
  }
}

// 模拟编排器派发时叠加的各种动态内容（pinned 层不得被它们改写）
const TENETS = ['优先可维护性：宁可多写两行说明，也别埋坑', '先跑通再优化']
const MEMORY_BLOCK = '## 相关记忆（团队沉淀，指针式）\n- [t1] 上次用 token bucket 成功'
const STEER_BLOCK = '## 排队指令（用户 steer）\n加一层缓存'
const RESET_BLOCK = '## 会话重置摘要\n- T-1 实现 A: commit abc'

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

describe('P1-6 pinned 安全层逐字不变量（TypeCompact 防 governance decay）', () => {
  it('交付纪律与身份回退在静态脚手架中逐字出现（模板 == 输出子串）', () => {
    const segs = buildTaskPromptSegments({ task: makeTask(), worktreePath: 'C:\\repo\\w' })
    expect(segs.static).toContain(COMMIT_DISCIPLINE)
    expect(segs.static).toContain(FALLBACK_IDENTITY)
    // 静态脚手架 = 身份 + 纪律 + 报告 schema，且逐字连续
    expect(segs.static.indexOf(FALLBACK_IDENTITY)).toBe(0) // 身份最前
    expect(segs.static.indexOf(COMMIT_DISCIPLINE)).toBeGreaterThan(segs.static.indexOf(FALLBACK_IDENTITY))
  })

  it('路径白名单提示逐字出现在动态段（越界写入拦截提示不被改写）', () => {
    const segs = buildTaskPromptSegments({ task: makeTask(), worktreePath: 'C:\\repo\\w' })
    expect(segs.dynamic).toContain('## 工作目录（限定，越界写入将被拦截）')
    expect(segs.dynamic).toContain('C:\\repo\\w'); // 工作目录原文
  })

  it('叠加动态内容（tenets/记忆/steer/重置摘要）后，pinned 层 hash 不变', () => {
    const richSpec = [TENETS.map((t) => '- ' + t).join('\n'), MEMORY_BLOCK, STEER_BLOCK, RESET_BLOCK, '任务简报'].join('\n\n')
    const task = makeTask({ spec: richSpec })
    const segs = buildTaskPromptSegments({ task, worktreePath: 'W' })
    // 动态内容再多，pinned 层（静态脚手架）与模板逐字节相等
    expect(segs.static).toContain(COMMIT_DISCIPLINE)
    expect(segs.static).toContain(FALLBACK_IDENTITY)
    const full = buildTaskPrompt({ task, worktreePath: 'W' })
    expect(full).toContain(COMMIT_DISCIPLINE)
    expect(full).toContain(FALLBACK_IDENTITY)
    expect(full).toContain('优先可维护性')
    expect(full).toContain('加一层缓存')
    expect(full).toContain('T-1 实现 A')
  })

  it('与 P0-2 前缀 hash 合并：同类型任务 static 前缀 hash 恒定（跨内容不漂移）', () => {
    const t1 = makeTask({ spec: 'spec A', id: 'T-1' })
    const t2 = makeTask({ spec: 'spec B 完全不同', id: 'T-9', title: '另一个' })
    const s1 = buildTaskPromptSegments({ task: t1, charterText: 'charter', worktreePath: 'W' })
    const s2 = buildTaskPromptSegments({ task: t2, charterText: 'charter', worktreePath: 'W' })
    expect(sha256(s1.static)).toBe(sha256(s2.static))
    expect(s1.dynamic).not.toBe(s2.dynamic)
  })

  it('review 任务同样保持 pinned 层（审查提示不覆盖安全锚点）', () => {
    const review = makeTask({ type: 'review', id: 'T-4' })
    const segs = buildTaskPromptSegments({ task: review, worktreePath: 'W' })
    expect(segs.static).toContain(COMMIT_DISCIPLINE)
    expect(segs.dynamic).toContain('审查任务')
    const full = buildTaskPrompt({ task: review, worktreePath: 'W' })
    expect(full).toContain(COMMIT_DISCIPLINE)
  })
})