# CSV 解析器 A/B 实验：dsh-pod 多 harness vs 单 harness

一次受控 A/B 实验，回答：**同一份 spec、同一个实现模型（claude），挂上多厂商独立审查门（codex+dsh），是否比单独用 claude 直接产出更正确、更划算？**

## 方法（对照公平性）

- **同一份密封 spec**：自包含、零依赖、`parseCSV(text, opts)` 的 CSV→JSON 严格校验解析器（引号/转义/CRLF/BOM/trim/skipEmptyLines/delimiter/错误抛错）。
- **同一实现模型**：两组都用 claude 实现，spec 逐字相同。
- **判题套件在实现前定稿**（spec-first）：18 个用例，放 `.csv-abi-oracle/run.mjs`（gitignored，实现者不可见）。实现前一次性修正 1 处期望（末尾换行按行终止符、不产生幽灵空记录，对齐 PapaParse），其后两组用同一份、皆未调整。
- **唯一变量 = 审查门**：
  - 组A SOLO：单 harness，无审查门，直接落地。
  - 组B POD：claude 实现 + codex 独立审 + dsh 独立审；任一道 no-pass 则返工，直至两审过或预算尽。
- 成本账本来自 dsh-pod 记账表（measured token）。

## 结果

| 组 | 审查门 | 判题 | 成本（token） |
|----|--------|------|-------|
| A SOLO | 无 | **18/18** | ~37k（首 attempt 即写对；加流程证据共 62k） |
| B POD v1 | codex 审 + dsh 审 | **16/18** | 546k（implement 71k + codex 审 475k；dsh 审未完成） |

组B 的 2 真缺陷（均经隐藏套件确认）：
1. `a\n""`（显式空引号字段）被判为空行抛错——应为 `[{a:''}]`。
2. `skipEmptyLines:false` 时内部空行被 tokenizer 静默丢弃——应保留。

**决定性发现：codex 独立审结论 PASS，却未抓住上述 2 个真缺陷**（26 探针验的是"实现者自洽"，而非判题 spec 意图）。审过 ≠ 正确。

## 结论

- 对**高明确度 spec**：单 claude 已写对全部 18 例；加 codex 审查门 = **0 正确性增益 + ~14.8× 成本（546k vs 37k）+ 反向低分**，性价比为负。
- **不能外推**到的场景：低明确度 / 大型 / 多文件任务——那里单模型更可能漏、独立审覆盖面可能更有价值。本实验不否定多 harness 的适用面，只证明"同一高明确 spec 上，审查门本次未增值"。
- **平台可靠性发现**：组B 的 dsh（DeepSeek）二审被指挥官**错派到已耗尽的 codex 槽位**（dsh 槽全程 0 token 卡死 12 分钟）；`pod_dispatch` 因任务标记 running 而 no-op、非破坏性 `pod_pause` 亦被守卫拦截。这是 dsh-pod 在 **review 派发路径上的一次异厂商槽位错配**，需修复/复现上报——与代码正确性无关，本身即一项平台缺陷。

## 局限（如实）

1. 单份 spec、单次实现 → 样本量小。
2. codex 审 475k token、26 探针，非敷衍；漏检反映"审查-规格核验"的真实有限性。
3. dsh 二审因平台卡死未跑成，"第二道异厂商审能否补回 correctness"**无从判定**。

## 目录

- `solo/parse.js` — 组A 产出（18/18，ESM export）
- `pod/parse.js` — 组B 产出（16/18，如实保留 + 2 缺陷标注）
- 判题套件已 gitignored，不在版本库内；数字见上表及 `.csv-abi-oracle/results/`（本地草稿）。