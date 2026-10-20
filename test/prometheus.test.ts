import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Metrics } from '../src/observability/metrics.ts';
import { metricName, pushToPushgateway, renderPrometheus, startMetricsServer } from '../src/observability/prometheus.ts';

test('Prometheus exposition renders counters, gauges and latency summaries', () => {
  const metrics = new Metrics();
  metrics.inc('tool_calls_total', 2, { tool: 'model.rename_element', status: 'ok' });
  metrics.gauge('model_revision', 3);
  metrics.observe('tool_duration_ms', 10, { tool: 'model.rename_element' });
  metrics.observe('tool_duration_ms', 30, { tool: 'model.rename_element' });
  metrics.observe('tool_duration_ms', 20, { tool: 'model.rename_element' });

  const text = renderPrometheus(metrics.exportData());
  assert.match(text, /# TYPE sysml_ai_tool_calls_total counter/);
  assert.match(text, /sysml_ai_tool_calls_total\{status="ok",tool="model\.rename_element"\} 2/);
  assert.match(text, /# TYPE sysml_ai_model_revision gauge/);
  assert.match(text, /sysml_ai_model_revision 3/);
  assert.match(text, /# TYPE sysml_ai_tool_duration_ms summary/);
  assert.match(text, /sysml_ai_tool_duration_ms\{quantile="0\.5",tool="model\.rename_element"\} 20/);
  assert.match(text, /sysml_ai_tool_duration_ms\{quantile="0\.95",tool="model\.rename_element"\} 30/);
  assert.match(text, /sysml_ai_tool_duration_ms_sum\{tool="model\.rename_element"\} 60/);
  assert.match(text, /sysml_ai_tool_duration_ms_count\{tool="model\.rename_element"\} 3/);
});

test('Prometheus labels are escaped and names sanitised', () => {
  const metrics = new Metrics();
  metrics.inc('weird.metric-name_total', 1, { 'tool.name': 'a"b\\c\nd' });
  const text = renderPrometheus(metrics.exportData());
  assert.match(text, /sysml_ai_weird_metric_name_total\{tool_name="a\\"b\\\\c\\nd"\} 1/);
  assert.equal(metricName('a.b-c', 'ns_'), 'ns_a_b_c');
  assert.equal(renderPrometheus(new Metrics().exportData()), '');
});

test('metrics HTTP endpoint serves /metrics and /health', async (t) => {
  const metrics = new Metrics();
  metrics.inc('agent_runs_total', 1, { role: 'editor', status: 'completed' });
  metrics.observe('agent_duration_ms', 42, { role: 'editor' });
  const server = await startMetricsServer(metrics, { port: 0 });
  t.after(async () => server.close());

  const response = await fetch(server.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/plain; version=0\.0\.4/);
  const body = await response.text();
  assert.match(body, /sysml_ai_agent_runs_total\{role="editor",status="completed"\} 1/);
  assert.match(body, /sysml_ai_agent_duration_ms_count\{role="editor"\} 1/);

  const health = await fetch(server.url.replace('/metrics', '/health'));
  assert.equal(health.status, 200);
  assert.equal((await health.text()).trim(), 'ok');

  const missing = await fetch(server.url.replace('/metrics', '/nope'));
  assert.equal(missing.status, 404);
});

test('custom prefix and disabled help lines are supported', () => {
  const metrics = new Metrics();
  metrics.inc('runs_total', 1, { role: 'analyst' });
  const text = renderPrometheus(metrics.exportData(), { prefix: 'custom_', includeHelp: false });
  assert.equal(text, 'custom_runs_total{role="analyst"} 1\n');
});

test('short-lived runs push metrics to a Pushgateway with grouping labels', async (t) => {
  let captured: { method?: string; url?: string; contentType?: string; body: string } | undefined;
  const gateway = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      captured = {
        method: request.method,
        url: request.url,
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      };
      response.writeHead(200);
      response.end('ok');
    });
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(async () => {
    gateway.closeIdleConnections?.();
    gateway.closeAllConnections?.();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  });
  const address = gateway.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;

  const metrics = new Metrics();
  metrics.inc('agent_runs_total', 1, { role: 'editor', status: 'completed' });
  const result = await pushToPushgateway(metrics, {
    url: `http://127.0.0.1:${port}`,
    job: 'sysml-ai-agent',
    instance: 'host one',
    labels: { component: 'agent' },
  });

  assert.equal(captured?.method, 'PUT');
  assert.equal(captured?.url, '/metrics/job/sysml-ai-agent/instance/host%20one/component/agent');
  assert.match(captured?.contentType ?? '', /text\/plain; version=0\.0\.4/);
  assert.match(captured?.body ?? '', /sysml_ai_agent_runs_total\{role="editor",status="completed"\} 1/);
  assert.equal(result.url, `http://127.0.0.1:${port}/metrics/job/sysml-ai-agent/instance/host%20one/component/agent`);
  assert.ok(result.bytes > 0);
});

test('Pushgateway errors surface with status details', async (t) => {
  const gateway = createServer((_request, response) => {
    response.writeHead(503);
    response.end('unavailable');
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(async () => {
    gateway.closeIdleConnections?.();
    gateway.closeAllConnections?.();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  });
  const address = gateway.address();
  assert.ok(address && typeof address === 'object');
  const metrics = new Metrics();
  metrics.inc('runs_total', 1, { role: 'analyst' });
  await assert.rejects(
    pushToPushgateway(metrics, {
      url: `http://127.0.0.1:${address.port}`,
      job: 'sysml-ai-agent',
      instance: 'test',
    }),
    /HTTP 503: unavailable/
  );
});
