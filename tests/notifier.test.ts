/**
 * Notifier —— CR-01-10 桌面通知：事件 → 告警映射 + kind/mission 去重 + 送达计数。
 */
import { describe, expect, it } from 'vitest'
import { Notifier, type Notification } from '../src/core/notifier.js'

describe('Notifier（CR-01-10 桌面通知）', () => {
  it("scanEvents 提取需人工动作事件并送达（approval/转人工/预算熔断/暂停）", () => {
    let t = 1_700_000_000_000
    const sent: Notification[] = []
    const n = new Notifier({ clock: () => t, send: (x) => { sent.push(x); return true } })
    const delivered = n.scanEvents([
      { kind: 'approval_requested', mission_id: 'M-1' },
      { kind: 'task_escalated', mission_id: 'M-1', task_id: 'T-1' },
      { kind: 'budget_short_circuit', mission_id: 'M-1', task_id: 'T-2' },
      { kind: 'mission_paused_budget', mission_id: 'M-1' },
      { kind: 'worker_progress', mission_id: 'M-1' },
    ])
    expect(delivered).toBe(4)
    expect(sent.map((s) => s.kind)).toEqual([
      'approval_pending', 'task_escalated', 'budget_short_circuit', 'mission_paused',
    ])
    expect(sent[0]!.title).toContain("审批卡待裁决")
    expect(sent[1]!.detail).toContain("T-1")
  })

  it("去重窗口内同 kind+mission 不重复送达；窗口外可再送达", () => {
    let t = 1_700_000_000_000
    let count = 0
    const n = new Notifier({ clock: () => t, send: () => { count++; return true }, dedupeMs: 60_000 })
    n.scanEvents([{ kind: "approval_requested", mission_id: "M-1" }])
    expect(count).toBe(1)
    n.scanEvents([{ kind: "approval_requested", mission_id: "M-1" }])
    expect(count).toBe(1)
    t += 61_000
    n.scanEvents([{ kind: "approval_requested", mission_id: "M-1" }])
    expect(count).toBe(2)
  })

  it("不同 mission 或不同 kind 不算去重（各自独立送达）", () => {
    let count = 0
    const n = new Notifier({ clock: () => 1_700_000_000_000, send: () => { count++; return true } })
    n.scanEvents([{ kind: "approval_requested", mission_id: "M-1" }])
    n.scanEvents([{ kind: "approval_requested", mission_id: "M-2" }])
    n.scanEvents([{ kind: "task_escalated", mission_id: "M-1" }])
    expect(count).toBe(3)
  })

  it("emit 返回 false 表示 send 回调拒绝（宿主未送达）", () => {
    const n = new Notifier({ clock: () => 1_700_000_000_000, send: () => false })
    expect(n.emit("approval_pending", "M-1", "t", "d")).toBe(false)
  })
})
