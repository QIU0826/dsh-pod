/**
 * cron（定时触发，AgentScope-J）—— v0.3：到期触发 + 节流防抖 + 默认关闭 + 复用审批门。
 */
import { describe, expect, it, vi } from 'vitest'
import { CronScheduler, type CronJob } from '../src/core/cron.js'
import type { ChannelTarget } from '../src/core/channel.js'

function fakeTarget(): ChannelTarget {
  return {
    status: vi.fn(() => ({ mission: { id: 'M-1' } as never, pendingApprovalIds: [] })),
    launch: vi.fn(() => ({ mission_id: 'M-cron', status: 'running' })),
    approve: vi.fn(() => ({ ok: true })),
    deny: vi.fn(),
    steer: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    abort: vi.fn(),
  }
}

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: 'cron-1', intervalMs: 60_000, command: { kind: 'status' }, enabled: true,
    ...over,
  }
}

describe('cron（定时触发，AgentScope-J）', () => {
  it('到期 job 触发一次；interval 内不重复（节流防抖）', async () => {
    const target = fakeTarget()
    const s = new CronScheduler({ clock: () => 1_000_000 })
    s.setTarget(target)
    const j = job({ intervalMs: 60_000 })
    s.register(j)
    // 首次 tick：lastFiredAt 未设 -> 触发
    const r1 = await s.tick(1_000_000)
    expect(r1.length).toBe(1)
    expect(r1[0]!.fired).toBe(true)
    expect(r1[0]!.reply_ok).toBe(true)
    expect(target.status).toHaveBeenCalledTimes(1)
    // 立即再 tick：未到 interval -> 不触发
    const r2 = await s.tick(1_000_000 + 1)
    expect(r2.length).toBe(0)
    // 到 interval 后：触发第二次
    const r3 = await s.tick(1_000_000 + 60_000)
    expect(r3.length).toBe(1)
    expect(target.status).toHaveBeenCalledTimes(2)
  })

  it('默认关闭：enabled=false 不触发（Berd-H 显式启用纪律）', async () => {
    const target = fakeTarget()
    const s = new CronScheduler({ clock: () => 100 })
    s.setTarget(target)
    s.register(job({ enabled: false }))
    const r = await s.tick(100)
    expect(r.length).toBe(0)
    expect(target.status).not.toHaveBeenCalled()
  })

  it('gate 拦截：返回 false 跳过本次', async () => {
    const target = fakeTarget()
    const s = new CronScheduler({ clock: () => 100, gate: () => false })
    s.setTarget(target)
    s.register(job({ intervalMs: 1 }))
    const r = await s.tick(100)
    expect(r.length).toBe(0)
    expect(s.historyTail().some((h) => h.reason === 'gated')).toBe(true)
  })

  it('命令经 handleChannelCommand 执行（审批门复用：approve 走 target.approve）', async () => {
    const target = fakeTarget()
    const s = new CronScheduler({ clock: () => 100 })
    s.setTarget(target)
    s.register(job({ id: 'cron-approve', intervalMs: 1, command: { kind: 'approve', approval_id: 'A-1' } }))
    const r = await s.tick(100)
    expect(r.length).toBe(1)
    expect(target.approve).toHaveBeenCalledWith('A-1', undefined)
  })

  it('未注入 target：tick 不执行（fail-closed，无旁路）', async () => {
    const s = new CronScheduler({ clock: () => 100 })
    s.register(job({}))
    const r = await s.tick(100)
    expect(r.length).toBe(0)
  })

  it('unregister 后不再触发', async () => {
    const target = fakeTarget()
    const s = new CronScheduler({ clock: () => 100 })
    s.setTarget(target)
    s.register(job({}))
    s.unregister('cron-1')
    const r = await s.tick(100)
    expect(r.length).toBe(0)
  })
})
