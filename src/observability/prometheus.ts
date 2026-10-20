import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';
import type { Metrics, MetricsData, MetricLabels } from './metrics.ts';

export interface PrometheusOptions {
  /** Metric namespace. Default: sysml_ai_ */
  prefix?: string;
  /** Include HELP/TYPE metadata lines. Default: true. */
  includeHelp?: boolean;
}

export interface MetricsServerOptions extends PrometheusOptions {
  host?: string;
  port?: number;
  path?: string;
}

export interface MetricsServer {
  server: Server;
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface PushgatewayOptions extends PrometheusOptions {
  /** Pushgateway base URL, e.g. http://127.0.0.1:9091 */
  url: string;
  /** Job label, e.g. sysml-ai-agent */
  job: string;
  /** Instance label. Defaults to the machine hostname at the CLI layer. */
  instance?: string;
  /** Additional grouping labels. */
  labels?: Record<string, string>;
  timeoutMs?: number;
}

export interface PushResult {
  url: string;
  bytes: number;
}

/**
 * Render Prometheus text exposition format (version 0.0.4).
 * Counters and gauges map directly; latency samples become summaries with
 * p50/p95 quantiles plus `_sum` and `_count`.
 */
export function renderPrometheus(data: MetricsData, options: PrometheusOptions = {}): string {
  const prefix = options.prefix ?? 'sysml_ai_';
  const includeHelp = options.includeHelp ?? true;
  const lines: string[] = [];
  const declared = new Set<string>();

  const declare = (name: string, type: 'counter' | 'gauge' | 'summary'): void => {
    if (!includeHelp || declared.has(name)) {
      return;
    }
    declared.add(name);
    lines.push(`# HELP ${name} sysml-ai ${name.replace(prefix, '').replaceAll('_', ' ')}`);
    lines.push(`# TYPE ${name} ${type}`);
  };

  for (const point of data.counters) {
    const name = metricName(point.name, prefix);
    declare(name, 'counter');
    lines.push(`${name}${labelString(point.labels)} ${formatValue(point.value)}`);
  }

  for (const point of data.gauges) {
    const name = metricName(point.name, prefix);
    declare(name, 'gauge');
    lines.push(`${name}${labelString(point.labels)} ${formatValue(point.value)}`);
  }

  for (const point of data.latencies) {
    const name = metricName(point.name, prefix);
    declare(name, 'summary');
    lines.push(`${name}${labelString({ ...point.labels, quantile: '0.5' })} ${formatValue(point.p50)}`);
    lines.push(`${name}${labelString({ ...point.labels, quantile: '0.95' })} ${formatValue(point.p95)}`);
    lines.push(`${name}_sum${labelString(point.labels)} ${formatValue(point.sum)}`);
    lines.push(`${name}_count${labelString(point.labels)} ${point.count}`);
  }

  return lines.length ? `${lines.join('\n')}\n` : '';
}

/** Convert collected metrics without exposing the internal maps. */
export function metricsData(metrics: Metrics): MetricsData {
  return metrics.exportData();
}

export function metricName(name: string, prefix = 'sysml_ai_'): string {
  const raw = `${prefix}${name}`.replace(/[^a-zA-Z0-9_:]/g, '_');
  return /^[a-zA-Z_:]/.test(raw) ? raw : `_${raw}`;
}

function labelString(labels: MetricLabels): string {
  const entries = Object.entries(labels)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return '';
  }
  const body = entries
    .map(([name, value]) => `${labelName(name)}="${escapeLabel(value)}"`)
    .join(',');
  return `{${body}}`;
}

function labelName(name: string): string {
  const raw = name.replace(/[^a-zA-Z0-9_]/g, '_');
  return /^[a-zA-Z_]/.test(raw) ? raw : `_${raw}`;
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Push metrics to a Prometheus Pushgateway. Designed for short-lived agents,
 * evaluation runs and supervised jobs that cannot be scraped reliably.
 *
 * PUT replaces the whole grouping key, so repeated runs with the same
 * job/instance do not accumulate stale counters.
 */
export async function pushToPushgateway(metrics: Metrics, options: PushgatewayOptions): Promise<PushResult> {
  const body = renderPrometheus(metricsData(metrics), options);
  const base = options.url.replace(/\/+$/, '');
  const labelPath = [
    'job',
    options.job,
    ...(options.instance ? ['instance', options.instance] : []),
    ...Object.entries(options.labels ?? {}).flatMap(([name, value]) => [labelName(name), value]),
  ]
    .map(encodeURIComponent)
    .join('/');
  const url = `${base}/metrics/${labelPath}`;
  if (body.length === 0) {
    return { url, bytes: 0 };
  }

  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Pushgateway returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  return { url, bytes: Buffer.byteLength(body, 'utf8') };
}

/**
 * Start a Prometheus scrape endpoint.
 * `port: 0` picks a free port, useful in tests and CI.
 */
export async function startMetricsServer(
  metrics: Metrics,
  options: MetricsServerOptions = {}
): Promise<MetricsServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 9464;
  const path = options.path ?? '/metrics';

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);
    if (url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('ok\n');
      return;
    }
    if (url.pathname !== path) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found\n');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' });
      response.end();
      return;
    }
    const body = renderPrometheus(metricsData(metrics), options);
    response.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  });

  server.listen(port, host);
  await once(server, 'listening');
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const displayHost = host.includes(':') ? `[${host}]` : host;
  return {
    server,
    port: actualPort,
    url: `http://${displayHost}:${actualPort}${path}`,
    close: async () => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
