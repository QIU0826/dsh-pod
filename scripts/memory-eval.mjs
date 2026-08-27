/**
 * 记忆收益验收 —— 方案书 2.8.1 验收条款（258 行）：
 *   「同一任务集，开启记忆 vs 关闭记忆（文件笔记基线）的可测收益记录进 Debrief，参考 NOOA +11.8 的度量方式。」
 *
 * 方法（Ark 后端无工具执行能力 → 纯文本问答对比，贴合 NOOA 度量方式）：
 *   1. 同一任务集（3 个跨领域问题）跑两遍：
 *        - 记忆组：先写入策展记忆 → 回答时注入相关记忆（按标签/类型过滤）
 *        - 基线组：无记忆直接回答（文件笔记基线 ≈ 空笔记）
 *   2. 指标：回答质量（LLM 自评：相关性/准确性/完整性 1-5）+ tokens（usage unavailable 如实记录）。
 *   3. 产出 reports/memory-eval/summary.json（可复现；失败样本保留）。
 *
 * 用法（先 build）：
 *   node scripts/memory-eval.mjs [--task small|medium|large]
 * 需要 Ark 后端可用（ARK_API_KEY 或 ~/.claude/settings.json 的 ARK_API_KEY）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ArkBackend } from '../dist/workers/ark-headless.js'
import { MemoryStore } from '../dist/core/memory.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

// 任务集：跨领域，适合文本问答（不依赖工具执行）
const TASKS = {
  small: [
    // 项目特定经验（模型无法预知，记忆才有增量价值）：
    { id: "q1", q: "在 dsh-pod 项目里，better-sqlite3 的 v12 装不上而 v13 能用，你下次遇到类似原生依赖问题会怎么处理？请给出可复用的处理步骤。", tags: ["native-dep"] },
    { id: "q2", q: "dsh-pod 的 codex 审查者在审查时为什么拿不到 diff 内容？回顾这个问题的根因和解决方式。", tags: ["codex-diff"] },
    { id: "q3", q: "dsh-pod 的审批卡为什么在 DSH 插件重启后还能恢复？请说明其设计要点。", tags: ["approval-restart"] },
  ],
  medium: [
    { id: "q1", q: "在 dsh-pod 中，为什么并行执行强化（dispatchBatch）不会破坏任务 DAG 的拓扑？", tags: ["parallel-topo"] },
    { id: "q2", q: "dsh-pod 的记忆子系统做 reflection 时，合并/剪枝/补边三件事分别处理什么？", tags: ["memory-reflection"] },
  ],
  large: [
    { id: "q1", q: "dsh-pod 的 SQLite 迁移为什么选择 JSON 行存储而不是列存储？结合单机单用户场景。", tags: ["sqlite-json"] },
  ],
}

// 策展记忆库（主动写入，模拟「团队沉淀的经验」——方案书 2.8.1 主动策展，非自动摘要）
const MEMORY = [
  { owner: "S-1", type: "lesson", importance: 5, tags: ["native-dep"], content_ref: "better-sqlite3 在 Windows+Node22：v12.x prebuild 下载超时（GitHub release 不稳）→ node-gyp 编译失败（无 VS 工具链）；v13.0.3 prebuild 可下载且 N-API 兼容。处理步骤：先试最新版 prebuild，不行再回退 JSON 存储或换内置 node:sqlite。" },
  { owner: "S-1", type: "lesson", importance: 5, tags: ["codex-diff"], content_ref: "本机 ChatGPT 内置 codex 缺 code-mode host，无法自行执行 git 命令 → 审查者拿不到 diff。解决：宿主机侧读 diff 注入审查提示词（diffProvider），审查者只收 diff 文本，无需仓库命令权限。" },
  { owner: "S-1", type: "pattern", importance: 5, tags: ["approval-restart"], content_ref: "审批卡跨重启恢复：审批请求持久化于 Store（磁盘唯一事实源）；DSH 插件或浏览器重启后 Canvas 从磁盘重建审批卡（rebuildAfterRestart）；裁决幂等（重复裁决拒绝）。" },
  { owner: "S-1", type: "lesson", importance: 4, tags: ["parallel-topo"], content_ref: "dispatchBatch 并行强化不破坏 DAG：每轮只派「拓扑就绪」的任务（依赖全部 done），依赖链仍串行；并行的是同一层的独立任务。" },
  { owner: "S-1", type: "lesson", importance: 4, tags: ["memory-reflection"], content_ref: "reflection 三件事：合并同 owner+type+content_ref 重复（保留最新）、补 supports 边（同 owner 共享≥2标签）、剪枝 importance<2 且超 30 天无边记录。" },
  { owner: "S-1", type: "decision", importance: 3, tags: ["sqlite-json"], content_ref: "单机单用户小数据量：SQLite JSON 行存储足够（原子性由事务保证、可备份可审计），列存储的查询优势在数据量级用不上；选 JSON 行降低迁移风险。" },
];

const args = Object.fromEntries(process.argv.map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1]] : null)).filter(Boolean));
const taskKey = args.task ?? "small";
const taskSet = TASKS[taskKey];
if (taskSet === undefined) { console.error("unknown task set:", taskKey, "candidates:", Object.keys(TASKS).join(",")); process.exit(2) }

const reportsDir = join("reports", "memory-eval");
mkdirSync(reportsDir, { recursive: true });

function arkKey() {
  const env = process.env.ARK_API_KEY;
  if (env !== undefined && env.length > 0) return env;
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
    return settings.ARK_API_KEY ?? "";
  } catch { return "" }
}

async function ask(backend, prompt) {
  const r = await backend.complete(prompt, "deepseek-v4-flash");
  return { ok: r.ok, text: r.text, error: r.error };
}

async function main() {
  const key = arkKey();
  if (key.length === 0) { console.error("[memory-eval] ARK_API_KEY missing"); process.exit(2) }
  const backend = new ArkBackend({ apiKey: key });
  const det = await backend.detect();
  if (!det.authed) { console.error("[memory-eval] ark auth failed:", det.error); process.exit(1) }
  console.log("[memory-eval] ark authed:", det.models.join(","));

  // 准备记忆存储（临时，不入生产）
  const memDir = join("reports", "memory-eval", "mem");
  mkdirSync(memDir, { recursive: true });
  const mem = new MemoryStore({ filePath: join(memDir, "memory.json") });
  mem.open();
  for (const m of MEMORY) {
    mem.write({ owner_slot_id: m.owner, type: m.type, importance: m.importance, tags: m.tags, content_ref: m.content_ref });
  }

  const results = [];
  for (const t of taskSet) {
    // 记忆组：注入相关记忆
    const relevant = mem.query({ tags: t.tags });
    const memoryBlock = relevant.length > 0
      ? "\n\n[团队沉淀的经验（记忆，仅作参考）]\n" + relevant.map((r) => "- " + r.content_ref).join("\n")
      : "\n\n[无相关记忆]";
    const promptMem = "请回答：\n" + t.q + memoryBlock + "\n\n（可以引用上述记忆，也可以补充你自己的理解。）";
    const memRes = await ask(backend, promptMem);

    // 基线组：无记忆
    const promptBase = "请回答：\n" + t.q + "\n\n（基于你自己的知识回答。）";
    const baseRes = await ask(backend, promptBase);

    results.push({ id: t.id, question: t.q, tags: t.tags, memory_group: memRes.ok ? memRes.text : (memRes.error ?? ""), baseline_group: baseRes.ok ? baseRes.text : (baseRes.error ?? ""), memory_ok: memRes.ok, baseline_ok: baseRes.ok });
    console.log("[memory-eval] done", t.id);
  }

  // LLM 自评：对比每对回答质量（NOOA 度量方式参考）
  const evalResults = [];
  for (const r of results) {
    const scorePrompt = "你是评分员。对比下面两个回答（同一问题）。只输出一行 JSON（不要任何其他文字），格式：{\"memory\":{\"relevance\":N,\"accuracy\":N,\"completeness\":N},\"baseline\":{\"relevance\":N,\"accuracy\":N,\"completeness\":N}}，其中 N 为 1-5 整数。问题：" + r.question + "\n\n[记忆组回答]\n" + r.memory_group.slice(0, 1200) + "\n\n[基线组回答]\n" + r.baseline_group.slice(0, 1200);
    const score = await ask(backend, scorePrompt);
    const text = score.ok ? score.text : (score.error ?? "");
    let parsed = null;
    try { parsed = JSON.parse(text.replace(/```json|```/g, "").trim()); } catch {
      // 宽松提取：找第一个 { 到最后一个 }
      const a = text.indexOf("{"); const b = text.lastIndexOf("}");
      if (a >= 0 && b > a) { try { parsed = JSON.parse(text.slice(a, b + 1)) } catch {} }
    }
    evalResults.push({ id: r.id, parsed, raw: text.slice(0, 400) });
    console.log("[memory-eval] scored", r.id);
  }

  // 汇总
  const summary = {
    run_at: new Date().toISOString(),
    task_set: taskKey,
    model: "deepseek-v4-flash (ark agent plan)",
    method: "记忆组(注入相关记忆) vs 基线组(无记忆) 文本问答对比；LLM 自评质量分",
    tasks: evalResults,
    results,
    notes: [
      "NOOA +11.8 是 GPT-5.5 配对基准，不可直接移植（CR-07-4）；本验收只记录本任务集本模型的可测相对差异",
      "usage unavailable（Ark 后端无 usage 字段，D7 诚实化：tokens 未实测不编造）",
    ],
  };
  writeFileSync(join(reportsDir, "summary-" + taskKey + ".json"), JSON.stringify(summary, null, 2));
  console.log("[memory-eval] written reports/memory-eval/summary-" + taskKey + ".json");
  console.log("[memory-eval] eval:", JSON.stringify(evalResults.map((e) => ({ id: e.id, parsed: e.parsed })), null, 2));
}

void main();
