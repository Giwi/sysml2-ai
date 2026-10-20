import { randomUUID } from 'node:crypto';
import { fail, makeError, toStructuredError } from '../contracts/errors.ts';
import type { StructuredError } from '../contracts/errors.ts';
import { toolSchema } from '../contracts/tool.ts';
import type { ToolRuntime } from '../tools/runtime.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { TraceRecorder } from '../observability/trace.ts';
import { finishInputSchema, finishTool } from './finish.ts';
import type { FinishPayload } from './finish.ts';
import type { ChatMessage, LlmProvider, LlmUsage, ToolCall } from './provider.ts';
import { roleFor } from './roles.ts';
import type { AgentRoleName } from './roles.ts';

export interface AgentBudget {
  maxSteps: number;
  maxToolCalls: number;
  maxWallClockMs: number;
  maxTokens: number;
}

export interface ToolCallRecord {
  step: number;
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  errorCode?: string;
  transactionId?: string;
  revision?: string;
}

export interface AgentRunOptions {
  role: AgentRoleName;
  goal: string;
  provider: LlmProvider;
  runtime: ToolRuntime;
  tracer: TraceRecorder;
  budget?: Partial<AgentBudget>;
  signal?: AbortSignal;
  metrics?: Metrics;
  /** Extra context appended to the user message (files, acceptance criteria, ...). */
  context?: string;
  maxToolResultChars?: number;
  maxMessages?: number;
  hooks?: {
    onStep?: (step: number, message: ChatMessage) => void;
    onToolCall?: (record: ToolCallRecord) => void;
  };
}

export type AgentStatus = 'completed' | 'budget_exceeded' | 'error' | 'cancelled';

export interface AgentRunResult {
  runId: string;
  traceId: string;
  role: AgentRoleName;
  goal: string;
  status: AgentStatus;
  summary: string;
  finish?: FinishPayload;
  steps: number;
  toolCalls: ToolCallRecord[];
  usage: LlmUsage;
  durationMs: number;
  revisionBefore: string;
  revisionAfter: string;
  error?: StructuredError;
  provider: string;
  model: string;
  startedAt: string;
  endedAt: string;
}

/**
 * The agentic loop: model call, typed tool execution, observation, repeat.
 * Budgets and cancellation are checked before every expensive step. Tool
 * failures are fed back to the model as structured observations, enabling
 * self-repair without crashing the run.
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const role = roleFor(options.role);
  const budget: AgentBudget = { ...role.budget, ...options.budget };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const runId = `agent_${randomUUID().slice(0, 10)}`;
  const engine = options.runtime.workspaceEngine;
  const revisionBefore = engine.index().revision;
  const tracer = options.tracer;
  const span = tracer.startSpan('agent.run', {
    role: role.name,
    goal: options.goal,
    provider: options.provider.id,
    model: options.provider.model,
    budget,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: role.systemPrompt },
    {
      role: 'user',
      content: `${options.goal}${options.context ? `\n\nCONTEXT\n${options.context}` : ''}`,
    },
  ];

  const toolCalls: ToolCallRecord[] = [];
  const usage: LlmUsage = { promptTokens: 0, completionTokens: 0 };
  let finish: FinishPayload | undefined;
  let status: AgentStatus = 'completed';
  let error: StructuredError | undefined;
  let steps = 0;
  let finalText = '';
  const deadline = Date.now() + budget.maxWallClockMs;
  // Tool contracts are immutable for the whole run: build the provider schema
  // once instead of regenerating JSON Schema before every LLM call.
  const toolSchemas = [...options.runtime.schemas(), toolSchema(finishTool)];

  tracer.event('agent.start', { role: role.name, goal: options.goal, budget });

  try {
    while (steps < budget.maxSteps) {
      if (options.signal?.aborted) {
        status = 'cancelled';
        error = makeError('CANCELLED', 'Agent run cancelled');
        break;
      }
      if (Date.now() >= deadline) {
        status = 'budget_exceeded';
        error = makeError('BUDGET_EXCEEDED', `Wall-clock budget of ${budget.maxWallClockMs}ms exceeded`, {
          details: { budget },
        });
        break;
      }
      if (usage.promptTokens + usage.completionTokens >= budget.maxTokens) {
        status = 'budget_exceeded';
        error = makeError('BUDGET_EXCEEDED', `Token budget of ${budget.maxTokens} exceeded`, {
          details: { usage, budget },
        });
        break;
      }

      steps += 1;
      const stepSpan = span.child(`agent.step.${steps}`, { step: steps });
      const providerResult = await callProvider(options, messages, toolSchemas, budget, stepSpan);
      usage.promptTokens += providerResult.usage.promptTokens;
      usage.completionTokens += providerResult.usage.completionTokens;
      const assistant = providerResult.message;
      messages.push(assistant);
      finalText = assistant.content || finalText;
      stepSpan.event('agent.message', {
        content: assistant.content,
        toolCalls: assistant.toolCalls?.map((call) => ({ name: call.name, arguments: call.arguments })),
      });
      options.hooks?.onStep?.(steps, assistant);

      if (!assistant.toolCalls?.length) {
        stepSpan.end('ok', { finishReason: providerResult.finishReason ?? 'stop', noToolCall: true });
        break;
      }

      for (const call of assistant.toolCalls) {
        if (options.signal?.aborted) {
          status = 'cancelled';
          error = makeError('CANCELLED', 'Agent run cancelled');
          break;
        }

        if (call.name === finishTool.contract.name) {
          const parsed = finishInputSchema.safeParse(call.arguments ?? {});
          if (!parsed.success) {
            const structured = makeError('INVALID_INPUT', 'Invalid agent.finish payload', {
              details: {
                issues: parsed.error.issues.map((issue) => ({
                  path: issue.path.join('.'),
                  message: issue.message,
                })),
              },
              suggestions: ['Provide summary, and for evaluators a verdict'],
            });
            appendToolResult(messages, call, { ok: false, error: structured });
            toolCalls.push({
              step: steps,
              name: call.name,
              arguments: call.arguments ?? {},
              ok: false,
              durationMs: 0,
              errorCode: structured.code,
            });
            stepSpan.event('agent.finish_rejected', { error: structured }, 'warn');
            continue;
          }
          finish = parsed.data;
          toolCalls.push({
            step: steps,
            name: call.name,
            arguments: call.arguments ?? {},
            ok: true,
            durationMs: 0,
          });
          stepSpan.end('ok', { finished: true });
          break;
        }

        if (toolCalls.length >= budget.maxToolCalls) {
          status = 'budget_exceeded';
          error = makeError('BUDGET_EXCEEDED', `Tool-call budget of ${budget.maxToolCalls} exceeded`, {
            details: { used: toolCalls.length, budget },
          });
          break;
        }

        const { record, observation } = await executeTool(
          call,
          steps,
          options,
          span,
          options.maxToolResultChars ?? 12_000
        );
        toolCalls.push(record);
        options.hooks?.onToolCall?.(record);
        messages.push({
          role: 'tool',
          toolName: call.name,
          toolCallId: call.id,
          content: observation,
        });
      }

      stepSpan.end(status === 'budget_exceeded' || status === 'cancelled' ? 'error' : 'ok');
      if (finish) {
        break;
      }
      if (status !== 'completed') {
        break;
      }
    }

    if (!finish && status === 'completed') {
      if (steps >= budget.maxSteps) {
        status = 'budget_exceeded';
        error = makeError('BUDGET_EXCEEDED', `Step budget of ${budget.maxSteps} exceeded`, { details: { budget } });
      } else {
        tracer.event('agent.finished_without_tool', { steps }, 'warn');
      }
    }
  } catch (thrown) {
    const structured = toStructuredError(thrown, 'PROVIDER_ERROR');
    if (structured.code === 'PROVIDER_ERROR' || structured.category === 'provider') {
      error = makeError('PROVIDER_ERROR', structured.message, {
        details: structured.details,
        retryable: structured.retryable,
        suggestions: [
          'Check that Ollama is running and the model supports tool calling',
          'Inspect the provider error details and retry the run',
        ],
      });
    } else {
      error = structured;
    }
    status = options.signal?.aborted ? 'cancelled' : 'error';
  }

  const revisionAfter = engine.index().revision;
  const endedAt = new Date().toISOString();
  const durationMs = Math.round(performance.now() - started);
  const summary = finish?.summary ?? finalText ?? '';
  const result: AgentRunResult = {
    runId,
    traceId: tracer.traceId,
    role: role.name,
    goal: options.goal,
    status,
    summary,
    ...(finish ? { finish } : {}),
    steps,
    toolCalls,
    usage,
    durationMs,
    revisionBefore,
    revisionAfter,
    ...(error ? { error } : {}),
    provider: options.provider.id,
    model: options.provider.model,
    startedAt,
    endedAt,
  };

  tracer.event('agent.end', {
    status,
    steps,
    toolCalls: toolCalls.length,
    usage,
    durationMs,
    revisionBefore,
    revisionAfter,
    ...(error ? { error } : {}),
  });
  options.metrics?.inc('agent_runs_total', 1, { role: role.name, status });
  options.metrics?.observe('agent_duration_ms', durationMs, { role: role.name });
  if (status === 'error' || status === 'cancelled' || status === 'budget_exceeded') {
    span.end('error', { status, code: error?.code });
  } else {
    span.end('ok', { status });
  }
  return result;
}

async function callProvider(
  options: AgentRunOptions,
  messages: ChatMessage[],
  tools: import('../contracts/tool.ts').ToolSchema[],
  budget: AgentBudget,
  span: import('../observability/trace.ts').Span
): Promise<Awaited<ReturnType<LlmProvider['chat']>>> {
  const trimmed = trimMessages(messages, options.maxMessages ?? 80);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      span.event('llm.request', { attempt, messages: trimmed.length, tools: tools.length });
      const response = await options.provider.chat(trimmed, tools, {
        signal: options.signal,
        maxTokens: budget.maxTokens,
      });
      span.event('llm.response', {
        attempt,
        content: response.message.content,
        toolCalls: response.message.toolCalls?.length ?? 0,
        usage: response.usage,
        finishReason: response.finishReason,
      });
      options.metrics?.inc('llm_calls_total', 1, { provider: options.provider.id, status: 'ok' });
      return response;
    } catch (error) {
      lastError = error;
      const retryable = (error as { retryable?: boolean }).retryable === true || isNetworkError(error);
      span.event(
        'llm.error',
        { attempt, message: error instanceof Error ? error.message : String(error), retryable },
        'warn'
      );
      options.metrics?.inc('llm_calls_total', 1, { provider: options.provider.id, status: 'error' });
      if (!retryable || attempt === 3 || options.signal?.aborted) {
        break;
      }
      await sleep(500 * attempt);
    }
  }
  const structured = toStructuredError(lastError, 'PROVIDER_ERROR');
  fail('PROVIDER_ERROR', structured.message, {
    details: structured.details,
    retryable: true,
  });
}

async function executeTool(
  call: ToolCall,
  step: number,
  options: AgentRunOptions,
  parentSpan: import('../observability/trace.ts').Span,
  maxResultChars: number
): Promise<{ record: ToolCallRecord; observation: string }> {
  const started = performance.now();
  const span = parentSpan.child(`agent.tool.${call.name}`, { tool: call.name, arguments: call.arguments });
  const result = await options.runtime.call(call.name, call.arguments, options.signal);
  const durationMs = Math.round((performance.now() - started) * 100) / 100;
  const record: ToolCallRecord = {
    step,
    name: call.name,
    arguments: call.arguments,
    ok: result.ok,
    durationMs,
    ...(result.ok
      ? {
          ...(result.meta.transactionId ? { transactionId: result.meta.transactionId } : {}),
          ...(result.meta.revision ? { revision: result.meta.revision } : {}),
        }
      : { errorCode: result.error.code }),
  };
  span.end(result.ok ? 'ok' : 'error', {
    tool: call.name,
    durationMs,
    ...(result.ok ? {} : { code: result.error.code }),
  });
  options.metrics?.inc('agent_tool_calls_total', 1, {
    tool: call.name,
    status: result.ok ? 'ok' : 'error',
  });
  const observation = truncateObservation(JSON.stringify(result), maxResultChars);
  return { record, observation };
}

function truncateObservation(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars; call model.get_source or narrow the request for full data]`;
}

function appendToolResult(messages: ChatMessage[], call: ToolCall, payload: unknown): void {
  messages.push({
    role: 'tool',
    toolName: call.name,
    toolCallId: call.id,
    content: JSON.stringify(payload),
  });
}

function trimMessages(messages: ChatMessage[], maxMessages: number): ChatMessage[] {
  const trimmed = messages.map((message) => ({
    ...message,
    content:
      message.content.length > 16_000
        ? `${message.content.slice(0, 16_000)}\n...[truncated ${message.content.length - 16_000} chars]`
        : message.content,
  }));
  if (trimmed.length <= maxMessages) {
    return trimmed;
  }
  return [trimmed[0], trimmed[1], ...trimmed.slice(trimmed.length - (maxMessages - 2))];
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /ECONNREFUSED|ENOTFOUND|fetch failed|network|socket|timeout/i.test(error.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
