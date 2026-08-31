// P1-2 量化：重置阈值第二维「内容相似密度」——review 类（diff 密集）用更低阈值。
// Context Rot 论点：语义相似且相关度低的内容（diff 堆叠）会让模型提前退化，
// 纯 token 占比（70%）是容量视角不是质量视角。这里量化「达到质量拐点的注入占比」。

// 代理指标：contentDensity = 注入中的「相似干扰项」占比（diff 行 + 工具输出 / 总字符）。
// review 任务注入几乎全是 diff（相似干扰项密集）；implement 注入主要是 spec + 指令（异质）。
function contentDensity(spec, diffChars) {
  if (spec.length === 0) return 0
  const diffShare = diffChars / spec.length
  // 换算到 0-100 的密度分：diff 占 50% 即密度 50（经验映射，bakeoff 再校准）
  return Math.round(Math.min(diffShare * 100, 100))
}

// 构造两个典型派发样本
const samples = [
  {
    name: 'review（diff 密集）',
    spec: '## 审查输入\n审查对象：T-1\n规格：实现 rate limiter\n' + ('+func(){...}\n'.repeat(400)),
    diffChars: 40_000,
  },
  {
    name: 'implement（spec 主导）',
    spec: '## 团队宗旨\n- 优先可维护性\n## 任务简报\n实现 RFC-12 的 rate limiter 中间件，含单元测试。\n## 相关记忆\n- 上次用 token bucket 成功\n## 排队指令\n加一层缓存',
    diffChars: 0,
  },
]

console.log('=== P1-2 重置阈值第二维 量化 ===')
for (const s of samples) {
  const density = contentDensity(s.spec, s.diffChars)
  const threshold = density >= 60 ? 50 : 70 // 密度高 → 低阈值（review）；密度低 → 常规 70
  console.log(s.name + ':')
  console.log('  注入长度 ' + s.spec.length + ' chars，diff ' + s.diffChars + ' chars')
  console.log('  内容密度 ' + density + '（diff 占比）→ 建议阈值 ' + threshold + '%')
  console.log('')
}

// 敏感性：阈值扫描 50/60/70/80% 对「该不该提前重置」的判定差异
console.log('阈值扫描（review diff 密集场景）：')
const reviewDensity = contentDensity(samples[0].spec, samples[0].diffChars)
for (const t of [50, 60, 70, 80]) {
  const should = reviewDensity >= t
  console.log('  阈值 ' + t + '% → 触发提前重置：' + (should ? '是' : '否'))
}
console.log('')
console.log('结论判据:')
console.log('- review 任务 diff 占注入 ~80%+ → 内容密度高 → Context Rot 主张 50% 即动作')
console.log('- implement 任务 spec/指令异质 → 密度低 → 维持 70% 常规阈值（不误触）')
console.log('- 第二维是「按内容类型」而非「拍更低的全局阈值」：不牺牲 implement 的会话复用收益')
