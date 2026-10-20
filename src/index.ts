/**
 * Public API of the sysml-ai library.
 *
 * The engine is deterministic and owns all model access. Agents only consume
 * tool contracts through a ToolRuntime, either in-process, over MCP, or inside
 * the supervisor.
 */
export { WorkspaceEngine } from './engine/engine.ts';
export { ModelTransaction, inTransaction } from './engine/transaction.ts';
export { WorkspaceStore } from './engine/store.ts';
export { ModelIndex, declarationRangeOf } from './engine/index.ts';
export type {
  CommitResult,
  CreateElementInput,
  EditableKind,
  ElementView,
  FileInfo,
  ModelSnapshotInfo,
  RenameElementInput,
  ReplaceOp,
  ValidationReport,
} from './engine/types.ts';

export { allTools, createToolRuntime, modelTools, ToolRuntime } from './tools/index.ts';
export type { ToolContext, ToolDefinition, ToolResult, ToolSchema, Capability } from './contracts/tool.ts';
export type { StructuredError, ErrorCode } from './contracts/errors.ts';
export { makeError, EngineError, toStructuredError } from './contracts/errors.ts';

export { runAgent } from './agent/loop.ts';
export type { AgentRunOptions, AgentRunResult, AgentBudget, ToolCallRecord } from './agent/loop.ts';
export { ROLES, roleFor } from './agent/roles.ts';
export type { AgentRole, AgentRoleName } from './agent/roles.ts';
export { MockProvider, OllamaProvider, listOllamaModels } from './agent/provider.ts';
export type { LlmProvider, ChatMessage, ToolCall } from './agent/provider.ts';
export { finishTool, finishInputSchema } from './agent/finish.ts';
export type { FinishPayload } from './agent/finish.ts';

export { Supervisor } from './orchestration/supervisor.ts';
export type { SupervisionPlan, SupervisionTask, SupervisionResult, TaskState } from './orchestration/supervisor.ts';
export { runPipeline } from './orchestration/pipeline.ts';
export type { PipelineOptions, PipelineResult } from './orchestration/pipeline.ts';
export { FileLockManager } from './orchestration/lock.ts';

export { TraceRecorder, redact } from './observability/trace.ts';
export { Metrics } from './observability/metrics.ts';
export type { MetricsData, MetricPoint, LatencyPoint } from './observability/metrics.ts';
export { renderPrometheus, startMetricsServer, pushToPushgateway, metricName } from './observability/prometheus.ts';
export type {
  MetricsServer,
  MetricsServerOptions,
  PrometheusOptions,
  PushgatewayOptions,
  PushResult,
} from './observability/prometheus.ts';

export { runEvaluation, loadScenarios } from './eval/runner.ts';
export type { EvalOptions, EvalReport, ScenarioResult } from './eval/runner.ts';
export type { Scenario } from './eval/scenario.ts';
