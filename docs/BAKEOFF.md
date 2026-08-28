# Bake-off 实证报告（v0.3）

> 本页汇总三轮有效性实证（方案书 1.6 节 DoD-10 / CR-32 / CR-33 / CR-37）。
> 纪律：失败与负向结果完整留存，不选择性过滤（D1）。
> 原始数据（reports/）不入库；本页为入库摘要，可由 scripts/ 复现。

## 1. 主对比：单 agent vs Pod 全链（DoD-10，10/10 留档）

条件：`baseline`（最强单员工独立完成）vs `pod`（claude 实现 + 独立 review 质量门 → 审批卡）。
5 任务 × 2 条件，同 prompt 管线、同编排器代码、每轮独立 worktree。模型 deepseek-v4-pro（claude 2.1.129）。

| 任务 | 条件 | 状态 | wall-clock | tokens | 备注 |
|---|---|---|---|---|---|
| small-1 | baseline | done | 194.3s | 67,827 | demo 无测试框架，not_run |
| small-1 | pod | done | 256.2s | 132,258 | 审查 pass → 审批卡 |
| small-2 | baseline | done | 308.3s | 89,988 | pass |
| small-2 | pod | done | 308.7s | 123,491 | 审查 pass → 审批卡 |
| medium-1 | baseline | done | 248.6s | 86,882 | pass |
| medium-1 | pod | done | **216.3s** | 150,839 | **Pod 更快 −13%** |
| medium-2 | baseline | done | 328.2s | 111,772 | pass |
| medium-2 | pod | done | 903.6s | 285,307 | Pod 显著更慢（+175%） |
| long-1 | baseline | done | 1054.3s | 241,807 | SQLite 实现+测试全绿 |
| long-1 | pod | ⚠️ needs_human | 1622.9s | 349,193 | 审查者缺 code-mode host，3 attempt 后转人工（负向样本，非代码缺陷） |

**结论（方向性，样本小）**：正确性 Pod 不劣于单 agent（4/5 审查 pass + 1 负向归因环境）；
tokens 全线更高（+37~155%，符合多 agent 协调开销预期）；wall-clock 仅 medium-1 更快。
「小任务不开 Pod，中长任务视审查价值选择」——详见 reports/bakeoff/SUMMARY.md（未入库）。

## 2. 跨 vendor 链（CR-33）

claude 实现 + **ark（火山方舟）独立 review** → 审批卡：61,004 tokens / 425.2s，
T-1、T-2 双 done，审查 pass，审批卡 A-1787820147620-980942 合并回主树（commit 93a41ad）。
证明编排层 vendor 无关：换审查者模型不改一行编排代码。

## 3. 写码任务记忆收益（CR-33 / CR-37 扩样本）

方法：同构任务对（A/B 换函数防记忆内容泄露），记忆组 prompt 注入项目风格经验
（util.ts 既有函数/测试约定/example.md/commit 规范），基线组无注入。
指标：done / wall-clock / tokens（claude headless 实测 usage）。每对内部同模型同环境配对比较。

### 批 1（deepseek-v4-pro 直连，4 对，2026-08-28）

| 对 | 记忆组 | 基线组 | wall（记忆 vs 基线） | Δwall | Δtokens | 胜者 |
|---|---|---|---|---|---|---|
| 1 | mod | pow | 168.9s vs 135.0s | **−33.9s** | −2883 | 基线（负向样本，如实保留） |
| 2 | min2 | max2 | 214.5s vs 239.7s | +25.2s | +2530 | 记忆 |
| 3 | gcd | lcm | 165.4s vs 177.5s | +12.1s | +8273 | 记忆 |
| 4 | absVal | floorInt | 205.2s vs 311.7s | **+106.5s** | +17311 | 记忆 |

**批 1 汇总**：wall 3/4 记忆组胜（avg +27.5s），tokens 3/4 胜（avg +6308）。
对 1 负向：mod/pow 过于平凡（基线组无记忆也秒答），记忆注入反而增加上下文负担——如实保留。
| 4 | absVal | floorInt | — | — | |

### 批 2+（GLM-5.3-Flash，ccswitch 中转；端点兼容性修复后）

| 对 | 记忆组 | 基线组 | wall（记忆 vs 基线） | Δwall | Δtokens | 胜者 |
|---|---|---|---|---|---|---|
| 5 | avg2 | mul2 | 61.9s vs 159.2s | **+97.3s** | +13857 | 记忆 |
| 6 | dist2 | maxAbs | 51.5s vs 69.2s | +17.7s | +2951 | 记忆 |

（批 3/4 跑完后回填对 7-9）

## 4. 复现

```bash
node scripts/bakeoff-claude.mjs            # 主对比
ARK_API_KEY=<key> node scripts/bakeoff-cross-vendor.mjs   # 跨 vendor
ME_START=0 ME_END=10 node scripts/memory-eval-code.mjs   # 记忆评测（分批）
node scripts/summarize-memory-eval.mjs     # 汇总
```
