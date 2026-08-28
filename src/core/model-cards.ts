/**
 * 模型卡数据契约 —— 方案书 3.4 数据模型 ModelCard / CR-08 AgentScope-H。
 *
 * Team Builder 从数据渲染名册（vendor/model/context/capabilities/价目引用），
 * 消除前端硬编码模型名；价目引用指向 ledger 价目表版本。
 */

import { DEFAULT_PRICE_TABLE } from './ledger.js'

export interface ModelCard {
  vendor: 'claude' | 'codex' | 'dsh' | 'ark' | 'opencode'
  model: string
  context_window: number
  capabilities: string[]
  /** 价目表版本引用（D7：估算必须标注版本）。 */
  price_table_ref: string
}

/** 内置模型卡（本机实证配置，CR-03：codex 模型留空走应用默认）。 */
export const DEFAULT_MODEL_CARDS: ModelCard[] = [
  {
    vendor: 'claude',
    model: 'deepseek-v4-pro',
    context_window: 1_000_000,
    capabilities: ['编码', '测试', '规划', '调研', '审查', '文档'],
    price_table_ref: DEFAULT_PRICE_TABLE.version,
  },
  {
    vendor: 'codex',
    model: '',
    context_window: 200_000,
    capabilities: ['编码', '审查', '调研'],
    price_table_ref: DEFAULT_PRICE_TABLE.version,
  },
  {
    vendor: 'dsh',
    model: '',
    context_window: 200_000,
    capabilities: ['编码', '测试', '规划', '审查', '调研', '文档'],
    price_table_ref: DEFAULT_PRICE_TABLE.version,
  },
]

/** 运行期名册（Team Builder 可注册探测发现的新模型）。 */
const registry: ModelCard[] = [...DEFAULT_MODEL_CARDS]

/** 按 vendor+model 精确查找（空 model = 供应商默认，CR-03-1）。 */
export function getModelCard(vendor: string, model: string): ModelCard | undefined {
  return registry.find((c) => c.vendor === vendor && c.model === model)
}

/** 注册新卡片（探测/用户自定义；同 vendor+model 覆盖）。 */
export function registerModelCard(card: ModelCard): void {
  const index = registry.findIndex((c) => c.vendor === card.vendor && c.model === card.model)
  if (index >= 0) registry[index] = card
  else registry.push(card)
}

/** 全量名册（Team Builder 渲染源）。 */
export function listModelCards(): ModelCard[] {
  return [...registry]
}
