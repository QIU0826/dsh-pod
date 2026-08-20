/**
 * dsh-pod —— 浏览器半（client half）入口。运行在 DSH Web GUI。
 *
 * W0 范围：locale 字典注册（Team Builder / Canvas 文案将在 W3/W4 切片加入），
 * 无 DOM 挂载。挂载策略（W3 起）沿 dsh-ssh 实证模式：DOM 失败只降级不抛出——
 * web shell 因插件 apply 抛错会整机失败，外部插件绝不允许拖垮 GUI。
 *
 * Export discipline（packages/client rule）：只携带 cordis 加载所需与类型。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace this plugin owns. */
const NS = 'dsh-pod'

/** 键字面量联合（LocaleNamespaceMap 值类型要求 keyof 形态，沿 dsh-ssh 惯例）。 */
export type PodLocaleKey = 'pod.name' | 'pod.wip'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-pod': PodLocaleKey
  }
}

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () =>
      ctx.locale.register(NS, {
        zh: {
          'pod.name': 'Pod 鲸群',
          'pod.wip': '多智能体驾驶舱建设中（v0.1 核心骨架已就绪，界面随 W3/W4 切片开放）',
        },
        en: {
          'pod.name': 'Pod',
          'pod.wip': 'Multi-agent cockpit under construction (v0.1 core ready; UI lands in W3/W4)',
        },
      }),
    'dsh-pod: dictionaries',
  )
}
