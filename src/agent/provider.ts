import type { ToolSchema } from '../contracts/tool.ts';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LlmResponse {
  message: ChatMessage;
  usage: LlmUsage;
  finishReason?: string;
}

export interface ChatOptions {
  temperature?: number;
  signal?: AbortSignal;
  /** Approximate context ceiling; providers may trim or reject. */
  maxTokens?: number;
}

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  chat(messages: ChatMessage[], tools: ToolSchema[], options?: ChatOptions): Promise<LlmResponse>;
}

export interface ScriptedStep {
  content?: string;
  toolCalls?: Array<{ name: string; arguments?: Record<string, unknown> }>;
}

/** Deterministic provider used by tests and offline evaluations. */
export class MockProvider implements LlmProvider {
  readonly id = 'mock';
  readonly model = 'scripted';
  private index = 0;
  private readonly script: ScriptedStep[];

  constructor(script: ScriptedStep[]) {
    this.script = script;
  }

  async chat(): Promise<LlmResponse> {
    const step = this.script[this.index];
    this.index += 1;
    if (!step) {
      return {
        message: { role: 'assistant', content: 'Script exhausted before agent.finish was called.' },
        usage: { promptTokens: 0, completionTokens: 0 },
        finishReason: 'script_exhausted',
      };
    }
    const toolCalls = (step.toolCalls ?? []).map((call, i) => ({
      id: `call_${this.index}_${i}`,
      name: call.name,
      arguments: call.arguments ?? {},
    }));
    return {
      message: {
        role: 'assistant',
        content: step.content ?? '',
        ...(toolCalls.length ? { toolCalls } : {}),
      },
      usage: { promptTokens: 100, completionTokens: 50 },
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    };
  }

  reset(): void {
    this.index = 0;
  }
}

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
  keepAlive?: string;
}

/** Local Ollama provider, using the native /api/chat endpoint with tools. */
export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly keepAlive?: string;

  constructor(options: OllamaOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.model = options.model ?? process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:7b';
    this.temperature = options.temperature ?? 0.1;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.keepAlive = options.keepAlive;
  }

  async chat(messages: ChatMessage[], tools: ToolSchema[], options: ChatOptions = {}): Promise<LlmResponse> {
    if (tools.length === 0) {
      throw new Error('OllamaProvider requires at least one tool');
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const body = {
      model: this.model,
      stream: false,
      messages: messages.map(toOllamaMessage),
      tools: tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
      options: { temperature: options.temperature ?? this.temperature },
      ...(this.keepAlive ? { keep_alive: this.keepAlive } : {}),
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot reach Ollama at ${this.baseUrl}: ${message}. Start it with 'ollama serve' and pull the model with 'ollama pull ${this.model}'.`
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const retryable = response.status >= 500 || response.status === 429;
      const error = new Error(`Ollama returned HTTP ${response.status}: ${text.slice(0, 500)}`);
      (error as Error & { retryable?: boolean }).retryable = retryable;
      throw error;
    }

    const payload = (await response.json()) as {
      message?: {
        role?: string;
        content?: string;
        tool_calls?: Array<{
          function?: { name?: string; arguments?: unknown };
        }>;
      };
      prompt_eval_count?: number;
      eval_count?: number;
      done_reason?: string;
    };

    const rawCalls = payload.message?.tool_calls ?? [];
    const toolCalls: ToolCall[] = rawCalls.map((call, index) => ({
      id: `ollama_${Date.now()}_${index}`,
      name: call.function?.name ?? 'unknown',
      arguments: normalizeArguments(call.function?.arguments),
    }));

    return {
      message: {
        role: 'assistant',
        content: payload.message?.content ?? '',
        ...(toolCalls.length ? { toolCalls } : {}),
      },
      usage: {
        promptTokens: payload.prompt_eval_count ?? 0,
        completionTokens: payload.eval_count ?? 0,
      },
      finishReason: payload.done_reason,
    };
  }
}

function toOllamaMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      ...(message.toolName ? { tool_name: message.toolName } : {}),
    };
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function normalizeArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }
  return {};
}

export async function listOllamaModels(baseUrl = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'): Promise<string[]> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { models?: Array<{ name: string }> };
  return (payload.models ?? []).map((model) => model.name);
}
