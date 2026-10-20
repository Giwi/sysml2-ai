import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { WorkspaceEngine } from '../src/engine/engine.ts';
import { Supervisor } from '../src/orchestration/supervisor.ts';
import type { SupervisionPlan } from '../src/orchestration/supervisor.ts';
import { runPipeline } from '../src/orchestration/pipeline.ts';
import { TraceRecorder } from '../src/observability/trace.ts';
import { FileLockManager } from '../src/orchestration/lock.ts';
import { MockProvider } from '../src/agent/provider.ts';
import { tempWorkspace } from './helpers.ts';

const analysisScript = [
  { toolCalls: [{ name: 'analysis.summary', arguments: {} }] },
  { toolCalls: [{ name: 'agent.finish', arguments: { summary: 'Model has 5 elements' } }] },
];

const editScript = [
  { toolCalls: [{ name: 'model.rename_element', arguments: { qname: 'Vehicle::Chassis', newName: 'Frame' } }] },
  { toolCalls: [{ name: 'model.validate', arguments: {} }] },
  { toolCalls: [{ name: 'agent.finish', arguments: { summary: 'Renamed Chassis to Frame' } }] },
];

const evalScript = [
  { toolCalls: [{ name: 'model.validate', arguments: {} }] },
  { toolCalls: [{ name: 'agent.finish', arguments: { summary: 'Frame exists, model valid', verdict: 'pass' } }] },
];

test('supervisor runs analysis in parallel, then edit, then evaluator gate', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const tracer = new TraceRecorder({ runId: 'sup-test' });
  const plan: SupervisionPlan = {
    id: 'test-pipeline',
    tasks: [
      { id: 'a1', role: 'analyst', goal: 'Summarise model', script: analysisScript },
      { id: 'a2', role: 'analyst', goal: 'Check requirements', script: analysisScript },
      { id: 'edit', role: 'editor', goal: 'Rename Chassis', dependsOn: ['a1', 'a2'], script: editScript, targetFiles: ['model.sysml'] },
      { id: 'eval', role: 'evaluator', goal: 'Verify rename', dependsOn: ['edit'], script: evalScript, requireVerdict: 'pass' },
    ],
    maxConcurrency: 4,
  };

  const supervisor = new Supervisor({ engine, tracer });
  const result = await supervisor.run(plan);
  assert.equal(result.status, 'completed');
  assert.equal(result.tasks.a1.status, 'completed');
  assert.equal(result.tasks.a2.status, 'completed');
  assert.equal(result.tasks.edit.status, 'completed');
  assert.equal(result.tasks.eval.status, 'completed');
  assert.equal(result.tasks.eval.result?.finish?.verdict, 'pass');
  assert.ok(engine.index().entryFor('Vehicle::Frame'));
});

test('failed dependency skips dependants', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const tracer = new TraceRecorder();
  const plan: SupervisionPlan = {
    id: 'test-skip',
    tasks: [
      {
        id: 'eval-fail',
        role: 'evaluator',
        goal: 'Return a failing verdict',
        script: [{ toolCalls: [{ name: 'agent.finish', arguments: { summary: 'failed', verdict: 'fail' } }] }],
        requireVerdict: 'pass',
      },
      { id: 'repair', role: 'editor', goal: 'Repair', dependsOn: ['eval-fail'], script: editScript },
    ],
  };
  const result = await new Supervisor({ engine, tracer }).run(plan);
  assert.equal(result.status, 'failed');
  assert.equal(result.tasks['eval-fail'].status, 'failed');
  assert.equal(result.tasks.repair.status, 'skipped');
  assert.ok(result.tasks['eval-fail'].error);
});

test('retry policy re-runs transient provider failures', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const tracer = new TraceRecorder();
  let calls = 0;
  const plan: SupervisionPlan = {
    id: 'test-retry',
    tasks: [
      {
        id: 'flaky',
        role: 'analyst',
        goal: 'Summarise',
        retries: 1,
        retryOn: 'any',
      },
    ],
  };
  const result = await new Supervisor({
    engine,
    tracer,
    providerFactory: () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('temporary provider outage');
      }
      return new MockProvider(analysisScript);
    },
  }).run(plan);
  assert.equal(calls, 2);
  assert.equal(result.tasks.flaky.attempts, 2);
  assert.equal(result.status, 'completed');
});

test('checkpoint resume skips already completed tasks', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const tracer = new TraceRecorder();
  const checkpoint = join(ws.dir, '.sysml-ai', 'checkpoint.json');
  const plan: SupervisionPlan = {
    id: 'test-resume',
    tasks: [{ id: 'analyst', role: 'analyst', goal: 'Summarise', script: analysisScript }],
  };
  const first = await new Supervisor({ engine, tracer, checkpointFile: checkpoint }).run(plan);
  assert.equal(first.status, 'completed');

  let providerCalls = 0;
  const second = await new Supervisor({
    engine,
    tracer,
    checkpointFile: checkpoint,
    resume: true,
    providerFactory: () => {
      providerCalls += 1;
      throw new Error('should not be called');
    },
  }).run(plan);
  assert.equal(providerCalls, 0);
  assert.equal(second.status, 'completed');
  assert.equal(second.tasks.analyst.status, 'completed');
});

test('autonomous pipeline repairs a failed evaluation', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const tracer = new TraceRecorder();
  const providerFactory = (task: { id: string }) => {
    if (task.id.startsWith('analysis')) return new MockProvider(analysisScript);
    if (task.id === 'edit-0') return new MockProvider(editScript);
    if (task.id === 'evaluate-0') {
      return new MockProvider([
        { toolCalls: [{ name: 'model.validate', arguments: {} }] },
        {
          toolCalls: [
            {
              name: 'agent.finish',
              arguments: {
                summary: 'Frame exists but no brake requirement was added.',
                verdict: 'fail',
                findings: [
                  {
                    code: 'MISSING_BRAKE_REQUIREMENT',
                    message: 'No brake requirement',
                    severity: 'error',
                    evidence: ['model.validate'],
                  },
                ],
              },
            },
          ],
        },
      ]);
    }
    if (task.id === 'edit-1') {
      return new MockProvider([
        {
          toolCalls: [
            {
              name: 'model.create_element',
              arguments: {
                uri: 'model.sysml',
                parentQname: 'Vehicle',
                kind: 'requirement def',
                name: 'BrakeRequirement',
              },
            },
          ],
        },
        { toolCalls: [{ name: 'agent.finish', arguments: { summary: 'Added the missing brake requirement' } }] },
      ]);
    }
    return new MockProvider([
      { toolCalls: [{ name: 'model.validate', arguments: {} }] },
      { toolCalls: [{ name: 'agent.finish', arguments: { summary: 'Repair verified', verdict: 'pass' } }] },
    ]);
  };

  const result = await runPipeline({
    engine,
    objective: 'Add a brake requirement and verify it',
    providerFactory,
    analysisGoals: ['Inspect requirements'],
    editGoal: 'Rename Chassis to Frame',
    evaluationGoal: 'Verify the brake work',
    targetFiles: ['model.sysml'],
    maxRepairRounds: 1,
    tracer,
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.rounds, 2);
  assert.equal(result.phases[0].verdict, 'fail');
  assert.equal(result.phases[1].verdict, 'pass');
  assert.ok(engine.index().entryFor('Vehicle::BrakeRequirement'));
});

test('file locks serialise writers and time out cleanly', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const locks = new FileLockManager(ws.dir, { timeoutMs: 200, pollMs: 20 });
  const first = await locks.acquire('model.sysml');
  await assert.rejects(locks.acquire('model.sysml'), (error: unknown) => {
    assert.equal((error as { error: { code: string } }).error.code, 'LOCKED');
    return true;
  });
  await first.release();
  const second = await locks.acquire('model.sysml');
  await second.release();
});
