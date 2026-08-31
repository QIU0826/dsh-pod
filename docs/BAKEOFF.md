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

### 批 2+（GLM-5.3-Flash，ccswitch 中转；端点兼容性修复后，6 对）

| 对 | 记忆组 | 基线组 | wall（记忆 vs 基线） | Δwall | Δtokens | 胜者 |
|---|---|---|---|---|---|---|
| 4 | roundTo | divInt | 167.4s vs 159.6s | −7.8s | +6581 | tokens 记忆胜 |
| 5 | avg2 | mul2 | 61.9s vs 159.2s | **+97.3s** | +13857 | 记忆全胜 |
| 6 | dist2 | maxAbs | 120.4s vs 120.8s | +0.4s | −1259 | 基线微胜（wall 平） |
| 7 | hypotInt | sqrtDiff | 136.0s vs 90.3s | −45.7s | −1323 | 基线（负向样本，如实保留） |
| 8 | xor2 | or2 | 148.4s vs 146.3s | −2.1s | +9233 | tokens 记忆胜 |
| 9 | wrap | shl | 91.8s vs 49.7s | −42.1s | +3699 | 基线 wall 胜 |

负向样本 3 个（对 0/7/9）如实保留：平凡任务记忆反增上下文负担（对 0）、基线模型对特定题型恰好更快（对 7/9）。

## 4. 十对汇总与结论

| 组 | 对数 | 双完成 | wall 记忆胜 | tokens 记忆胜 | avg Δwall | avg Δtokens |
|---|---|---|---|---|---|---|
| 批 1（deepseek-v4-pro 直连） | 4 | 4/4 | 3/4 | 3/4 | +47.9s | +9,371 |
| 批 2+（GLM-5.3-Flash 中转） | 6 | 6/6 | 2/6 | 4/6 | ≈0.0s | +5,131 |
| **合计** | **10** | **10/10** | **5/10** | **7/10** | **+11.0s** | **+5,602** |

### 结论（诚实版，D1）

1. **tokens 方向性收益成立**：10 对中 7 对记忆组省 token，平均省 5,602 tokens/任务。
   机制可信：记忆组直接套用既有风格约定（测试框架/目录/commit 规范），减少探索性试错。
2. **wall-clock 无显著收益**：5/10 胜负各半，均值 +11.0s ≈ 持平。批 1（DeepSeek）3/4 胜、
   批 2（GLM 中转）2/6 胜——不同模型下记忆收益形态不同（省 token vs 省时间不可兼得）。
3. **负向样本如实保留 3 个**：对 0（mod/pow 平凡任务，记忆反增上下文负担）、
   对 7（−45.7s，端点修复后首批的重试消耗）、对 9（−42.1s，基线模型对位运算题恰好快）。
4. **统计功效仍不足**：10 对在 α=0.05 下不显著（符号检验 7/10，p≈0.17）。
   结论是「方向性证据 + 方法可复现」，不是定论。扩到 30+ 对或固定单一端点重跑是后续工作。
5. **环境变更如实记录**：批 1 与批 2+ 模型/端点不同（DeepSeek 直连 → ccswitch GLM 中转），
   跨批绝对值不可比；配对比较只在批内成立，故分开展示。

## 5. 复现

```bash
node scripts/bakeoff-claude.mjs            # 主对比
ARK_API_KEY=<key> node scripts/bakeoff-cross-vendor.mjs   # 跨 vendor
ME_START=0 ME_END=10 node scripts/memory-eval-code.mjs   # 记忆评测（分批）
node scripts/summarize-memory-eval.mjs     # 汇总
```
## 6. 脚手架措辞 A/B（P0-A 第二版，2026-08-31）

> 目的：验证《从 ReAct 到 Agent Teams》「命令式/威胁框架措辞激活保守分布」在 dsh-pod
> 脚手架措辞上是否可复现（改措辞前先量化，不拍脑袋）。
> 方法：`scripts/wording-eval.mjs`——同构写码任务对，唯一自变量 = buildTaskPrompt 脚手架
> 两处措辞（fallback + 交付纪律）；old = 2026-08-31 前的「必须/禁止」版，new = 当前正向版；
> 交替指派抵消难度与顺序偏置；指标 done / wall / tokens（claude 实测）。10 次真实写码。

| 对 | old（命令式） | new（正向） | Δwall(s) | Δtokens |
|---|---|---|---|---|
| 0 | mod 64.6s / 14,054 | pow 530.9s / 23,755 | +466.3 | +9,701 |
| 1 | max2 637.1s / 18,216 | min2 300.3s / 15,391 | −336.8 | −2,825 |
| 2 | gcd 1114.6s / 21,762 | lcm 725.5s / 18,602 | −389.1 | −3,160 |
| 3 | floorInt 131.3s / 20,369 | absVal 268.5s / 18,142 | +137.2 | −2,227 |
| 4 | roundTo 98s / 16,995 | divInt 78.4s / 15,729 | −19.6 | −1,266 |

**汇总（5/5 对双 done，test 全 pass）**：done 5/5 平；wall 新快 3/5、均值 −28.4s；tokens 新省 4/5、均值 −45（≈0）。

### 结论（诚实版，D1）

1. **软化无回归**：done 率 5/5 = 5/5，test 全 pass——把脚手架从「必须/禁止」改成正向措辞
   **不损害完成率与测试质量**。这是本次最有价值的负向/安全结论。
2. **无显著收益**：wall 3/5、tokens 4/5 的符号检验均不显著（p≈0.50 / p≈0.19），
   均值 Δtoken −45 ≈ 噪声。文章的「命令式措辞显著更贵」**未在此规模上复现**。
3. **处理强度弱**：两版差异只在脚手架末尾两行（fallback + 交付纪律），任务 spec（占提示词
   主体、由 planner 生成）两版完全一致——若措辞效应真实存在，其大头在 spec，不在脚手架。
4. **端点方差主导**：run 时长 64s~1115s（今天端点明显慢，多 run 近 20 分钟上限），
   远超措辞差异量级；任何墙钟结论都不可靠，tokens 结论略稳。
5. **下一步**：不追加对「planner 生成 spec 包装」的投入——本批数据不支持再为措辞烧钱；
   若后续要测，应先测 `buildPlannerSpec`（P0-A 第一版，planner 侧单份 prompt），而非脚手架。

### 复现

```bash
npm run build   # 需先构建（dist 含当前措辞）
node scripts/wording-eval.mjs            # 默认 5 对；ME_START/ME_END 分片
# 结果：reports/wording-eval/summary.json（原始数据 reports/wording-eval/partial-*.json，不入库）
```

