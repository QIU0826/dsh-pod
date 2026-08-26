# dsh-pod（Pod 鲸群）

> **在 DSH Web UI 里一键组队、看得见、管得住的多智能体驾驶舱。**
> 把本机已登录的 DSH / Claude Code / Codex 组成一个团队，各干各擅长的活、互相交接任务，
> 全程可视化，关键动作由人把关。驾驶舱是产品本体；多 agent 是按需启用的引擎。

开工基线：[DSH-Pod-项目方案书-v2.0.md](../../DSH-Pod-项目方案书-v2.0.md)（含 CR-01 设计变更记录）

## 当前状态（v0.1.0 MVP 发布候选）

| 切片 | 状态 | 产物 |
|---|---|---|
| W0 仓库骨架 + 插件注册 + Store 决策（JSON 原子写回退） | ✅ | 本仓库；`/api/dsh-pod/ping` 健康路由 |
| W1 WorkerBackend 抽象 + codex 验证 + claude 打通 | ✅ 全链路 | `src/workers/claude-headless.ts` / `codex-headless.ts`；双后端跨进程会话连续性实证；claude stream-json/报告/故障分类；CR-02 见方案书 |
| W2 交接协议 + 状态机 + Verifier + **Commander 编排器 + 最小可演示链** | ✅ | `src/core/orchestrator.ts`；`scripts/demo-chain.mjs` 真实跑通「claude 实现 → codex 独立 review → 审批卡」（CR-03-6） |
| W3 Team Builder / W4 Canvas 两栏 / W5 审批+worktree+账本 / W6 Bake-off+DoD | ✅ | Team Builder 预设阵型（DoD-9）+ Mission Canvas 两栏（看板/事件流/steer/审批/手动模式）+ apply_patch 串行合并 + 账本双列 + **DoD 1–19 全部达成**（见 docs/DoD-1-14-核对表.md + 差距审计-vs-方案书.md） |
| Bake-off（DoD-10） | ✅ 已发布 | 10/10 运行留档；[汇总报告](reports/bakeoff/SUMMARY.md)（9 done + 1 负向样本，含负向结果公开） |

> 环境注意（CR-02/03）：claude 已切至 api.deepseek.com/anthropic + deepseek-v4-pro；本机 codex = ChatGPT 桌面应用内置（模型名留空走默认 gpt-5.6-sol；缺 code-mode host → 审查任务走宿主机 diff 注入）。多模型配置采用 ccswitch 共存方案（进程级 env 覆盖，不改全局 settings.json）。

## 安装与挂载（沿 dsh-ssh 实证模式，零源码改动）

```bash
# 依赖 DSH rc 线（npm 官方 SDK 包，只走公开扩展点）
npm install && npm run verify

# 挂载到你的 profile（link 或 npm 包均可）
dsh plugin --profile web add link:<本仓库路径>
```

## 开发

```bash
npm test            # 全量单测（vitest，无真实 CLI/网络依赖）
npm run test:coverage  # 覆盖率门禁（lines/functions/statements 80%，branches 75%）
npm run typecheck   # tsc 严格模式
npm run build       # tsc（宿主 dist/plugin.js）+ tsdown（浏览器 dist/client.js）
npm run verify      # typecheck → coverage → build 一条龙
$env:POD_LIVE_PREFLIGHT='1'; npx vitest run tests/preflight.live.test.ts  # 真实 CLI 冒烟（可选）
```

## 最小可演示链（demo-chain）

```bash
npm run build
node scripts/demo-chain.mjs                # 审查者默认 codex（跨厂商异构）
node scripts/demo-chain.mjs --reviewer claude   # 同厂商异槽独立 review（DoD-5 仍满足：S-1 ≠ S-2）
node scripts/demo-chain.mjs --repo <dir>   # 自定义靶场仓库
```

⚠️ `--reviewer` 仅支持 `claude|codex`，传入其他值会警告并回落为 `codex`。
真实跑通「实现 → 独立 review → 审批卡」链；合并（apply_patch）属 W5 切片，本演示止于审批卡。

## v0.2 切片（灰度项经 `~/.dsh/pod/experiments.json` 开关，默认全关；非灰度项默认生效）

| 切片 | 状态 | 说明 |
|---|---|---|
| 审批模式 2/3 经 experiments 灰度接入（Berd-E） | ✅ | `launch approvalMode` 校验：模式 2（交接确认，跨 agent 派活前弹卡）/ 模式 3（全自动，质量门通过即 done）需对应 `approval-mode-2`/`approval-mode-3` 开关开启；默认模式 1 行为不变；dispatch 卡经 `pod_approve` 分支裁决 |
| 记忆子系统 2.8.1（CR-07 / NOOA 借鉴） | ✅ | `src/core/memory.ts`：MemoryStore（`~/.dsh/pod/memory.json` 原子写）+ 类型化图谱（supports/contradicts/derived-from）+ 三工具 `pod_mem_write/query/correct` + 后台 reflection（合并/补边/剪枝，接入 maintenanceTick） |
| Ledger→路由权重（历史成功率，2.7 节） | ✅ | `dispatcher.routeTask` 增 `slotSuccess` 因子：能力 > 负载 > 单任务成本 > 历史成功率（降序），无数据视为中性 0.5 不劣化；orchestrator 按槽位统计 done/(done+blocked+escalated) 注入 |
| 并行执行强化（双路+，4.3） | ✅ | `LaunchInput.parallel`（默认 2，clamp 1-8，pod_launch 可传）+ `run()` 用 `dispatchBatch` 每轮填满 maxParallel 而非单路派 1 即等；依赖链仍串行不破坏拓扑；FakeBackend 增 delayMs/并发峰值验证 peakActive |
| 任务中途换人正式化（4.3） | ✅ | `reassignTask`（kill 旧进程 + 交接四件套落盘 + 事件 task_reassigned 审计 + owner 转移 + 置 ready 由 dispatchBatch 重派）；`pod_reassign` 工具；done 终态/目标槽位不可用拒绝 |
| mission 崩溃恢复 UI 完善（4.3） | ✅ | PodPanel 顶栏加「恢复/需人工动作」横幅：跨重启重建（DoD-11 审批卡）/ 模式 2 派发门待放行 / paused 暂停提示；dist/client.ts 重建 |

## 核心域层（src/core，全部纯逻辑 + 注入式副作用，可离线测试）

| 模块 | 职责 | 方案书落点 |
|---|---|---|
| `store.ts` | JSON + 原子写（tmp→bak→rename）+ 损坏恢复；SQLite 可替换接口 | 3.9/O12 |
| `task-machine.ts` | Task 状态机 + 故障分类全集 + 重试/退避/转人工；LLM 提议代码裁决 | 3.4 |
| `mission.ts` | Mission 状态机 + 质量门（独立 review 不可关）+ 跨重启恢复 | 3.4/DoD-5/11 |
| `approvals.ts` | 审批模式 1 持久化 + 超期 stale（CR-01-7） | 2.6 |
| `ledger.ts` | tokens 实测 + equiv_usd 标注估算（价目表版本号）+ 双熔断 | 2.7/D7 |
| `handoff.ts` | 交接四件套 + verify 清单 + 2×3 投递矩阵 | 2.5/3.2 |
| `verifier.ts` | 产物校验层（commit/parent/白名单/日志/叙事一致性），真实 git 集成测试 | 3.5/CR-01-3 |
| `dispatcher.ts` | 能力 > 负载 > 成本 路由 | 3.3 |
| `session-tiers.ts` | 三档会话生命周期 + 70% 重置摘要 | 3.2/CR-01-6 同源 |
| `watchdog.ts` | commander/任务空闲/墙钟，纯 tick 驱动，审批期挂起（CR-01-4） | 3.3/3.4 |
| `experiments.ts` | 灰度开关框架（~/.dsh/pod/experiments.json，默认关、fail-closed） | 3.4 Experiment/Berd-E |
| `memory.ts` | 长期记忆子系统（主动策展 + 图谱 + reflection） | 2.8.1/CR-07 |

`src/workers/`：preflight 环境探测（附录 D 十项，`.cmd` 包装器 shell 回退——Windows 专项）+ 进程注册表。
`src/charters/`：内置角色章程（数据不是代码，可被用户 `~/.dsh/pod/charters/` 覆盖）。

## 架构不变量（代码强制执行）

1. **LLM 提议，代码裁决**：状态迁移只走状态机入口，非法迁移抛 `INVALID_TRANSITION`；
2. **原始事件永不进 commander 上下文**：只进磁盘与 Canvas；
3. **审批/收集/合并只走三个代码入口**：`pod_approve` / `pod_collect` / `apply_patch`；
4. **员工进程是沙箱边界**：charter 约束 + `--allowedTools` 白名单 + 路径校验 hook，三道防线全开。

## 插件表面（v0.1 W0）

- 宿主：`src/plugin.ts` —— PodRuntime（Store/审批/账本）+ 系统提示播报 + `/api/dsh-pod/ping`；初始化失败只降级（503），绝不拖垮宿主（R6/R10）。
- 浏览器：`src/web/client.ts` —— locale 注册；Team Builder / Canvas 界面随 W3/W4 切片开放。
- `cordis.patch.yml`：bundle patch（`dsh.bundle.patch` manifest），`dsh plugin add` 一键挂载。

## Bake-off（DoD-10：有效性自证）

> 完整报告：[reports/bakeoff/SUMMARY.md](reports/bakeoff/SUMMARY.md)（10/10 运行原始数据 + 负向结果公开）
> 运行器：`scripts/bakeoff-all.mjs` / `bakeoff-run.mjs`；任务集：`tasks/bakeoff-tasks.json`

**一句话结论**：本批 5 任务 × 2 条件的实测数据**不支持「多 agent 无条件更强」**，支持 **cockpit-first** 定位——
小任务编排开销吞噬收益（成本 +37~95%）；medium-1 上 Pod 节省 13% wall-clock（成本 +74%）；
长任务（long-1）的独立 review 因本机 codex 审查者缺 code-mode host（命令执行不可用）转人工（负向样本，
见 NEGATIVE-FINDING-codex-code-mode-host.md）。「何时该用 Pod」的可执行阈值详见报告 §4。

## 许可证

MIT
