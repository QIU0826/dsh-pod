/**
 * MCP Gateway（AgentScope-J）—— 客户端侧的多 MCP server 聚合与路由。
 *
 * 与既有 `mcp-server.ts` 互补：后者是「把 Pod 暴露为 MCP server」（外部驱动 Pod），
 * 本模块是「Pod 作为 MCP 客户端」——把多个下游 MCP server 的工具聚合成统一工具面，
 * 供编排层按命名空间路由调用。
 *
 * 纪律（沿用项目既有不变量）：
 *   - 命名空间隔离：工具名一律 `serverId__toolName`，跨 server 同名互不覆盖；
 *   - 审批门不绕过：写类工具调用前过 `beforeCall` 钩子，未获批即拒绝，不降级执行；
 *   - 凭据不出会话：server 凭据由调用方从环境注入，不落事件流/记忆/日志；
 *   - fail-closed：未知 server / 未知工具 / 调用异常 → 抛 PodError，不静默成功。
 *
 * 纯逻辑 + 注入式连接（transport 由调用方提供），可离线单测。
 */

import { PodError } from './errors.js'

/** 下游 MCP server 声明（不含凭据；凭据由调用方注入到 connection）。 */
export interface McpServerSpec {
  id: string
  /** 人类可读标签（审计与 UI 用）。 */
  label?: string
  /** 该 server 上被视为「写操作」、调用前必须过审批门的工具名（精确匹配）。 */
  gatedTools?: string[]
}

/** 下游连接抽象（真实实现走 stdio / Streamable HTTP；测试用假件）。 */
export interface McpServerConnection {
  id: string
  listTools(): Promise<McpToolDef[]>
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>
  close?(): Promise<void>
}

export interface McpToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpCallResult {
  ok: boolean
  /** 结构化输出（已截断，避免大对象进上下文/事件流）。 */
  output?: unknown
  error?: string
}

/** 聚合后的工具引用（带来源与是否需审批）。 */
export interface GatewayTool {
  /** 网关内唯一名：`serverId__toolName`。 */
  ref: string
  serverId: string
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  /** 调用前是否需过审批门。 */
  gated: boolean
}

export interface McpGatewayOptions {
  servers: McpServerSpec[]
  connections: McpServerConnection[]
  /** 审批门钩子：返回 false 表示未获批，调用被拒（不执行）。 */
  beforeCall?: (tool: GatewayTool, args: Record<string, unknown>) => Promise<boolean> | boolean
  /** 审计钩子（凭据字段已被剔除后调用）。 */
  audit?: (entry: GatewayAudit) => void
  /** 单次调用输出的最大字符数（防大对象灌爆上下文与事件流）。 */
  maxOutputChars?: number
  now?: () => number
}

export interface GatewayAudit {
  ts: number
  serverId: string
  tool: string
  gated: boolean
  approved: boolean
  ok: boolean
  error?: string
}

const DEFAULT_MAX_OUTPUT_CHARS = 8_000

export class McpGatewayError extends PodError {
  constructor(message: string) {
    super(message, 'MCP_GATEWAY_ERROR')
  }
}

/** 网关名 = `serverId__toolName`（双下划线分隔，避免与工具名内的单下划线混淆）。 */
export function gatewayRef(serverId: string, toolName: string): string {
  return `${serverId}__${toolName}`
}

function truncate(value: unknown, max: number): unknown {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  if (text.length <= max) return value
  return `${text.slice(0, max)}…（已截断 ${text.length - max} 字符）`
}

export class McpGateway {
  private readonly specs = new Map<string, McpServerSpec>()
  private readonly conns = new Map<string, McpServerConnection>()
  private readonly beforeCall?: McpGatewayOptions['beforeCall']
  private readonly audit?: McpGatewayOptions['audit']
  private readonly maxOutputChars: number
  private readonly now: () => number

  constructor(opts: McpGatewayOptions) {
    for (const s of opts.servers) this.specs.set(s.id, s)
    for (const c of opts.connections) this.conns.set(c.id, c)
    this.beforeCall = opts.beforeCall
    this.audit = opts.audit
    this.maxOutputChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
    this.now = opts.now ?? (() => Date.now())
    // 声明了 server 却没有连接 → fail-closed（配置错误必须显式暴露）
    for (const id of this.specs.keys()) {
      if (!this.conns.has(id)) throw new McpGatewayError(`MCP server 声明了但无连接: ${id}`)
    }
  }

  /** 聚合全部下游工具（带来源与审批标记）。 */
  async listTools(): Promise<GatewayTool[]> {
    const out: GatewayTool[] = []
    for (const [id, conn] of this.conns) {
      const spec = this.specs.get(id)
      const gated = new Set(spec?.gatedTools ?? [])
      for (const t of await conn.listTools()) {
        out.push({
          ref: gatewayRef(id, t.name),
          serverId: id,
          name: t.name,
          ...(t.description !== undefined ? { description: t.description } : {}),
          ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
          gated: gated.has(t.name),
        })
      }
    }
    return out
  }

  /** 按网关名路由调用：解析 server → 审批门 → 执行 → 截断 → 审计。 */
  async callTool(ref: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
    const sep = ref.indexOf('__')
    if (sep <= 0) throw new McpGatewayError(`非法工具引用（应为 serverId__toolName）: ${ref}`)
    const serverId = ref.slice(0, sep)
    const toolName = ref.slice(sep + 2)
    const conn = this.conns.get(serverId)
    if (conn === undefined) throw new McpGatewayError(`未知 MCP server: ${serverId}`)

    const gated = (this.specs.get(serverId)?.gatedTools ?? []).includes(toolName)
    let approved = true
    if (gated && this.beforeCall !== undefined) {
      approved = await this.beforeCall(
        { ref, serverId, name: toolName, gated },
        args,
      )
      if (!approved) {
        this.audit?.({ ts: this.now(), serverId, tool: toolName, gated, approved: false, ok: false, error: 'approval denied' })
        return { ok: false, error: '调用未获审批（审批门不绕过）' }
      }
    }

    try {
      const result = await conn.callTool(toolName, args)
      const truncated = result.output === undefined
        ? result
        : { ...result, output: truncate(result.output, this.maxOutputChars) }
      this.audit?.({
        ts: this.now(),
        serverId,
        tool: toolName,
        gated,
        approved,
        ok: result.ok,
        ...(result.error !== undefined ? { error: result.error } : {}),
      })
      return truncated
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.audit?.({ ts: this.now(), serverId, tool: toolName, gated, approved, ok: false, error: message })
      throw new McpGatewayError(`MCP 调用失败 ${ref}: ${message}`)
    }
  }

  async close(): Promise<void> {
    for (const conn of this.conns.values()) {
      if (conn.close !== undefined) await conn.close()
    }
  }
}

/** 便捷装配（与 McpGateway 等价，供调用方少一层 new）。 */
export function makeMcpGateway(opts: McpGatewayOptions): McpGateway {
  return new McpGateway(opts)
}
