import { describe, expect, it } from 'vitest'
import {
  POD_CORE_TOOLS,
  EXPAND_TOOL_NAME,
  buildToolIndexLine,
  estimatePresentationTokens,
  isCoreTool,
  presentTools,
  stageOf,
} from '../src/core/tool-stages.js'

describe('P0-1 工具定义分层加载（stage 清单 + 呈现构建）', () => {
  it('阶段分类：CORE 每轮全量；launch/plan/memory/cron/reassign 按 stage', () => {
    expect(isCoreTool('pod_status')).toBe(true)
    expect(isCoreTool('pod_abort')).toBe(true)
    expect(stageOf('pod_launch')).toBe('launch')
    expect(stageOf('pod_plan')).toBe('plan')
    expect(stageOf('pod_mem_write')).toBe('memory')
    expect(stageOf('pod_cron_list')).toBe('cron')
    expect(stageOf('pod_reassign')).toBe('dispatch')
    expect(stageOf('pod_status')).toBeUndefined()
  })

  it('presentTools：CORE + 当前 stage 全量，其余进索引', () => {
    const all = [...POD_CORE_TOOLS, 'pod_launch', 'pod_plan', 'pod_reassign', 'pod_mem_write', 'pod_mem_query', 'pod_mem_correct', 'pod_cron_list']
    const p = presentTools({ activeStage: 'dispatch', all })
    // CORE(8) + dispatch stage(pod_reassign) = 9 个全量
    expect(p.full).toContain('pod_status')
    expect(p.full).toContain('pod_reassign')
    expect(p.full).toHaveLength(POD_CORE_TOOLS.length + 1)
    // 其余进索引：launch/plan/mem*3/cron = 6
    expect(p.index).toContain('pod_launch')
    expect(p.index).toContain('pod_mem_write')
    expect(p.index).toHaveLength(6)
  })

  it('分层呈现显著削减 token（对照全量 2,838 tok 实测口径）', () => {
    // 用测量脚本同款 schema 字符数（scripts/measure-tools.mjs 实测口径）
    const schemaChars: Record<string, number> = {
      pod_launch: 2057, pod_plan: 1138, pod_mem_write: 866, pod_approve: 831, pod_mem_query: 725,
      pod_mem_correct: 643, pod_reassign: 615, pod_steer: 487, pod_status: 481, pod_collect: 403,
      pod_cron_list: 375, pod_abort: 364, pod_dispatch: 330, pod_resume: 318, pod_pause: 300,
    }
    const all = Object.keys(schemaChars)
    const fullTokens = estimatePresentationTokens(all, [], schemaChars, 0)
    const staged = presentTools({ activeStage: 'dispatch', all })
    const stagedTokens = estimatePresentationTokens(staged.full, staged.index, schemaChars)
    expect(fullTokens).toBe(2838)
    // 分层后 ≤ 60%（目标 −50%+）
    expect(stagedTokens).toBeLessThanOrEqual(Math.ceil(fullTokens * 0.6))
  })

  it('索引行：name + brief + stage 标签 + 展开提示', () => {
    const line = buildToolIndexLine({ name: 'pod_mem_write', brief: '主动写入长期记忆', stage: 'memory' })
    expect(line).toContain('pod_expand_tool("pod_mem_write")')
    expect(line).toContain('[stage:memory]')
  })

  it('元工具契约：EXPAND_TOOL_NAME 固定、不属任何 stage（总是展开可用）', () => {
    expect(EXPAND_TOOL_NAME).toBe('pod_expand_tool')
    expect(isCoreTool(EXPAND_TOOL_NAME)).toBe(false)
    expect(stageOf(EXPAND_TOOL_NAME)).toBeUndefined()
  })
})
