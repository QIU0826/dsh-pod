/**
 * spawn argv 动态值校验（P1：Windows shell:true 下 cmd 元字符即命令注入）。
 *
 * claude/codex 在 win32 用 shell:true（.cmd 分发必须），Node 会把 argv 拼成整条
 * 命令行交给 cmd /c 且不做逐参数引用——model/worktree/session 等运行期动态值里的
 * `& | ^ % < > ( ) !` 等元字符会被 shell 解释。prompt 走 stdin 已堵住最大注入面，
 * 这里补齐 argv 侧：
 *   - token（model/session/thread id）：严格白名单，这些值本就是标识符；
 *   - path（worktree）：元字符黑名单——合法路径可含空格（Node shell 拼接下本就
 *     破坏 argv 解析，属既有功能限制而非注入面），但绝不允许 cmd 元字符。
 */
const CMD_METACHARS = /[\r\n\t&|^%<>()!"'`]/
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._\/\\:@+=\[\]-]*$/

export function assertSafeArgvToken(label: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return
  if (!SAFE_TOKEN.test(value)) {
    throw new Error(
      `unsafe argv token for ${label}: ${JSON.stringify(value.slice(0, 80))} (whitelist: letters/digits/._-/\\:@+=[])`,
    )
  }
}

export function assertSafeArgvPath(label: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return
  if (CMD_METACHARS.test(value)) {
    throw new Error(`unsafe argv path for ${label}: contains shell metacharacters (${value.slice(0, 80)})`)
  }
}
