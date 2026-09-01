/**
 * P2-4 自然语言压缩小实验（Acon 路线，待办 P2-4）。
 *
 * 范围（如实声明）：仅测「IM 出站摘要 / 产物叙事 / reflection 输入」这类**叙事性技术文本**
 * 的压缩可行性——代码 / diff / 数字 / 专有名词必须原样保留，不做任何代码压缩。
 *
 * 方法（复用 bakeoff 文化：先量化、无显著收益即停）：
 *   1) 样本：6 段真实项目文本快照（README 简介 / CR 变更叙事 / commit message /
 *      评估结论 / 排查结论 / IM 通道描述——正是出站摘要与 reflection 输入的典型形态）；
 *   2) 每样本两步调用 claude --print：
 *      a) 压缩：提示词只许保留 结论/实体/约束/决策，去修饰与重复，代码数字原样；
 *      b) 自评：给原文+压缩版，LLM 按 关键信息保持（数字/实体/决策/约束）打 1-10 分并列出丢失项；
 *   3) 判定：平均压缩率 ≥40% 且 平均保持分 ≥8/10 → 正向（值得接入 channel-im 出站摘要）；
 *      否则负向（记录结论并停，不做接入）。
 *
 * 用法（先 build）：node scripts/compress-eval.mjs
 *   ME_MODEL 指定模型；ME_MAX_BUDGET_USD 预算；ME_SAMPLES 截取前 N 段（默认全 6 段）。
 * 结果落 reports/compress-eval/{partial,summary}.json（gitignore，不入库）。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repairPath } from '../dist/workers/preflight.js'

repairPath()

const OUT_DIR = join(process.cwd(), 'reports', 'compress-eval')
mkdirSync(OUT_DIR, { recursive: true })

// ── 样本（内嵌快照防漂移；均来自仓库真实文本，非虚构）───────────────
const SAMPLES = [
  {
    id: 'readme-intro',
    label: 'README 项目简介',
    text:
      'dsh-pod（Pod 鲸群）：在 DSH Web UI 里一键组队、看得见、管得住的多智能体驾驶舱。' +
      '把本机已登录的 DSH / Claude Code / Codex 组成一个团队，各干各擅长的活、互相交接任务，' +
      '全程可视化，关键动作由人把关。驾驶舱是产品本体；多 agent 是按需启用的引擎。' +
      '默认 stdio transport（Claude Code claude mcp add 最易验证）；鉴权：stdio 由宿主导航拉起，进程边界即信任面。',
  },
  {
    id: 'cr52-summary',
    label: '方案书 CR-52 变更叙事',
    text:
      'P1-4 深化② reflection 冲突收口：新增 src/core/memory-conflict.ts（纯函数）——' +
      'bigramDice 相似度（CJK bigram + ASCII 词）+ conflictCandidates/resolveConflicts。' +
      '触发面：同 owner + 同 type（跨 type 互补事实归 supports，判冲突会误伤）+ 共享标签 ≥2 + 内容相似度 ∈ [0.4, 1)（≥1 是重复归合并 pass）。' +
      '收口：contradicts 边（旧→新）+ 旧记录 importance 降为 1 退出活跃注入位；保留记录/边/历史，不删除数据。' +
      '顺序约束：冲突 pass 先于 supports pass，否则同话题对先被 supports 边标记为已裁决，冲突收口永不触发。' +
      '单测 memory-conflict +8，全量 826 passed / 1 skipped。',
  },
  {
    id: 'commit-msg',
    label: '真实 commit message',
    text:
      'feat: P1-4 深化①——记忆检索升级 top-k BM25（相关性优先于重要度）。' +
      '新增 src/core/memory-rank.ts：ASCII 词 + CJK bigram 分词（无词典中文务实解）；' +
      'BM25 在候选池内算 IDF，tag 命中与 importance 作加权项而非硬门；' +
      '门槛=查询词重叠 / tag 命中 / importance≥4 任一（无信号不入选，池放大后替代旧 importance≥3 硬门并略升防噪声）。' +
      'orchestrator.injectRelevantMemory 候选池去 importance 硬门、扩到 MEMORY_CANDIDATE_POOL=32/owner。' +
      '效果：低重要度强相关的记忆越过旧硬门入选且排前。单测 memory-rank +8 + orchestrator 集成 +1。',
  },
  {
    id: 'memory-eval-conclusion',
    label: '记忆收益评估结论',
    text:
      '记忆收益验收（方案书 258 行）：scripts/memory-eval.mjs——同一任务集（项目特定经验）记忆组 vs 基线组 + LLM 自评三维。' +
      '真实 Ark 运行：三维均值记忆 4.667 vs 基线 4.000（+0.667，准确性 +1.00）；' +
      '负向记录：知识型问题平局——记忆价值在经验复用而非百科。' +
      '方法：同构任务对（A/B 换函数防记忆内容泄露），指标 done / wall-clock / tokens；每对内部同模型同环境配对比较。',
  },
  {
    id: 'flaky-conclusion',
    label: 'flaky 排查结论',
    text:
      'flaky 二轮结论（修正 08-31 误判）：git fixture 连并行争用都不是慢源——8 路并行（含 worktree add）' +
      '单 fixture 峰值 599ms，对 5s 阈值仍有 8× 余量；真慢源是 fs-browse 305-dir 测试的真实 mkdir×305' +
      '（全套并行下实测 5.2s / 8.1s 撞 5s testTimeout），已改为合成项名（61ms）。' +
      '残留：orchestrator 两个重试用例仍偶发，隔离 72/72 过，是 microtask/timer 在 16 worker 争用下的时序抖动——未调阈值。',
  },
  {
    id: 'channel-im',
    label: 'IM 通道服务面描述',
    text:
      '审计 P2 channel-im 服务面接线：新增 src/im-http.ts——POST /webhook/{slack,lark} 读原始 body' +
      '（验签依赖原始字节，不能先 JSON.parse）→ verifyAndParseIm（Slack HMAC-SHA256 / 飞书 sha256 加密或明文 verification token）' +
      '+ 时间窗防重放 + 事件 id 重放去重 + 挑战握手原样回显；指令路由走 channelTarget(channel) 审批不绕过状态机；' +
      '验签失败一律 401 fail-closed；body 超 64KB 413；非 loopback 无 token 拒绝启动。' +
      '出站无 bot token 时仅 stderr 打印 + ack（凭据永不出会话）。',
  },
]

const COMPRESS_PROMPT =
  '你是文本压缩器。压缩以下技术文本：\n' +
  '1) 只保留 结论、实体、约束、决策、数字、代码标识符；\n' +
  '2) 删除 修饰语、重复说明、寒暄、语气词；\n' +
  '3) 代码、diff、路径、版本号、ID 一律原样保留，禁止改写；\n' +
  '4) 输出只有压缩后的文本本身，不加任何解释或标题。\n\n原文：\n'

const EVAL_PROMPT =
  '你是信息保持评审。对比 原文 与 压缩版，评估压缩版是否保留全部关键信息。\n' +
  '关键信息 = 数字 / 实体 / 决策 / 约束 / 结论。\n' +
  '只输出一行 JSON：{"score": 1-10, "lost": ["丢失项1", ...]}，score 10=完全保留，' +
  '<7=有不可接受的信息丢失（即使压缩率高也算失败）。\n\n原文：\n'

const TASK_TIMEOUT_MS = 5 * 60_000

function spawnClaude(prompt, model) {
  return new Promise((resolve) => {
    const args = ['--print', '--max-turns', '2']
    if (model !== undefined && model.length > 0) args.push('--model', model)
    const child = spawn('claude', args, {
      cwd: process.cwd(),
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
    let buffer = ''
    const stderrTail = []
    child.stdout.on('data', (c) => { buffer += c.toString('utf8') })
    child.stderr.on('data', (c) => {
      for (const line of c.toString('utf8').split('\n')) {
        const t = line.trim()
        if (t.length > 0) {
          stderrTail.push(t)
          if (stderrTail.length > 12) stderrTail.splice(0, stderrTail.length - 12)
        }
      }
    })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ ok: false, error: 'timeout', text: '', stderr: stderrTail.join('\n') })
    }, TASK_TIMEOUT_MS)
    child.on('error', (err) => { clearTimeout(timer); finish({ ok: false, error: err.message, text: '', stderr: '' }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (!settled) finish({ ok: code === 0, error: code === 0 ? undefined : `exit ${code}`, text: buffer.trim(), stderr: stderrTail.join('\n') })
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

function parseEvalJson(text) {
  const m = text.match(/\{[\s\S]*\}/)
  if (m === null) return { score: 0, lost: ['eval 输出无法解析: ' + text.slice(0, 120)] }
  try {
    const j = JSON.parse(m[0])
    return { score: Number(j.score), lost: Array.isArray(j.lost) ? j.lost.map(String) : [] }
  } catch {
    return { score: 0, lost: ['eval JSON 解析失败: ' + text.slice(0, 120)] }
  }
}

async function main() {
  const model = (process.env.ME_MODEL ?? '').trim()
  const maxSamples = Number(process.env.ME_SAMPLES ?? SAMPLES.length)
  const samples = SAMPLES.slice(0, Math.max(1, maxSamples))
  const partial = []
  for (const s of samples) {
    process.stdout.write(`[compress-eval] ${s.id} (${s.label}) 压缩中…\n`)
    const compressed = await spawnClaude(COMPRESS_PROMPT + s.text, model)
    if (!compressed.ok) {
      partial.push({ ...s, compressed: null, error: compressed.error, stderr: compressed.stderr.slice(0, 200) })
      writeFileSync(join(OUT_DIR, 'partial.json'), JSON.stringify(partial, null, 2))
      continue
    }
    const ratio = 1 - compressed.text.length / s.text.length
    process.stdout.write(`  压缩率 ${(ratio * 100).toFixed(0)}% (${s.text.length}→${compressed.text.length} 字符)，自评中…\n`)
    const evalRes = await spawnClaude(`${EVAL_PROMPT}\n${s.text}\n\n---\n\n压缩版：\n${compressed.text}`, model)
    const judged = evalRes.ok ? parseEvalJson(evalRes.text) : { score: 0, lost: ['eval 调用失败: ' + (evalRes.error ?? '')] }
    partial.push({ id: s.id, label: s.label, origLen: s.text.length, compressedLen: compressed.text.length, ratio, score: judged.score, lost: judged.lost, compressed: compressed.text })
    writeFileSync(join(OUT_DIR, 'partial.json'), JSON.stringify(partial, null, 2))
  }
  const ok = partial.filter((p) => p.compressed !== null)
  const avgRatio = ok.reduce((a, p) => a + p.ratio, 0) / ok.length
  const avgScore = ok.reduce((a, p) => a + p.score, 0) / ok.length
  const verdict = avgRatio >= 0.4 && avgScore >= 8 ? '正向：值得接入 channel-im 出站摘要（IM 出站文本先压缩再投递）' : '负向：未达「压缩率≥40% 且 保持分≥8」双门槛，记录结论并停，不做接入'
  const summary = {
    ts: new Date().toISOString(),
    model: model.length > 0 ? model : 'claude 默认',
    samples: ok.length,
    avgCompressionRatio: Number(avgRatio.toFixed(3)),
    avgRetentionScore: Number(avgScore.toFixed(1)),
    verdict,
    boundary: '仅叙事性技术文本；代码/diff/数字不做压缩',
    rows: partial.map((p) => ({ id: p.id, label: p.label, ratio: p.ratio, score: p.score, lost: p.lost, error: p.error })),
  }
  writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(`\n[compress-eval] 平均压缩率 ${(avgRatio * 100).toFixed(0)}% · 平均保持分 ${avgScore.toFixed(1)}/10`)
  console.log('[compress-eval] 判定: ' + verdict)
  console.log('[compress-eval] summary:', join(OUT_DIR, 'summary.json'))
}

void main().catch((e) => { console.error('[compress-eval] fatal:', e); process.exit(1) })
