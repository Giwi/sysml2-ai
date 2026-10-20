import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceEngine } from '../src/engine/engine.ts';
import { createToolRuntime } from '../src/tools/index.ts';
import { TraceRecorder } from '../src/observability/trace.ts';
import { tempWorkspace, readWorkspaceFile } from './helpers.ts';

async function setup(capabilities: Array<'read' | 'write' | 'analyze' | 'eval'>, dryRun = false) {
  const ws = await tempWorkspace();
  const engine = await WorkspaceEngine.open(ws.dir);
  const tracer = new TraceRecorder({ runId: 'test' });
  const runtime = createToolRuntime(engine, { actor: 'test', tracer, capabilities, dryRun });
  return { ws, engine, runtime, tracer };
}

test('tool catalog exposes JSON schemas filtered by capability', async (t) => {
  const { ws, runtime } = await setup(['read', 'analyze']);
  t.after(ws.cleanup);
  const schemas = runtime.schemas();
  assert.ok(schemas.some((tool) => tool.name === 'model.list_elements'));
  assert.ok(schemas.some((tool) => tool.name === 'analysis.summary'));
  assert.ok(!schemas.some((tool) => tool.name === 'model.rename_element'));
  const summary = schemas.find((tool) => tool.name === 'analysis.summary')!;
  assert.equal(summary.parameters.type, 'object');
});

test('list and get element return source and incoming references', async (t) => {
  const { ws, runtime } = await setup(['read', 'analyze']);
  t.after(ws.cleanup);
  const list = await runtime.call('model.list_elements', { nameContains: 'Chassis', kind: 'Part Definition' });
  assert.equal(list.ok, true);
  if (!list.ok) return;
  const data = list.data as { total: number; items: Array<{ qname: string }> };
  assert.equal(data.total, 1);
  assert.equal(data.items[0].qname, 'Vehicle::Chassis');

  const element = await runtime.call('model.get_element', { qname: 'Vehicle::Vehicle' });
  assert.equal(element.ok, true);
  if (!element.ok) return;
  const view = element.data as { children: Array<{ qname: string }>; source: string; incomingReferences: unknown[] };
  assert.equal(view.children[0].qname, 'Vehicle::Vehicle::chassis');
  assert.match(view.source, /part def Vehicle/);
  assert.ok(view.incomingReferences.length >= 1);
});

test('invalid input is converted into a structured INVALID_INPUT error', async (t) => {
  const { ws, runtime } = await setup(['read']);
  t.after(ws.cleanup);
  const result = await runtime.call('model.get_element', { line: -5 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'INVALID_INPUT');
  assert.ok(Array.isArray(result.error.details?.issues));
});

test('missing element errors include suggestions', async (t) => {
  const { ws, runtime } = await setup(['read']);
  t.after(ws.cleanup);
  const result = await runtime.call('model.get_element', { qname: 'Vehicle::Chassiss' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'ELEMENT_NOT_FOUND');
  assert.ok((result.error.suggestions ?? []).some((s) => s.includes('Vehicle::Chassis')));
});

test('read-only runtime cannot mutate', async (t) => {
  const { ws, runtime } = await setup(['read', 'analyze']);
  t.after(ws.cleanup);
  const result = await runtime.call('model.rename_element', { qname: 'Vehicle::Chassis', newName: 'Frame' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'CAPABILITY_DENIED');
});

test('create element tool commits and returns revision and diagnostics', async (t) => {
  const { ws, runtime, engine } = await setup(['read', 'write', 'analyze']);
  t.after(ws.cleanup);
  const result = await runtime.call('model.create_element', {
    uri: 'model.sysml',
    parentQname: 'Vehicle',
    kind: 'part def',
    name: 'BrakeSystem',
    body: 'attribute brakeForce : Real = 1000.0;',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const data = result.data as { transactionId: string; revision: string; diagnostics: { valid: boolean } };
  assert.match(data.transactionId, /^tx_/);
  assert.equal(data.diagnostics.valid, true);
  assert.equal(result.meta.revision, data.revision);
  assert.ok(engine.index().entryFor('Vehicle::BrakeSystem'));
  assert.match(await readWorkspaceFile(ws.dir, 'model.sysml'), /part def BrakeSystem/);
});

test('dry run never writes to disk', async (t) => {
  const { ws, runtime } = await setup(['read', 'write'], true);
  t.after(ws.cleanup);
  const before = await readWorkspaceFile(ws.dir, 'model.sysml');
  const result = await runtime.call('model.rename_element', { qname: 'Vehicle::Chassis', newName: 'Frame' });
  assert.equal(result.ok, true);
  assert.equal(await readWorkspaceFile(ws.dir, 'model.sysml'), before);
});

test('edit tool rejects a stale expected revision', async (t) => {
  const { ws, runtime } = await setup(['read', 'write']);
  t.after(ws.cleanup);
  const result = await runtime.call('model.edit', {
    ops: [
      {
        type: 'replace',
        uri: 'model.sysml',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        text: '',
      },
    ],
    expectRevision: 'stale',
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'REVISION_CONFLICT');
});

test('validate reports unresolved references as warnings', async (t) => {
  const ws = await tempWorkspace({
    'model.sysml': 'package P { part def A { part b : DoesNotExist; } }',
  });
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const tracer = new TraceRecorder();
  const runtime = createToolRuntime(engine, { actor: 'test', tracer, capabilities: ['read'] });
  const result = await runtime.call('model.validate', {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const report = result.data as {
    valid: boolean;
    unresolvedReferences: number;
    errors: { count: number };
    warnings: { count: number; items: Array<{ code: string }> };
  };
  assert.equal(report.valid, true);
  assert.equal(report.errors.count, 0);
  assert.equal(report.unresolvedReferences, 1);
  assert.equal(report.warnings.items[0].code, 'UNRESOLVED_REFERENCE');
});
