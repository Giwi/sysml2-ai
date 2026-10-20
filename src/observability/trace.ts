import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Minimal span/event tracer writing JSON lines. One line per event keeps the
 * trace append-only and crash resilient: a killed run still leaves usable
 * evidence. Long payloads are truncated, secrets are redacted.
 */

export type TraceLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TraceEvent {
  ts: string;
  runId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 'span.start' | 'span.end' | 'event';
  level: TraceLevel;
  durationMs?: number;
  status?: 'ok' | 'error' | 'cancelled';
  attributes: Record<string, unknown>;
}

export interface Span {
  readonly id: string;
  readonly traceId: string;
  event(name: string, attributes?: Record<string, unknown>, level?: TraceLevel): void;
  end(status?: 'ok' | 'error' | 'cancelled', attributes?: Record<string, unknown>): void;
  child(name: string, attributes?: Record<string, unknown>): Span;
}

export interface TracerOptions {
  runId?: string;
  /** JSONL output path. When omitted the trace stays in memory only. */
  file?: string;
  /** Truncate string and array payloads. */
  maxPayloadChars?: number;
  attributes?: Record<string, unknown>;
  memoryLimit?: number;
}

const SECRET_KEY = /(api[_-]?key|authorization|secret|password|bearer|token)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return '[depth-limit]';
  }
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((v) => redact(v, depth + 1));
  }
  if (typeof value === 'object') {
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function truncate(value: unknown, maxChars: number): unknown {
  if (typeof value === 'string' && value.length > maxChars) {
    return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`;
  }
  if (Array.isArray(value) && value.length > 50) {
    return [...value.slice(0, 50), `...[${value.length - 50} more]`];
  }
  return value;
}

export class TraceRecorder {
  readonly runId: string;
  readonly traceId: string;
  readonly file?: string;
  readonly events: TraceEvent[] = [];
  private readonly maxPayloadChars: number;
  private readonly memoryLimit: number;
  private readonly baseAttributes: Record<string, unknown>;
  private fileBroken = false;

  constructor(options: TracerOptions = {}) {
    this.runId = options.runId ?? `run_${randomUUID().slice(0, 8)}`;
    this.traceId = randomUUID();
    this.file = options.file;
    this.maxPayloadChars = options.maxPayloadChars ?? 12_000;
    this.memoryLimit = options.memoryLimit ?? 20_000;
    this.baseAttributes = options.attributes ?? {};
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
    }
  }

  record(event: Omit<TraceEvent, 'ts' | 'runId' | 'traceId'>): void {
    const full: TraceEvent = {
      ts: new Date().toISOString(),
      runId: this.runId,
      traceId: this.traceId,
      ...event,
      attributes: this.clean({ ...this.baseAttributes, ...event.attributes }),
    };
    this.events.push(full);
    if (this.events.length > this.memoryLimit) {
      this.events.splice(0, this.events.length - this.memoryLimit);
    }
    if (this.file && !this.fileBroken) {
      try {
        appendFileSync(this.file, `${JSON.stringify(full)}\n`, 'utf8');
      } catch {
        // A full disk must not abort a model edit or an evaluation. Keep the
        // in-memory trace and stop retrying the broken sink.
        this.fileBroken = true;
      }
    }
  }

  private clean(attributes: Record<string, unknown>): Record<string, unknown> {
    const redacted = redact(attributes) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(redacted)) {
      out[k] = truncate(v, this.maxPayloadChars);
    }
    return out;
  }

  startSpan(name: string, attributes: Record<string, unknown> = {}, parentSpanId?: string): Span {
    const id = randomUUID();
    const startedAt = performance.now();
    this.record({
      spanId: id,
      ...(parentSpanId ? { parentSpanId } : {}),
      name,
      kind: 'span.start',
      level: 'info',
      attributes,
    });
    let ended = false;
    const end = (status: 'ok' | 'error' | 'cancelled' = 'ok', extra: Record<string, unknown> = {}): void => {
      if (ended) {
        return;
      }
      ended = true;
      this.record({
        spanId: id,
        ...(parentSpanId ? { parentSpanId } : {}),
        name,
        kind: 'span.end',
        level: status === 'error' ? 'error' : 'info',
        status,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        attributes: extra,
      });
    };
    const span: Span = {
      id,
      traceId: this.traceId,
      event: (eventName, extra = {}, level = 'info') => {
        this.record({
          spanId: id,
          parentSpanId,
          name: eventName,
          kind: 'event',
          level,
          attributes: extra,
        });
      },
      end,
      child: (childName, extra = {}) => this.startSpan(childName, extra, id),
    };
    return span;
  }

  event(name: string, attributes: Record<string, unknown> = {}, level: TraceLevel = 'info'): void {
    this.record({ spanId: this.traceId, name, kind: 'event', level, attributes });
  }

  toJSON(): { runId: string; traceId: string; events: TraceEvent[] } {
    return { runId: this.runId, traceId: this.traceId, events: this.events };
  }
}
