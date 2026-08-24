import { defineConfig } from 'tsdown'

const id = 'dsh-pod'

/**
 * 客户端半（browser half）打包：闭包工厂产物 —— bundle 调用
 * `window.__ModuleLoader__.load({ id, factory })` 自注册，externals 走注入的
 * require（loader 模块表，无 globals、无 import map）。由 DSH 以
 * /plugins/<id>/client.js 提供（dsh-ssh 同款路径）。
 * 宿主半（dist/plugin.js 及 core 依赖树）由 tsc 构建，不经过 tsdown。
 *
 * 注意：client bundle 必须自注册，纯 `export { apply, inject }` 的 ESM 会被
 * 加载器判为「loaded without registering」而整机失败。
 */
export default defineConfig({
  entry: { client: 'src/web/client.ts' },
  format: 'cjs',
  platform: 'browser',
  outDir: 'dist',
  clean: false,
  dts: false,
  sourcemap: true,
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
