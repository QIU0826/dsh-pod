/**
 * 手机端布局偏好（远程访问片 C）：sessionStorage 会话级 + <html> 类名开关。
 * 注入式环境——node 单测不依赖真实 DOM；读/写失败一律 fail-open，绝不抛。
 */
import { describe, expect, it } from 'vitest'
import {
  applyForceDesktop,
  browserMobileLayoutEnv,
  FORCE_DESKTOP_CLASS,
  FORCE_DESKTOP_KEY,
  readForceDesktop,
  writeForceDesktop,
  type MobileLayoutEnv,
} from '../src/web/mobile-layout.js'

function makeEnv(initial?: string): { env: MobileLayoutEnv; store: Map<string, string>; classes: boolean[] } {
  const store = new Map<string, string>()
  if (initial !== undefined) store.set(FORCE_DESKTOP_KEY, initial)
  const classes: boolean[] = []
  return {
    store,
    classes,
    env: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, v)
      },
      setClass: (on) => {
        classes.push(on)
      },
    },
  }
}

const last = (a: boolean[]): boolean | undefined => a[a.length - 1]

describe('手机端布局偏好（sessionStorage 会话级）', () => {
  it('无偏好 → 自动适配（false），apply 关闭类名', () => {
    const { env, classes } = makeEnv()
    expect(readForceDesktop(env)).toBe(false)
    applyForceDesktop(env)
    expect(last(classes)).toBe(false)
  })

  it('写入 true → 落盘 「1」+ 类名打开；写入 false → 「0」+ 类名关闭', () => {
    const { env, classes, store } = makeEnv()
    writeForceDesktop(env, true)
    expect(store.get(FORCE_DESKTOP_KEY)).toBe('1')
    expect(last(classes)).toBe(true)
    expect(readForceDesktop(env)).toBe(true)
    writeForceDesktop(env, false)
    expect(store.get(FORCE_DESKTOP_KEY)).toBe('0')
    expect(last(classes)).toBe(false)
  })

  it('已有偏好 → apply 同步类名（刷新保留）', () => {
    const { env, classes } = makeEnv('1')
    applyForceDesktop(env)
    expect(last(classes)).toBe(true)
  })

  it('storage 读抛错 → fail-open 回 false（不抛）', () => {
    const env: MobileLayoutEnv = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {},
      setClass: () => {},
    }
    expect(readForceDesktop(env)).toBe(false)
  })

  it('storage 写抛错 → 不阻断本次生效（类名仍切换）', () => {
    const classes: boolean[] = []
    const env: MobileLayoutEnv = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
      setClass: (on) => {
        classes.push(on)
      },
    }
    writeForceDesktop(env, true)
    expect(classes).toEqual([true])
  })

  it('键与类名稳定（契约）', () => {
    expect(FORCE_DESKTOP_KEY).toBe('dsh-pod.forceDesktop')
    expect(FORCE_DESKTOP_CLASS).toBe('dsh-force-desktop')
  })

  it('browserMobileLayoutEnv 惰性绑定 window/document（不提前求值）', () => {
    // 构造不应抛——实际读写在调用时才触碰 window/document
    expect(typeof browserMobileLayoutEnv().getItem).toBe('function')
  })
})
