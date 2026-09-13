import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 核心域层是纯逻辑资产：单测必须快（<50ms/用例），禁止真实 CLI/网络依赖
    // 超时预算：默认 5s 对「真实 git worktree I/O」的集成用例（orchestrator / apply-patch 等）
    // 在满载并发下过紧——2026-09-13 实测两处误报红（429-退避用例 8.2s；apply-patch 的
    // beforeEach 建 fixture 超 5s），两者单跑均 <2s。放宽到 20s 消抖，仍能兜住真挂死。
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts', 'src/workers/**/*.ts'],
      exclude: ['src/workers/base.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 75,
      },
    },
  },
})
