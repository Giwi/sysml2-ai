import { ToolRuntime } from './runtime.ts';
import type { AnyToolDefinition, Capability } from '../contracts/tool.ts';
import type { WorkspaceEngine } from '../engine/engine.ts';
import type { TraceRecorder } from '../observability/trace.ts';
import type { Metrics } from '../observability/metrics.ts';
import {
  createElementTool,
  createFileTool,
  deleteElementTool,
  editTool,
  findReferencesTool,
  getElementTool,
  getSourceTool,
  listElementsTool,
  listFilesTool,
  renameElementTool,
  validateTool,
} from './model-tools.ts';
import { analysisTools } from './analysis-tools.ts';

export const modelTools = [
  listFilesTool,
  listElementsTool,
  getElementTool,
  getSourceTool,
  validateTool,
  findReferencesTool,
  createElementTool,
  createFileTool,
  renameElementTool,
  deleteElementTool,
  editTool,
];

export const allTools: AnyToolDefinition[] = [...modelTools, ...analysisTools];

export interface RuntimeOptions {
  actor: string;
  tracer: TraceRecorder;
  capabilities?: Capability[];
  dryRun?: boolean;
  metrics?: Metrics;
  signal?: AbortSignal;
}

export function createToolRuntime(engine: WorkspaceEngine, options: RuntimeOptions): ToolRuntime {
  const runtime = new ToolRuntime(
    {
      engine,
      tracer: options.tracer,
      actor: options.actor,
      dryRun: options.dryRun ?? false,
      signal: options.signal,
    },
    {
      capabilities: options.capabilities ?? ['read'],
      metrics: options.metrics,
    }
  );
  runtime.register(...allTools);
  return runtime;
}

export { ToolRuntime };
