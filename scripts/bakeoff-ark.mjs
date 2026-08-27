/**
 * Bake-off Ark 条件运行器 —— 用火山方舟 Ark 后端跑完整 Pod 链到审批卡。
 *
 * 与 bakeoff-run.mjs 的区别：Ark 后端无工具执行能力（不能写文件/commit），
 * 因此本运行器用 **research 型任务**（产出研究报告，不写代码）：
 *   research 任务 → 独立 review（Ark 审查者基于注入的 spec/产物文本）→ 审批卡
 * verifier 对 research 类型不强制 commit_sha / files_changed（verifier.ts:91,103），
 * 因此 Ark 纯文本 report 能过质量门，完整编排链（DoD-5 独立 review + 审批）可验证。
 *
 * 用法（先 build）：
 *   node scripts/bakeoff-ark.mjs
 * 需要 ARK_API_KEY（或 ~/.claude/settings.json 的 ARK_API_KEY）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JsonStore } from '../dist/core/store.js'
import { MissionOrchestrator } from '../dist/core/orchestrator.js'
import { verifyTaskArtifacts, execGitClient } from '../dist/core/verifier.js'
import { ArkBackend } from '../dist/workers/ark-headless.js'
import { homedir } from 'node:os'
import { repairPath } from '../dist/workers/preflight.js'

repairPath()

const REPO = join(process.cwd(), "..", "pod-demo-repo");
if (!existsSync(join(REPO, ".git"))) {
  mkdirSync(REPO, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: REPO });
  execFileSync("git", ["config", "user.email", "pod-demo@local"], { cwd: REPO });
  execFileSync("git", ["config", "user.name", "pod-demo"], { cwd: REPO });
  writeFileSync(join(REPO, "README.md"), "# Pod Demo Repo\n");
  execFileSync("git", ["add", "-A"], { cwd: REPO });
  execFileSync("git", ["commit", "-m", "init"], { cwd: REPO });
}

function arkKey() {
  const env = process.env.ARK_API_KEY;
  if (env !== undefined && env.length > 0) return env;
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
    return settings.ARK_API_KEY ?? "";
  } catch { return "" }
}

// research 任务集（适合 Ark：文本报告，不需工具执行）
const TASKS = {
  "research-1": { title: "dispatcher 路由因子设计评审", spec: "分析 dispatcher 路由因子（能力>负载>成本>历史成功率）的取舍：为什么历史成功率放在最后？各因子缺数据时的中性默认值设计合理吗？给出 3 个改进建议。输出 MISSION_REPORT（status=done, task_type=research, summary 含分析结论）。" },
  "research-2": { title: "SQLite JSON 行 vs 列存储取舍", spec: "对比 SQLite JSON 行存储 vs 列存储：结合单机单用户小数据量场景（Pod 的 ~/.dsh/pod），分析事务保证、可审计性、迁移成本，给出结论。输出 MISSION_REPORT（status=done, task_type=research, summary 含结论）。" },
  "research-3": { title: "审批跨重启恢复设计评审", spec: "评审「审批卡持久化 + 跨重启重建」设计：为什么必须磁盘为唯一事实源？裁决幂等的关键不变式是什么？如果 approve 后主树合并失败该回滚到哪个状态？输出 MISSION_REPORT（status=done, task_type=research, summary 含结论）。" },
}

const startedAt = Date.now();
const reportsDir = join("reports", "bakeoff-ark");
mkdirSync(reportsDir, { recursive: true });

async function main() {
  const key = arkKey();
  if (key.length === 0) { console.error("[bakeoff-ark] ARK_API_KEY missing"); process.exit(2) }
  const ark = new ArkBackend({ apiKey: key, timeoutMs: 10 * 60 * 1000 });
  const det = await ark.detect();
  if (!det.authed) { console.error("[bakeoff-ark] ark auth failed:", det.error); process.exit(1) }
  console.log("[bakeoff-ark] ark authed");

  const results = [];
  for (const [taskId, task] of Object.entries(TASKS)) {
    const runId = taskId + "-ark-" + Date.now();
    const dataDir = join(reportsDir, "store-" + runId);
    mkdirSync(dataDir, { recursive: true });
    const store = new JsonStore({ rootDir: dataDir });
    store.open();
    const worktreePath = join(REPO, ".pod-worktrees", runId);
    execFileSync("git", ["-C", REPO, "worktree", "add", worktreePath, "-b", runId], { stdio: "pipe" });

    const orch = new MissionOrchestrator("M-BAKE-ARK", {
      store,
      backends: { ark },
      worktree: { async ensure() { return worktreePath } },
      verify: async (t, r) => {
        const result = await verifyTaskArtifacts({ git: execGitClient(), repoDir: worktreePath }, t, r);
        if (!result.ok) console.error("[bakeoff-ark-verify] FAIL", t.id, JSON.stringify(result.failures));
        return result;
      },
      diffProvider: async (t) => {
        const target = store.getTask((t.depends_on ?? [])[0] ?? "");
        return target ? "（research 任务产物为报告文本，diff 注入见 review spec）" : "（无）";
      },
    });

    try {
      orch.launch({
        name: "bakeoff-ark-" + runId,
        goal: task.spec,
        cwd: REPO,
        budgetUsd: 3,
        slots: [
          { id: "S-1", vendor: "ark", role: "researcher", capabilities: [], model: "deepseek-v4-flash" },
          { id: "S-2", vendor: "ark", role: "reviewer", capabilities: ["审查"], model: "deepseek-v4-flash" },
        ],
      });
      orch.createTasks([
        { id: "T-1", title: task.title, spec: task.spec, type: "research", skill_tags: [] },
        { id: "T-2", title: "独立 review " + task.title, spec: "审查 T-1 的研究报告：结论是否支持论据、是否遗漏关键权衡、是否有明显错误。输出 MISSION_REPORT（task_type=review, status=done, summary 含审查结论）。", type: "review", skill_tags: ["审查"], depends_on: ["T-1"] },
      ]);
      const summary = await orch.run();
      results.push({ task_id: taskId, status: summary.status, done: summary.doneTasks, escalated: summary.escalatedTasks, approvals: summary.pendingApprovals.length });
      console.log("[bakeoff-ark]", taskId, "->", summary.status, "done:", summary.doneTasks.join(","), "approvals:", summary.pendingApprovals.length);
      if (summary.pendingApprovals.length > 0) {
        const approval = store.getApproval(summary.pendingApprovals[0]);
        console.log("[bakeoff-ark] 审批卡:", approval ? approval.id + " " + approval.status : "?");
      }
    } catch (error) {
      results.push({ task_id: taskId, status: "failed", error: error instanceof Error ? error.message : String(error) });
      console.error("[bakeoff-ark]", taskId, "ERROR:", error instanceof Error ? error.message : error);
    } finally {
      store.close();
    }
  }

  const summary = { started_at: new Date(startedAt).toISOString(), backend: "ark(deepseek-v4-flash)", model: "deepseek-v4-flash", results, status: "done" };
  writeFileSync(join(reportsDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("[bakeoff-ark] written reports/bakeoff-ark/summary.json");
  console.log("[bakeoff-ark] SUMMARY", JSON.stringify(results, null, 2));
}

void main();
