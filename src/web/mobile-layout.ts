/**
 * 移动端布局偏好（远程访问片 C，docs/远程访问-设计.md）：竖屏自动切手机布局，
 * 用户可在设置里强制桌面布局——借 dsh-web 手法，**sessionStorage 会话级**（不改全局设置、
 * 不落 localStorage），刷新保留、关标签即忘。
 *
 * 纯函数 + 注入式环境（storage / 类名开关）——node 单测不依赖真实 DOM。
 */

export const FORCE_DESKTOP_KEY = 'dsh-pod.forceDesktop'
export const FORCE_DESKTOP_CLASS = 'dsh-force-desktop'

/** 依赖注入面：默认用 sessionStorage + `<html>` 类名（见 browserMobileLayoutEnv）。 */
export interface MobileLayoutEnv {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  setClass(on: boolean): void
}

/** 是否强制桌面布局（读失败一律 false —— fail-open 回自动适配）。 */
export function readForceDesktop(env: Pick<MobileLayoutEnv, 'getItem'>): boolean {
  try {
    return env.getItem(FORCE_DESKTOP_KEY) === '1'
  } catch {
    return false
  }
}

/** 写入偏好并同步类名（即时生效，无需刷新）。写盘失败不阻断本次生效。 */
export function writeForceDesktop(env: MobileLayoutEnv, on: boolean): void {
  try {
    env.setItem(FORCE_DESKTOP_KEY, on ? '1' : '0')
  } catch {
    // 隐私模式/配额异常：偏好不落盘，但类名仍按本次选择生效（当次会话可见）
  }
  env.setClass(on)
}

/** 启动时按会话偏好同步类名。 */
export function applyForceDesktop(env: MobileLayoutEnv): void {
  env.setClass(readForceDesktop(env))
}

/** 浏览器实现（standalone 启动与设置面板共用）。 */
export function browserMobileLayoutEnv(): MobileLayoutEnv {
  return {
    getItem: (k) => window.sessionStorage.getItem(k),
    setItem: (k, v) => window.sessionStorage.setItem(k, v),
    setClass: (on) => {
      document.documentElement.classList.toggle(FORCE_DESKTOP_CLASS, on)
    },
  }
}
