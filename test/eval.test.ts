import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { runEvaluation } from '../src/eval/runner.ts';
import { compareToBaseline } from '../src/eval/baseline.ts';
import { BASE_MODEL, tempWorkspace, writeWorkspaceFile } from './helpers.ts';

async function evalFixture() {
  const ws = await tempWorkspace();
  const fixtures = join(ws.dir, 'fixtures');
  const scenarios = join(ws.dir, 'scenarios');
  const out = join(ws.dir, 'reports');
  const baseline = join(ws.dir, 'baseline.json');
  await fs.mkdir(fixtures, { recursive: true });
  await fs.mkdir(scenarios, { recursive: true });
  await fs.writeFile(join(fixtures, 'model.sysml'), BASE_MODEL, 'utf8');
  const scenario = {
    id: 'rename-chassis',
    title: 'Rename a part definition and update references',
    tags: ['edit', 'rename'],
    role: 'editor',
    fixture: 'model.sysml',
    goal: 'Rename Vehicle::Chassis to Frame',
    provider: { kind: 'script' },
    script: [
      { toolCalls: [{ name: 'model.get_element', arguments: { qname: 'Vehicle::Chassis' } }] },
      { toolCalls: [{ name: 'model.rename_element', arguments: { qname: 'Vehicle::Chassis', newName: 'Frame' } }] },
      { toolCalls: [{ name: 'model.validate', arguments: {} }] },
      {
        toolCalls: [
          { name: 'agent.finish', arguments: { summary: 'Renamed Vehicle::Chassis to Vehicle::Frame', claims: ['references updated'] } },
        ],
      },
    ],
    expect: {
      status: 'completed',
      valid: true,
      changed: true,
      elementsPresent: [{ qname: 'Vehicle::Frame', kind: 'Part Definition' }],
      elementsAbsent: ['Vehicle::Chassis'],
      requiredTools: ['model.rename_element', 'model.validate'],
      maxSteps: 6,
      summaryContains: ['Vehicle::Frame'],
    },
  };
  await writeWorkspaceFile(scenarios, 'rename.json', JSON.stringify(scenario, null, 2));
  return { ws, fixtures, scenarios, out, baseline };
}

test('evaluation runner executes scenarios, writes reports and baseline', async (t) => {
  const fixture = await evalFixture();
  t.after(fixture.ws.cleanup);

  const report = await runEvaluation({
    scenariosDir: fixture.scenarios,
    fixturesDir: fixture.fixtures,
    outDir: fixture.out,
    baselineFile: fixture.baseline,
    provider: 'mock',
    concurrency: 1,
    updateBaseline: true,
  });

  assert.equal(report.summary.total, 1);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.scenarios[0].ok, true);
  assert.equal(report.scenarios[0].metrics.steps, 4);
  assert.ok(report.scenarios[0].traceFile);
  const reportJson = JSON.parse(await fs.readFile(join(report.reportDir, 'report.json'), 'utf8')) as { summary: { passed: number } };
  assert.equal(reportJson.summary.passed, 1);
  await fs.access(join(report.reportDir, 'summary.md'));
  await fs.access(join(report.reportDir, 'junit.xml'));
  const baseline = JSON.parse(await fs.readFile(fixture.baseline, 'utf8')) as { scenarios: Record<string, { ok: boolean }> };
  assert.equal(baseline.scenarios['rename-chassis'].ok, true);
});

test('a second run against the baseline has no regression', async (t) => {
  const fixture = await evalFixture();
  t.after(fixture.ws.cleanup);
  const options = {
    scenariosDir: fixture.scenarios,
    fixturesDir: fixture.fixtures,
    outDir: fixture.out,
    baselineFile: fixture.baseline,
    provider: 'mock' as const,
    concurrency: 1,
  };
  await runEvaluation({ ...options, updateBaseline: true });
  const second = await runEvaluation(options);
  assert.equal(second.scenarios[0].ok, true);
  assert.equal(second.baseline.regressions.length, 0);
  assert.ok(second.scenarios[0].assertions.some((assertion) => assertion.name === 'non_regression:steps' && assertion.ok));
});

test('baseline comparison flags a lost success and step inflation', () => {
  const baseline = {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    scenarios: {
      demo: { ok: true, steps: 4, toolCalls: 4, toolErrors: 0, durationMs: 100, tokens: 100 },
    },
  };
  const failures = compareToBaseline(
    'demo',
    { ok: false, steps: 12, toolCalls: 20, toolErrors: 3, durationMs: 5000, tokens: 10_000 },
    baseline
  );
  assert.ok(failures.some((assertion) => assertion.name === 'non_regression:success' && !assertion.ok));
  assert.ok(failures.some((assertion) => assertion.name === 'non_regression:steps' && !assertion.ok));
  assert.ok(failures.some((assertion) => assertion.name === 'non_regression:tool_calls' && !assertion.ok));
});

test('scenario failures produce failed assertions and a failing report', async (t) => {
  const fixture = await evalFixture();
  t.after(fixture.ws.cleanup);
  const scenarioPath = join(fixture.scenarios, 'rename.json');
  const scenario = JSON.parse(await fs.readFile(scenarioPath, 'utf8')) as Record<string, unknown>;
  scenario.expect = {
    status: 'completed',
    valid: true,
    elementsPresent: [{ qname: 'Vehicle::DoesNotExist' }],
  };
  await fs.writeFile(scenarioPath, JSON.stringify(scenario), 'utf8');

  const report = await runEvaluation({
    scenariosDir: fixture.scenarios,
    fixturesDir: fixture.fixtures,
    outDir: fixture.out,
    baselineFile: fixture.baseline,
    provider: 'mock',
    concurrency: 1,
  });
  assert.equal(report.summary.failed, 1);
  assert.equal(report.scenarios[0].ok, false);
  assert.ok(report.scenarios[0].assertions.some((assertion) => assertion.name === 'present:Vehicle::DoesNotExist' && !assertion.ok));
});
