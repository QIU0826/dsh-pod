/**
 * WorkerBackend 抽象 —— 方案书 3.2 节统一接口。
 * 纯类型契约：dsh-subagent / claude-headless / codex-headless 三实现各守其面，
 * 上层（commander/dispatcher）只依赖本接口，CLI 漂移被 adapter 隔离（R1）。
 */
export type {
  Vendor,
  WorkerBackend,
  WorkerCompletion,
  WorkerExit,
  WorkerHandle,
  WorkerProgressEvent,
} from '../core/types.js'
