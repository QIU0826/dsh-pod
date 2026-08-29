# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

开发者 / 技术负责人（单机单人为主）：在本机用已登录的 Claude Code / Codex 等 CLI 组成多智能体团队执行仓库任务，需要在浏览器里随时看进度、等审批、必要时介入。[推断自仓库 README 与本会话使用场景；未做正式访谈]

## Product Purpose

dsh-pod（Pod 鲸群）是多智能体驾驶舱：用户给一个目标，planner 分解任务 DAG，多个 CLI agent 并行执行、交叉审查、经审批卡合并回主树。成功 = 任务可验收完成、全程可视化、关键动作人把关、预算受控。

## Positioning

cockpit-first：驾驶舱是产品本体，多 agent 是按需启用的引擎；「LLM 提议、代码裁决」的状态机纪律 + 全量事件审计是同类产品不具备的组合。

## Operating Context

- 独立控制台（standalone Web，默认 127.0.0.1:3930）与 DSH 插件两种形态共用同一 React 面板
- 长时间运行的任务流：用户会长时间挂着页面观察、偶尔操作（批准/驳回/steer/暂停）
- 数据面：任务看板（六状态）、员工状态灯、DAG 拓扑、事件流、审批卡、账本（tokens/美元）

## Capabilities and Constraints

- 现有功能必须保留：Team Builder 表单（预设阵型）、任务看板、拓扑视图、事件流、审批操作、steer、暂停/恢复/中止、账本
- 技术栈：React + createElement（无 JSX/无 CSS 框架），样式经注入式 CSS 字符串，同时服务 standalone 壳与 DSH 宿主
- 界面语言：中文

## Brand Commitments

产品名「Pod 鲸群」，深色任务控制台方向（用户 2026-08-29 选定）。

## Evidence on Hand

仓库源码 + 实际运行的服务（本会话）；无真实运行中的 mission 截图数据，演示数据须标注合成。

## Product Principles

1. 状态即界面：任何时刻扫一眼就知道「谁在干什么、卡在哪、等我什么」
2. 操作可预期：审批/中止等高危动作永远有确认与留痕
3. 数据诚实：故障、转人工、预算告警如实呈现，不静默
4. 密度服务任务：信息密度高但不喧哗，装饰让位状态

## Accessibility & Inclusion

深色主题下正文对比度 ≥4.5:1；键盘可操作（focus ring 可见）。
