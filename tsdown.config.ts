import { defineConfig } from 'tsdown'

const id = 'dsh-pod'

/**
 * 三个打包入口（CR-38）：
 * 1. client —— DSH 宿主半：ModuleLoader 闭包工厂自注册（dist/client.js，由宿主以
 *    /plugins/<id>/client.js 提供）。banner/footer/intro 是加载器协议，不可动。
 * 2. standalone —— 独立控制台 UI 半：浏览器 ESM 全量打包（react/react-dom/scheduler
 *    内联，浏览器解析不了 bare import），产物 dist/standalone.js。
 * 3. standalone-server —— 独立服务端 bin：node ESM，dependencies 外置
 *    （better-sqlite3 原生模块不可打包），产物 dist/standalone-server.js（shebang 取自 cli.ts 首行）。
 *
 * 注：react/react-dom/scheduler 是 devDependencies，默认即内联进 UI bundle（浏览器解析不了 bare import）；
 * 生产 dependencies（better-sqlite3 等）默认外置给服务端 bundle。
 *
 * 宿主半（dist/plugin.js 及 core 依赖树）由 tsc 构建，不经过 tsdown。
 */
const client = defineConfig({
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

const standaloneUi = defineConfig({
  entry: { standalone: 'src/web/standalone.ts' },
  deps: { alwaysBundle: [/^react/, /^scheduler/] },
  format: 'esm',
  platform: 'browser',
  outDir: 'dist',
  clean: false,
  dts: false,
  sourcemap: true,
  outputOptions: { entryFileNames: 'standalone.js' },
})

// shebang 由 cli.ts 源文件首行携带，tsdown 自动保留（勿再加 banner，会 DUPLICATE_SHEBANG）
const standaloneServer = defineConfig({
  entry: { 'standalone-server': 'src/standalone/cli.ts' },
  format: 'esm',
  platform: 'node',
  outDir: 'dist',
  clean: false,
  dts: false,
  sourcemap: true,
  outputOptions: { entryFileNames: 'standalone-server.js' },
})

export default [client, standaloneUi, standaloneServer]