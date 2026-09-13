/**
 * Ollama 记忆注入全链路烟雾验证（scripts/memory-ollama-smoke.mjs）：
 *   真实 PodService（memory store）→ pod_mem_write 写入语义相关/无关记忆 →
 *   编排器同款数据路径（memoryQuery 候选池 + makeMemoryEmbedderFromEnv +
 *   rankMemoriesHybrid）→ 断言：零字面重叠的语义相关记忆入选、无关记录被滤除。
 *
 * 前置：ollama serve + ollama pull nomic-embed-text（POD_MEMORY_EMBEDDING=ollama）。
 * 用法：POD_MEMORY_EMBEDDING=ollama node scripts/memory-ollama-smoke.mjs [dataDir]
 */
import { mkdirSync, rmSync } from 'node:fs'

const dataDir = process.argv[2] ?? '.mem-smoke-' + Date.now()
process.env.POD_MEMORY_EMBEDDING = process.env.POD_MEMORY_EMBEDDING ?? 'ollama'
const madeTemp = !process.argv[2]
if (madeTemp) mkdirSync(dataDir, { recursive: true })

try {
  const { createPodRuntime } = await import('../dist/core/pod-runtime.js')
  const { PodService } = await import('../dist/pod-service.js')
  const { makeMemoryEmbedderFromEnv, rankMemoriesHybrid } = await import('../dist/core/memory-embed.js')

  const runtime = createPodRuntime(dataDir)
  const service = new PodService({ store: runtime.store, memory: runtime.memory, dataDir })

  // 1) pod_mem_write 同款写入：语义相关（低重要度）+ 无关（高重要度）
  const related = service.memory.write({
    owner_slot_id: 'team-x', type: 'fact', importance: 2, tags: [],
    content_ref: '依赖还原没有本地镜像时流水线会卡住，先配 npm 镜像再跑构建',
  })
  const unrelated = service.memory.write({
    owner_slot_id: 'team-x', type: 'fact', importance: 3, tags: [],
    content_ref: '数据库连接池默认上限 10 个，高并发时先查池占用',
  })
  console.log('[1] 写入记忆:', related.id, '(相关/重要性2)', unrelated.id, '(无关/重要性3)')

  // 2) 编排器同款：memoryQuery 候选池（全库一路）+ 同款嵌入装配
  const embedder = makeMemoryEmbedderFromEnv(process.env)
  if (embedder === undefined) throw new Error('embedder not assembled — check POD_MEMORY_EMBEDDING')
  const candidates = runtime.memory.query({ limit: 32 }) ?? []
  console.log('[2] 候选池:', candidates.length, '条 | embedder 已装配（Ollama）')

  // 3) 混合召回（orchestrator.injectRelevantMemory 同款调用形态）
  const picked = await rankMemoriesHybrid(
    candidates,
    { title: '修复发布流程', spec: 'release pipeline 的构建脚本在 CI 上跑不动，需要排查缓存配置', skill_tags: [] },
    6,
    { embedder },
  )
  const ids = picked.map((x) => x.id)
  console.log('[3] 混合召回入选:', ids)
  const pass = ids.includes(related.id) && !ids.includes(unrelated.id)
  console.log(pass ? '[PASS] 语义相关记忆入选、无关记忆被滤（向量召回端到端生效）' : '[FAIL] 召回结果不符合预期')
  process.exitCode = pass ? 0 : 1
} finally {
  // 先关 SQLite 句柄再清目录（Windows 上不关会 EBUSY）
  try {
    runtime.store.close()
  } catch { /* best effort */ }
  if (madeTemp) {
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      console.warn('[warn] 临时目录未清干净（句柄延迟释放）:', dataDir)
    }
  }
}
