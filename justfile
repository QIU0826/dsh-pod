# DSH-Pod (鲸群) 常用命令入口（justfile）
# 用法：just verify / just demo / just bakeoff ...
# 需要先安装 just（https://github.com/casey/just）。

set shell := ["bash", "-c"]

# 全量校验：typecheck + 覆盖率测试 + 构建（发布候选门）
verify:
    npm run verify

# 类型检查（tsc --noEmit）
typecheck:
    npm run typecheck

# 跑全部单测
test:
    npm run test

# 覆盖率测试（发布候选门之一）
coverage:
    npm run test:coverage

# 单测 watch
test-watch:
    npm run test:watch

# 构建 dist/（tsc + tsdown）
build:
    npm run build

# 最小可演示链（真实 claude 实现 + codex 审查 → 审批卡；先 build）
demo:
    npm run build
    node scripts/demo-chain.mjs

# Bake-off 全量对拍（10 次运行，产出 reports/bakeoff）
bakeoff:
    node scripts/bakeoff-all.mjs

# 清理产物
clean:
    rm -rf dist coverage
