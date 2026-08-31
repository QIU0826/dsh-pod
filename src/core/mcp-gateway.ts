/**
 * MCP Gateway（AgentScope-J）—— 客户端侧的多 MCP server 聚合与路由。
 *
 * 与既有 `mcp-server.ts` 互补：后者是「把 Pod 暴露为 MCP server」（外部驱动 Pod），
 * 本模块是「Pod 作为 MCP 客户端」——把多个下游 MCP server 的工具聚合成统一工具面，
 * 供编排层按命名空间路由调用。
 *
 * 纪律（沿用项目既有不变量）：
 *   - 命名空间隔离：工具名一律 `serverId__toolName`，跨 server 同名互不覆盖；
 *   - 审批门不绕过：写类工具调用前过 `beforeCall` 钩子，未获批即拒绝；
 *     未接线审批钩子时 gated 工具一律拒绝（fail-closed，不静默放行）；
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
    for (const s of opts.servers) {
      // serverId 是命名空间的一部分（serverId__toolName），含分隔符会让 callTool 解析错位
      if (s.id.length === 0 || s.id.includes('__')) {
        throw new McpGatewayError(`非法 MCP server id（非空且不含 __）: ${JSON.stringify(s.id)}`)
      }
      this.specs.set(s.id, s)
    }
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

  /**
   * 审计 P1 · 工具描述静态审查：对全部聚合工具跑一遍扫描，返回风险命中。
   * 接入第三方 server 前调用（接入方决定是否阻断注册）；不阻断本网关运行。
   */
  async scanTools(): Promise<ToolScanFinding[]> {
    const tools = await this.listTools()
    return scanToolDescriptions(tools)
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
    if (gated) {
      // fail-closed（审计 P1 修复）：gated 工具在没有审批钩子时必须拒绝，
      // 而不是静默放行——此前「未接线 beforeCall = 全部免审批」与头注声明矛盾
      if (this.beforeCall === undefined) {
        this.audit?.({ ts: this.now(), serverId, tool: toolName, gated, approved: false, ok: false, error: 'approval hook not wired' })
        return { ok: false, error: '写类工具未配置审批钩子，已拒绝执行（fail-closed）' }
      }
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

/**
 * 下游工具 description 静态扫描结果（审计 P1 · MCP 工具描述静态审查）。
 * 防 tool poisoning / Rug Pull：第三方 MCP server 的工具描述可能夹带提示注入、
 * 外联 URL（数据外传）、越权动词。静态扫描在接入前跑一遍，命中风险工具标记出来
 * 由人工/commander 裁决，不静默放行。
 */
export interface ToolScanFinding {
  /** 网关内工具引用（serverId__toolName）。 */
  ref: string
  /** 命中风险类别。 */
  category: 'prompt_injection' | 'external_url' | 'privilege_verb'
  /** 命中的证据片段（原文，供人工判断）。 */
  evidence: string
  /** 风险级别：high=直接指令改写行为；medium=外联/越权动词需确认。 */
  severity: 'high' | 'medium'
}

/** 提示注入特征词（命令模型改写自身/无视指令/泄密）。 */
const INJECTION_PATTERNS: Array<{ re: RegExp; severity: 'high' | 'medium' }> = [
  // 命令式改写：无视/忘记/假装 + 强调语气的指令组合
  { re: /ignore\s+(all\s+)?(previous|prior|earlier|instructions|prompts|context)/i, severity: 'high' },
  { re: /disregard\s+(all\s+)?(previous|prior|instructions)/i, severity: 'high' },
  { re: /forget\s+(all\s+)?(previous|your)/i, severity: 'high' },
  { re: /you\s+are\s+now\s+(?!a\s+(helpful|bot|assistant))/i, severity: 'high' },
  { re: /act\s+as\s+(?!a\s+(tool|function|helper))/i, severity: 'medium' },
  { re: /new\s+instructions/i, severity: 'high' },
  { re: /do\s+not\s+(tell|reveal|mention)\s+(the\s+)?(user|them)/i, severity: 'medium' },
  { re: /jailbreak/i, severity: 'high' },
  { re: /system\s+prompt/i, severity: 'medium' },
  { re: /higher\s+priority/i, severity: 'medium' },
];

/** 外联 URL（潜在数据外传通道）。 */
const URL_PATTERN = /https?:\/\/[^\s'"`]+/gi

/** 越权动词（破坏性/提权操作，需在工具用途语境外确认）。 */
const PRIVILEGE_PATTERNS: Array<{ re: RegExp }> = [
  { re: /\brm\s+-rf\b/i },
  { re: /\bDROP\s+TABLE\b/i },
  { re: /\bTRUNCATE\b/i },
  { re: /\bchmod\s+(777|000|755)/i },
  { re: /\bchown\b/i },
  { re: /\bsudo\b/i },
  { re: /\bmkfs\b/i },
  { re: /\bformat\s+disk\b/i },
  { re: /\b(?:delete|drop)\s+(?:all|every|entire|the\s+whole)\s+(?:data|records|rows|files|tables)/i },
];

/**
 * 静态扫描一批工具描述，返回风险命中（每工具每类最多一条，带首条证据）。
 * 纯函数、无副作用，可离线单测；接入方决定是否阻断该 server 注册。
 */
export function scanToolDescriptions(tools: GatewayTool[]): ToolScanFinding[] {
  const findings: ToolScanFinding[] = []
  for (const tool of tools) {
    const desc = tool.description ?? ''
    if (desc.length === 0) continue
    for (const p of INJECTION_PATTERNS) {
      const m = p.re.exec(desc)
      if (m !== null) {
        findings.push({ ref: tool.ref, category: 'prompt_injection', evidence: m[0].slice(0, 120), severity: p.severity })
        break // 每类最多一条，避免刷屏
      }
    }
    const urlMatch = URL_PATTERN.exec(desc)
    if (urlMatch !== null) {
      findings.push({ ref: tool.ref, category: 'external_url', evidence: urlMatch[0].slice(0, 120), severity: 'medium' })
    }
    for (const p of PRIVILEGE_PATTERNS) {
      const m = p.re.exec(desc)
      if (m !== null) {
        findings.push({ ref: tool.ref, category: 'privilege_verb', evidence: m[0].slice(0, 120), severity: 'medium' })
        break
      }
    }
  }
  return findings
}

/** 便捷装配（与 McpGateway 等价，供调用方少一层 new）。 */
export function makeMcpGateway(opts: McpGatewayOptions): McpGateway {
  return new McpGateway(opts)
}
