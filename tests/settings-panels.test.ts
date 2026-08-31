import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsView } from '../src/web/settings-view.js'
import { DEFAULT_SETTINGS } from '../src/web/console-settings.js'

/**
 * 设置页的两个新面板（长期记忆 / 定时任务）。
 * 此前这两块只有工具面（pod_mem_* / pod_cron_list）能给 LLM 用，人完全够不着。
 * 这里守的是「UI 上确实有入口」，不覆盖取数逻辑（那条由 routes.test.ts 守）。
 */
describe('设置页面板：长期记忆 / 定时任务（HTTP 面补齐后的人入口）', () => {
  // 必须走 createElement：SettingsView 内部用 useState/useEffect，
  // 直接当普通函数调用拿不到 hook 上下文（Cannot read properties of null）。
  const html = renderToStaticMarkup(createElement(SettingsView, { settings: DEFAULT_SETTINGS, onSave: () => undefined }))

  it('两个面板都渲染出来', () => {
    expect(html).toContain('长期记忆')
    expect(html).toContain('定时任务')
  })

  it('如实写明「记录不可删除」——MemoryStore 没有删除记录的接口（另：提供主动写入 + owner 筛选）', () => {
    // 少了这句，用户会去找一个不存在的删除按钮
    expect(html).toContain('记录不可删除')
    // 写入入口（此前只有工具面 pod_mem_write 能给 LLM 用；团队归属 team:<mission_id> 在 UI 可见）
    expect(html).toContain('主动写入')
    expect(html).toContain('team:')
    expect(html).toContain('按 owner 筛选')
  })

  it('首屏是读取中占位，不是空白（取数失败也由面板自己渲染错误条）', () => {
    expect(html).toContain('读取中')
  })
})
