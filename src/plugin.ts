/**
 * dsh-pod —— 宿主半（host half）。方案书 3.1 节五层架构的第 2 层落点。
 *
 * W0 切片（本文件当前范围）：
 *   - PodRuntime 构造（Store/审批/账本，磁盘唯一事实源 ~/.dsh/pod）
 *   - 系统提示播报（announceToAgent）
 *   - /api/dsh-pod/ping 健康路由（版本 + 运行时状态）
 *
 * 后续切片（W1–W6）在同一 apply 内追加：pod_* 工具、Canvas SSE 事件通道、
 * mission 编排服务、worker 后端注册。所有注册必须走 ctx.effect 归还可逆
 * （stop/update 时全部拆除），沿 dsh-ssh 实证模式，不碰任何私有 API（R6）。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { ApprovalEngine } from './core/approvals.js'
import { PodError } from './core/errors.js'
import { Ledger } from './core/ledger.js'
import { JsonStore } from './core/store.js'
import { makePodTools } from './pod-tools.js'
import { PodService } from './pod-service.js'

/** Stable cordis plugin name. */
export const name = 'pod'

/** Services required before the Pod surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Announcement section order within the tool-guidance band. */
const SECTION_ORDER = 140

export const POD_VERSION = '0.1.0-w2'

export const POD_GUIDANCE =
  '本机已安装 dsh-pod 插件（Pod 鲸群：DSH Web 里的多智能体驾驶舱，DSH 原生）。' +
  '核心域层与 Commander 编排器就绪：任务/任务书状态机、审批引擎（模式 1 跨重启恢复）、成本账本（tokens 实测 + 等效美元估算）、交接协议、产物校验层（Verifier）、Watchdog；' +
  'pod_* 工具已注册：pod_launch（组队开 mission，质量门=合并前独立 review）、pod_status（看板/审批卡/账本）、pod_dispatch（手动派发）、pod_collect（任务产物）、pod_steer（排队指令）、pod_approve（审批卡裁决）、pod_abort（中止）。' +
  '状态持久化于 ~/.dsh/pod（磁盘唯一事实源）。合并回主树（apply_patch）属 W5 切片，当前审批通过后需手动合并。' +
  '本机员工：claude（deepseek-v4-pro，走 settings.json 配置）与 codex（ChatGPT 桌面应用内置，模型名留空走其默认 gpt-5.6-sol；缺 code-mode host → 只适合 review 等只读任务，diff 由宿主机注入）。' +
  '用户提到「Pod / 鲸群 / 多智能体 / 组队 / mission / 驾驶舱」时即指本插件，请据此协作。'

export interface PodConfig {
  /** Master switch for the plugin surfaces. */
  enabled?: boolean
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent?: boolean
  /** Runtime data root; empty defaults to ~/.dsh/pod. */
  dataDir?: string
}

export interface PodRuntime {
  store: JsonStore
  approvals: ApprovalEngine
  ledger: Ledger
  dataDir: string
}

/** 构造运行时（磁盘唯一事实源）。Store 损坏时显式抛出，调用方降级并留证。 */
export function createPodRuntime(dataDir?: string): PodRuntime {
  const root = dataDir && dataDir.length > 0 ? dataDir : join(homedir(), '.dsh', 'pod')
  const store = new JsonStore({ rootDir: root })
  store.open()
  return {
    store,
    approvals: new ApprovalEngine(store),
    ledger: new Ledger(store),
    dataDir: root,
  }
}

function pingRoute(runtime: PodRuntime | undefined, runtimeError: string | undefined): WebRoute {
  return {
    kind: 'exact',
    path: '/api/dsh-pod/ping',
    handler: (_req, res) => {
      const body =
        runtimeError === undefined && runtime !== undefined
          ? {
              ok: true,
              plugin: name,
              version: POD_VERSION,
              runtime: {
                dataDir: runtime.dataDir,
                storeVersion: runtime.store.getSchemaVersion(),
                missions: runtime.store.listMissions().map((m) => ({ id: m.id, status: m.status })),
              },
            }
          : { ok: false, plugin: name, version: POD_VERSION, error: runtimeError ?? 'runtime not initialized' }
      res.writeHead(body.ok ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    },
  }
}

/**
 * Mount the Pod runtime, health route, and announcement.
 * 失败策略：运行时构造失败（如 Store 损坏）降级为 503 播报，绝不拖垮宿主（R6/R10）。
 */
export function apply(ctx: Context, config?: PodConfig): void {
  const enabled = config?.enabled ?? true
  const announce = config?.announceToAgent ?? true
  if (!enabled) return // 总开关：不注册任何表面

  let runtime: PodRuntime | undefined
  let runtimeError: string | undefined
  try {
    runtime = createPodRuntime(config?.dataDir)
  } catch (error) {
    const podError = error instanceof PodError ? error : new PodError(String(error), 'INTERNAL', { error })
    runtimeError = `${podError.code}: ${podError.message}`
    // fail loud in host logs; user message surfaces via the 503 ping body
    console.error('[dsh-pod] runtime init failed:', podError)
  }

  ctx.effect(
    () => {
      const disposeRoute = ctx.webServer.register(pingRoute(runtime, runtimeError))
      return () => {
        disposeRoute()
      }
    },
    'dsh-pod: routes',
  )

  // pod_* 工具注册（3.3 节工具作用域清单；MVP 全局注册，作用域细化见 CR-04）。
  // 运行时损坏时同样注册工具（pod_launch 会如实报错），工具是稳定契约面。
  if (runtime !== undefined) {
    ctx.effect(
      () => {
        const service = new PodService({ store: runtime.store, dataDir: runtime.dataDir })
        const { tools } = makePodTools(service)
        const disposers = tools.map((tool) => ctx.tools.register(tool))
        return () => {
          for (const dispose of disposers) dispose()
        }
      },
      'dsh-pod: tools',
    )
  }

  if (announce) {
    ctx.effect(
      () => ctx.systemPrompt.section({ name: 'plugin:dsh-pod', order: SECTION_ORDER, text: POD_GUIDANCE }),
      'dsh-pod: announcement',
    )
  }
}
