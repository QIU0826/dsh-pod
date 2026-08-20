import { defineConfig } from 'tsdown'

/**
 * 客户端半（browser half）打包：单一 ESM bundle 输出到 dist/client.js，
 * 由 DSH 以 /plugins/<id>/client.js 提供（dsh-ssh 同款路径）。
 * 宿主半（dist/plugin.js 及 core 依赖树）由 tsc 构建，不经过 tsdown。
 */
export default defineConfig({
  entry: { client: 'src/web/client.ts' },
  format: 'esm',
  platform: 'browser',
  outDir: 'dist',
  clean: false,
  dts: true,
  sourcemap: true,
})
