import type { z } from 'zod';
import { z as zod } from 'zod';
import type { StructuredError } from './errors.ts';

export type Capability = 'read' | 'write' | 'analyze' | 'eval';
export type SideEffect = 'none' | 'read' | 'write';

export interface ToolContract<Input, Output> {
  name: string;
  version: string;
  description: string;
  input: z.ZodType<Input>;
  output: z.ZodType<Output>;
  capabilities: Capability[];
  sideEffect: SideEffect;
  /** Hard wall-clock limit enforced by ToolRuntime. */
  timeoutMs: number;
  /** Safe to call twice with the same arguments. */
  idempotent: boolean;
  tags: string[];
  examples?: Array<{ input: unknown; note: string }>;
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  contract: ToolContract<Input, Output>;
  handler: (input: Input, context: ToolContext) => Promise<Output> | Output;
}

/** Erased tool type used by registries, MCP and providers. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

export interface ToolContext {
  engine: import('../engine/engine.ts').WorkspaceEngine;
  tracer: import('../observability/trace.ts').TraceRecorder;
  signal?: AbortSignal;
  capabilities: ReadonlySet<Capability>;
  actor: string;
  dryRun: boolean;
}

export interface ToolCallMeta {
  tool: string;
  version: string;
  durationMs: number;
  transactionId?: string;
  revision?: string;
}

export type ToolResult<T = unknown> =
  | { ok: true; data: T; meta: ToolCallMeta }
  | { ok: false; error: StructuredError; meta: ToolCallMeta };

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  sideEffect: SideEffect;
  capabilities: Capability[];
}

export function defineTool<Input, Output>(
  contract: Omit<ToolContract<Input, Output>, 'version' | 'tags'> & {
    version?: string;
    tags?: string[];
  },
  handler: ToolDefinition<Input, Output>['handler']
): ToolDefinition<Input, Output> {
  return {
    contract: { version: '1.0.0', tags: [], ...contract },
    handler,
  };
}

export function toolJsonSchema<Input, Output>(contract: ToolContract<Input, Output>): Record<string, unknown> {
  const schema = zod.toJSONSchema(contract.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export function toolSchema<Input, Output>(def: ToolDefinition<Input, Output>): ToolSchema {
  return {
    name: def.contract.name,
    description: def.contract.description,
    parameters: toolJsonSchema(def.contract),
    sideEffect: def.contract.sideEffect,
    capabilities: def.contract.capabilities,
  };
}
