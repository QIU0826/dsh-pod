/**
 * 工具级 onion middleware —— 方案书 3.10 / CR-08 AgentScope-E。
 *
 * wrapTool(tool, hooks) 统一在工具调用前后挂钩子（记账/审计/事件/权限），
 * 消除各调用点的重复代码；多层 wrap 呈洋葱语义（内层 after 先于外层）。
 */

export interface ToolHooks<TArgs = unknown, TResult = unknown> {
  /** 调用前钩子：抛错即拦截原工具（如权限 deny、预算短路）。 */
  before?(args: TArgs): Promise<void> | void
  /** 调用后钩子：可记录/改写结果，返回透传。 */
  after?(result: TResult, args: TArgs): Promise<TResult> | TResult
}

export interface MiddlewareTool<TArgs = unknown, TResult = unknown> {
  name: string
  execute(args: TArgs): Promise<TResult>
}

/** 包裹工具：返回新工具（原工具不可变，钩子按注册顺序执行）。 */
export function wrapTool<TArgs, TResult>(
  tool: MiddlewareTool<TArgs, TResult>,
  hooks: ToolHooks<TArgs, TResult>,
): MiddlewareTool<TArgs, TResult> {
  return {
    name: tool.name,
    async execute(args: TArgs): Promise<TResult> {
      await hooks.before?.(args)
      const result = await tool.execute(args)
      const final = await hooks.after?.(result, args)
      return final !== undefined ? final : result
    },
  }
}
