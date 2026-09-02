/**
 * SSE 事件流客户端（AgentScope-I / EV-2）：新订阅先收 buffered history 再收 live。
 * 服务端 replay 全部事件后保持连接、增量推送；客户端按 id 去重。
 * 返回取消函数；连接断开/出错 → onError（调用方回退 2s 轮询）。
 */
import type { PodEvent } from './api.js'

export function openEventStream(
  onEvent: (event: PodEvent) => void,
  onError?: (error: Error) => void,
): () => void {
  let cancelled = false
  let controller: AbortController | null = null
  async function run(): Promise<void> {
    controller = new AbortController()
    try {
      const response = await fetch('/api/dsh-pod/events/stream', {
        signal: controller.signal,
        cache: 'no-store',
      })
      if (!response.ok || response.body === null) {
        throw new Error("SSE HTTP " + response.status)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        if (cancelled) break
        const { done, value } = await reader.read()
        if (done) {
          // 服务端正常收流（standalone 重启/重建后再起来时 reader 以 EOF 结束而非抛错）：
          // 必须走 onError 让轮询兜底接管，否则对话流静默冻结且无任何报错（审计 P3 #17）
          if (!cancelled) onError?.(new Error('SSE stream closed by server'))
          break
        }
        buffer += decoder.decode(value, { stream: true })
        let boundary: number
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const dataLine = frame.split("\n").find((line) => line.startsWith("data: "))
          if (dataLine === undefined) continue
          try {
            const event = JSON.parse(dataLine.slice(6)) as PodEvent
            onEvent(event)
          } catch {
            /* 坏帧忽略 */
          }
        }
      }
    } catch (cause) {
      if (!cancelled) onError?.(cause instanceof Error ? cause : new Error(String(cause)))
    }
  }
  void run()
  return () => {
    cancelled = true
    controller?.abort()
  }
}
