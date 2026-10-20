import { z } from 'zod';
import { EngineError, makeError, toStructuredError } from '../contracts/errors.ts';
import type { StructuredError } from '../contracts/errors.ts';
import type {
  AnyToolDefinition,
  Capability,
  ToolCallMeta,
  ToolContext,
  ToolResult,
  ToolSchema,
} from '../contracts/tool.ts';
import { toolSchema } from '../contracts/tool.ts';
import type { Metrics } from '../observability/metrics.ts';

export interface ToolRuntimeOptions {
  capabilities?: Iterable<Capability>;
  metrics?: Metrics;
  defaultTimeoutMs?: number;
}

/**
 * Validates inputs and outputs, enforces capabilities and timeouts, converts
 * every exception into a structured error, and traces the call. Agents never
 * invoke tool handlers directly.
 */
export class ToolRuntime {
  private readonly tools = new Map<string, AnyToolDefinition>();
  private readonly context: Omit<ToolContext, 'capabilities'> & { capabilities?: Iterable<Capability> };
  private readonly options: ToolRuntimeOptions;
  private readonly granted: Set<Capability>;

  constructor(
    context: Omit<ToolContext, 'capabilities'> & { capabilities?: Iterable<Capability> },
    options: ToolRuntimeOptions = {}
  ) {
    this.context = context;
    this.options = options;
    this.granted = new Set(context.capabilities ?? options.capabilities ?? ['read']);
  }

  get workspaceEngine(): import('../engine/engine.ts').WorkspaceEngine {
    return this.context.engine;
  }

  register(...definitions: AnyToolDefinition[]): this {
    for (const def of definitions) {
      if (this.tools.has(def.contract.name)) {
        throw new Error(`Duplicate tool name: ${def.contract.name}`);
      }
      this.tools.set(def.contract.name, def);
    }
    return this;
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  capabilities(): Set<Capability> {
    return new Set(this.granted);
  }

  /** Tool schemas visible to an agent with the runtime capabilities. */
  schemas(): ToolSchema[] {
    const caps = this.capabilities();
    return [...this.tools.values()]
      .filter((def) => def.contract.capabilities.every((cap) => caps.has(cap)))
      .map((def) => toolSchema(def))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async call(name: string, rawInput: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const started = performance.now();
    const definition = this.tools.get(name);
    if (!definition) {
      return {
        ok: false,
        error: makeError('INVALID_INPUT', `Unknown tool: ${name}`, {
          details: { available: this.names() },
          suggestions: ['Use one of the tool names from the catalog'],
        }),
        meta: meta(name, '0', started),
      };
    }

    const span = this.context.tracer.startSpan(`tool.${name}`, { tool: name });
    const caps = this.capabilities();
    const missing = definition.contract.capabilities.filter((cap) => !caps.has(cap));
    if (missing.length > 0) {
      const error = makeError('CAPABILITY_DENIED', `Tool '${name}' requires capabilities: ${missing.join(', ')}`, {
        details: { tool: name, required: definition.contract.capabilities, granted: [...caps] },
        suggestions: ['Use a read-only tool or delegate the edit to an editor agent'],
      });
      this.finish(span, error, name);
      return { ok: false, error, meta: meta(name, definition.contract.version, started) };
    }

    if (signal?.aborted) {
      const error = makeError('CANCELLED', 'Tool call cancelled');
      this.finish(span, error, name);
      return { ok: false, error, meta: meta(name, definition.contract.version, started) };
    }

    const asObject =
      rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)
        : rawInput === undefined || rawInput === null
          ? {}
          : rawInput;
    const parsed = definition.contract.input.safeParse(asObject);
    if (!parsed.success) {
      const error = makeError('INVALID_INPUT', `Invalid input for tool '${name}'`, {
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
          })),
        },
        suggestions: ['Fix the arguments to match the tool JSON schema', 'Call the tool with omitted optional fields first'],
      });
      this.finish(span, error, name);
      return { ok: false, error, meta: meta(name, definition.contract.version, started) };
    }

    const timeoutMs = definition.contract.timeoutMs ?? this.options.defaultTimeoutMs ?? 30_000;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const ctx: ToolContext = {
      ...this.context,
      capabilities: caps,
      signal: controller.signal,
      actor: this.context.actor,
      dryRun: this.context.dryRun,
    };

    let timer: NodeJS.Timeout | undefined;
    let onCancel: (() => void) | undefined;
    // One timer aborts the handler signal and rejects the race. `cancelled`
    // makes parent cancellation (agent shutdown) distinct from a tool timeout.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(makeError('TOOL_TIMEOUT', `Tool '${name}' timed out after ${timeoutMs}ms`, {
          details: { tool: name, timeoutMs },
          suggestions: ['Reduce the scope of the request', 'Retry with a smaller limit'],
        }));
      }, timeoutMs);
      timer.unref?.();
    });
    const cancelled = new Promise<never>((_, reject) => {
      const abort = (): void =>
        reject(makeError('CANCELLED', `Tool '${name}' was cancelled before completion`, { details: { tool: name } }));
      onCancel = abort;
      if (signal?.aborted) {
        abort();
      } else {
        signal?.addEventListener('abort', abort, { once: true });
      }
    });

    try {
      this.context.tracer.event('tool.input', { tool: name, input: parsed.data }, 'debug');
      const data = await Promise.race([
        Promise.resolve(definition.handler(parsed.data, ctx)),
        timeout,
        cancelled,
      ]);
      const validated = definition.contract.output.safeParse(data);
      if (!validated.success) {
        const error = makeError('INTERNAL', `Tool '${name}' returned an invalid payload`, {
          details: {
            issues: validated.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        });
        this.finish(span, error, name);
        return { ok: false, error, meta: meta(name, definition.contract.version, started) };
      }

      const resultMeta = meta(name, definition.contract.version, started);
      const txId = extractString(data, 'transactionId');
      const revision = extractString(data, 'revision');
      if (txId) resultMeta.transactionId = txId;
      if (revision) resultMeta.revision = revision;

      this.context.tracer.event('tool.output', {
        tool: name,
        durationMs: resultMeta.durationMs,
        transactionId: txId,
        revision,
        output: validated.data,
      });
      span.end('ok', { tool: name, durationMs: resultMeta.durationMs, transactionId: txId, revision });
      this.options.metrics?.inc('tool_calls_total', 1, { tool: name, status: 'ok' });
      this.options.metrics?.observe('tool_duration_ms', resultMeta.durationMs, { tool: name });
      return { ok: true, data: validated.data, meta: resultMeta };
    } catch (thrown) {
      const error = normalizeToolError(thrown, name, timeoutMs, signal?.aborted === true);
      this.finish(span, error, name);
      return { ok: false, error, meta: meta(name, definition.contract.version, started) };
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (onCancel) signal?.removeEventListener('abort', onCancel);
    }
  }

  private finish(span: import('../observability/trace.ts').Span, error: StructuredError, tool: string): void {
    this.context.tracer.event('tool.error', { code: error.code, message: error.message, details: error.details }, 'warn');
    span.end('error', { code: error.code });
    this.options.metrics?.inc('tool_calls_total', 1, { tool, code: String(error.code), status: 'error' });
  }
}

function meta(tool: string, version: string, started: number): ToolCallMeta {
  return { tool, version, durationMs: Math.round((performance.now() - started) * 100) / 100 };
}

function extractString(data: unknown, key: string): string | undefined {
  if (data && typeof data === 'object' && key in data) {
    const value = (data as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function normalizeToolError(thrown: unknown, tool: string, timeoutMs: number, cancelled: boolean): StructuredError {
  if (thrown instanceof EngineError) {
    return thrown.error;
  }
  if (thrown instanceof z.ZodError) {
    return makeError('INVALID_INPUT', `Invalid input for tool '${tool}'`, {
      details: { issues: thrown.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
    });
  }
  if (thrown instanceof Error && thrown.name === 'AbortError') {
    if (cancelled) {
      return makeError('CANCELLED', `Tool '${tool}' was cancelled`, { details: { tool } });
    }
    return makeError('TOOL_TIMEOUT', `Tool '${tool}' exceeded its ${timeoutMs}ms budget`, {
      details: { tool, timeoutMs },
      suggestions: ['Reduce the scope of the request', 'Retry with a smaller limit'],
    });
  }
  const error = toStructuredError(thrown);
  return makeError(error.code, `Tool '${tool}' failed: ${error.message}`, {
    details: error.details,
    retryable: error.retryable,
  });
}
