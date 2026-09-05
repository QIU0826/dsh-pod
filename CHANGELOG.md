# Changelog

## v0.3.0-alpha.2（2026-09-06）

> 全面代码审查修复轮 + 真实链路验证 + 三个挂起切片 + 多角色桌宠 + 开放式厂商注册。
> 基线 v0.3.0-alpha.1 → 本版共 12 个提交；全量 1005 tests / verify 全绿 / CI 绿；
> 真实 LLM 链路（e2e-mini + demo-chain 跨厂商）复跑通过。

### 修复（26 处，全面审查轮 2026-09-05）

- **安全**：`/dispatch`、`/abort` 补 POST 方法检查（跨站 `<img>` 可静默触发真实派发/中止）；
  `/a2a` 统一端点 body 双读导致所有请求 422（Agent Card 主入口形同虚设）；
  IM 审批 id 截断导致「批准 A-…」永远找不到卡。
- **数据**：memory.json 崩溃窗口静默清零（.bak 自愈）；SQLite 首启迁移中途崩溃永久跳过；
  数据面损坏时静默开空库；账本与 mission 花费双写分歧（原子入账）。
- **编排**：slot 互斥漏 negotiating/accepted（并发派发打穿 per-slot worktree）；预算熔断
  并发 pause 崩溃；畸形 LLM 报告 TypeError；plan 分支不看 report.status；rejected 终态
  不触发重规划（死代码）；replan 计次/序号重启归零；POSIX 根 parent 语义（Linux CI 根因）。
- **worker**：claude 基线 HEAD 捕获时点错误（commit_sha 校正死代码）；CJK 跨 pipe 块
  U+FFFD 截断（StringDecoder + close 残尾冲刷）；RemoteBackend 卫星失联任务槽永久挂死；
  ProcessRegistry 接线（从 no-op 到真实进程治理）。
- **体验**：提问弹窗 mission 终态后不关闭（关闭判定改由服务端状态驱动：人工裁决/任务
  done/mission 终态均闭门）；fs-browse POSIX 根；cron history 无上限内存泄漏；
  IM 出站失败回复丢失；standalone /mcp 无兜底可崩进程。

### 新增

- **记忆向量召回**（P1-4 深化③）：可插拔 EmbeddingFunction（OpenAI 兼容）+ 本地
  hashEmbed 兜底 + rankMemoriesHybrid（BM25+cosine 池内归一混合；嵌入失败回落纯 BM25）。
  **Ollama 一键本地免费嵌入**：`POD_MEMORY_EMBEDDING=ollama`（nomic-embed-text，实测通过）。
- **AG-UI 映射层**：`/api/dsh-pod/events/stream?format=agui`——第三方 AG-UI 前端省适配。
- **多角色桌宠**：每个 harness 一只专属形象（claude→miku frames2d 逐帧、codex→ouo-neko
  sprite2d 图集、ark/opencode→whale-refined、dsh→内置鲸鱼娘；localStorage 换装；加载失败
  逐级回落）；交叉审查对峙编排（面对面+抖动+对峙气泡）；女仆工坊房间主题；
  `/pet-assets/` 同源资产面 + 脚本三件套（resolve/fetch/slice）+ 三视图生产规格文档。
- **开放式厂商注册**（harness 可扩展）：`registerVendor` 元数据面 + launch 校验开放化 +
  会话档位回退——接入 workbuddy/zcode 等新平台无需改核心（docs/harness-接入指南.md）。
- 卫星 A2A Agent Card 发现面（`/.well-known/agent-card`）。

### 文档

- docs/审查-2026-09-05.md（26 处审查修复全记录）
- docs/harness-接入指南.md（新平台接入路径与 DoD）
- docs/远程访问-设计.md（手机远程/配对/隧道设计基线，参照 dsh-remote-web-ui）
- docs/桌宠角色生产规格.md（三视图→帧动画生产口径）
- docs/satellite.md、docs/待办清单-2026-08-31.md 相应勾选与更新

### 环境修复

- 系统 PATH 注册表损坏（MAVEN_HOME 引号 + CATALINE 笔误）导致 npm/cmd 全体失效——
  备份后修复（影响本仓库开发环境，与代码无关但如实记录）。
