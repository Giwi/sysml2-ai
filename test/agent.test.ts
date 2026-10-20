import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { WorkspaceEngine } from '../src/engine/engine.ts';
import { createToolRuntime } from '../src/tools/index.ts';
import { runAgent } from '../src/agent/loop.ts';
import { MockProvider } from '../src/agent/provider.ts';
import { TraceRecorder } from '../src/observability/trace.ts';
import { Metrics } from '../src/observability/metrics.ts';
import { tempWorkspace } from './helpers.ts';

test('agent loop executes tools, observes results and finishes', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const traceFile = join(ws.dir, '.sysml-ai', 'traces', 'agent.jsonl');
  const tracer = new TraceRecorder({ file: traceFile });
  const metrics = new Metrics();
  const runtime = createToolRuntime(engine, {
    actor: 'agent-test',
    tracer,
    capabilities: ['read', 'write', 'analyze'],
    metrics,
  });
  const provider = new MockProvider([
    { toolCalls: [{ name: 'model.get_element', arguments: { qname: 'Vehicle::Chassis' } }] },
    { toolCalls: [{ name: 'model.rename_element', arguments: { qname: 'Vehicle::Chassis', newName: 'Frame' } }] },
    { toolCalls: [{ name: 'model.validate', arguments: {} }] },
    {
      toolCalls: [
        {
          name: 'agent.finish',
          arguments: { summary: 'Renamed Vehicle::Chassis to Vehicle::Frame', claims: ['rename committed'] },
        },
      ],
    },
  ]);

  const result = await runAgent({
    role: 'editor',
    goal: 'Rename Chassis to Frame',
    provider,
    runtime,
    tracer,
    metrics,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.finish?.summary, 'Renamed Vehicle::Chassis to Vehicle::Frame');
  assert.equal(result.steps, 4);
  assert.equal(result.toolCalls.length, 4);
  assert.ok(result.toolCalls.every((call) => call.ok));
  assert.ok(engine.index().entryFor('Vehicle::Frame'));
  assert.notEqual(result.revisionBefore, result.revisionAfter);
  const trace = await fs.readFile(traceFile, 'utf8');
  assert.match(trace, /tool\.model\.rename_element/);
  assert.match(trace, /agent\.end/);

  const data = metrics.exportData();
  assert.ok(data.counters.some((point) => point.name === 'agent_runs_total' && point.labels.role === 'editor'));
  assert.ok(data.counters.some((point) => point.name === 'tool_calls_total' && point.labels.tool === 'model.rename_element'));
  assert.ok(data.latencies.some((point) => point.name === 'agent_duration_ms'));
});

test('structured tool errors are fed back and the agent can repair', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const tracer = new TraceRecorder();
  const runtime = createToolRuntime(engine, { actor: 'agent-test', tracer, capabilities: ['read', 'write'] });
  const provider = new MockProvider([
    { toolCalls: [{ name: 'model.rename_element', arguments: { qname: 'Vehicle::Chassiss', newName: 'Frame' } }] },
    { toolCalls: [{ name: 'model.rename_element', arguments: { qname: 'Vehicle::Chassis', newName: 'Frame' } }] },
    { toolCalls: [{ name: 'agent.finish', arguments: { summary: 'Repaired qname and renamed' } }] },
  ]);

  const result = await runAgent({ role: 'editor', goal: 'Rename Chassis', provider, runtime, tracer });
  assert.equal(result.status, 'completed');
  assert.equal(result.toolCalls[0].ok, false);
  assert.equal(result.toolCalls[0].errorCode, 'ELEMENT_NOT_FOUND');
  assert.equal(result.toolCalls[1].ok, true);
  assert.ok(engine.index().entryFor('Vehicle::Frame'));
});

test('step budget stops a looping agent', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const tracer = new TraceRecorder();
  const runtime = createToolRuntime(engine, { actor: 'agent-test', tracer, capabilities: ['read'] });
  const provider = new MockProvider([
    { toolCalls: [{ name: 'analysis.summary', arguments: {} }] },
    { toolCalls: [{ name: 'analysis.summary', arguments: {} }] },
    { toolCalls: [{ name: 'analysis.summary', arguments: {} }] },
  ]);

  const result = await runAgent({
    role: 'analyst',
    goal: 'Loop forever',
    provider,
    runtime,
    tracer,
    budget: { maxSteps: 2, maxToolCalls: 10 },
  });
  assert.equal(result.status, 'budget_exceeded');
  assert.equal(result.error?.code, 'BUDGET_EXCEEDED');
  assert.equal(result.steps, 2);
});

test('analyst role cannot bypass tool capabilities', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const tracer = new TraceRecorder();
  const runtime = createToolRuntime(engine, { actor: 'agent-test', tracer, capabilities: ['read', 'analyze'] });
  const provider = new MockProvider([
    { toolCalls: [{ name: 'model.delete_element', arguments: { qname: 'Vehicle::Chassis' } }] },
    { toolCalls: [{ name: 'agent.finish', arguments: { summary: 'Could not edit, read-only' } }] },
  ]);

  const result = await runAgent({ role: 'analyst', goal: 'Try to edit', provider, runtime, tracer });
  assert.equal(result.status, 'completed');
  assert.equal(result.toolCalls[0].errorCode, 'CAPABILITY_DENIED');
  assert.ok(engine.index().entryFor('Vehicle::Chassis'));
});

test('provider failure is reported as a structured provider error', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const tracer = new TraceRecorder();
  const runtime = createToolRuntime(engine, { actor: 'agent-test', tracer, capabilities: ['read'] });
  const failing = {
    id: 'failing',
    model: 'none',
    chat: async () => {
      throw new Error('connection refused');
    },
  };

  const result = await runAgent({
    role: 'analyst',
    goal: 'Fail',
    provider: failing,
    runtime,
    tracer,
    budget: { maxToolCalls: 1 },
  });
  assert.equal(result.status, 'error');
  assert.equal(result.error?.code, 'PROVIDER_ERROR');
  assert.match(result.error?.message ?? '', /connection refused/);
});
