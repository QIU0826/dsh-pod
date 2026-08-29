/**
 * 跨平台进程树终止（P0 审计修复：kill 链统一）。
 *
 * - Windows：taskkill /PID <pid> /T /F（命令树杀；taskkill 仅为 Windows 命令）。
 * - POSIX：进程组 SIGTERM（spawn 需 detached:true 建组）→ ESRCH 时回退单 pid。
 *
 * kill 是尽力而为的清理路径：失败不抛出（进程 exit 回调才是权威完成信号），
 * 但绝不静默装死——所有分支最终 resolve，错误由调用方按需记日志。
 */
import { execFile } from 'node:child_process'

export function killTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (pid === undefined) return Promise.resolve()
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
      return
    }
    try {
      process.kill(-pid, signal) // 进程组（spawn detached 建组）：连带终止 CLI 的孙进程
    } catch {
      try {
        process.kill(pid, signal) // 未建组或已退出：至少终止直接子进程
      } catch {
        // 目标已不存在：视为清理完成
      }
    }
    resolve()
  })
}
