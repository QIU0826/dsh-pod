import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 核心域层是纯逻辑资产：单测必须快（<50ms/用例），禁止真实 CLI/网络依赖
    testTimeout: 5000,
    hookTimeout: 5000,
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
