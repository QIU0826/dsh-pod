/**
 * 灰度开关框架 —— 方案书 3.4 数据模型 Experiment / CR-08 Berd-E。
 *
 * 持久化于 ~/.dsh/pod/experiments.json（磁盘事实源）；默认关，dev 构建可注入默认开。
 * 首批 key：审批模式 2/3、Canvas 第三栏、拓扑动画（灰度入 v0.2 的开关位）。
 * fail-closed：未知 key 一律视为关。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ExperimentsOptions {
  filePath: string
  /** 默认值（dev 构建注入用）；持久化文件中的值优先。 */
  defaults?: Record<string, boolean>
}

/** 首批灰度 key（v2.1 声明式清单，与方案书一致）。 */
export const DEFAULT_EXPERIMENTS: Record<string, boolean> = {
  'approval-mode-2': false,
  'approval-mode-3': false,
  'canvas-third-column': false,
  'topology-animation': false,
}

export class Experiments {
  private readonly filePath: string
  private readonly defaults: Record<string, boolean>
  private state: Record<string, boolean> = {}

  constructor(options: ExperimentsOptions) {
    this.filePath = options.filePath
    this.defaults = { ...DEFAULT_EXPERIMENTS, ...(options.defaults ?? {}) }
  }

  load(): void {
    if (!existsSync(this.filePath)) {
      this.state = {}
      return
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      this.state = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, boolean>) : {}
    } catch {
      // 损坏的 experiments.json 视为空（fail-closed），不阻断插件启动
      this.state = {}
    }
  }

  isEnabled(key: string): boolean {
    if (key in this.state) return this.state[key] === true
    return this.defaults[key] === true
  }

  setEnabled(key: string, enabled: boolean): void {
    this.state[key] = enabled
  }

  flush(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8')
  }
}
