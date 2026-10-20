import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runAgent } from '../agent/loop.ts';
import type { AgentRunResult } from '../agent/loop.ts';
import { MockProvider, OllamaProvider } from '../agent/provider.ts';
import { roleFor } from '../agent/roles.ts';
import { WorkspaceEngine } from '../engine/engine.ts';
import { ModelIndex } from '../engine/index.ts';
import { createToolRuntime } from '../tools/index.ts';
import { Metrics, percentile } from '../observability/metrics.ts';
import { TraceRecorder } from '../observability/trace.ts';
import { assertionsPassed, evaluateAssertions } from './assertions.ts';
import type { AssertionResult } from './assertions.ts';
import { compareToBaseline, readBaseline, writeBaseline } from './baseline.ts';
import type { Baseline, BaselineEntry } from './baseline.ts';
import { parseScenario } from './scenario.ts';
import type { Scenario } from './scenario.ts';
import { writeReports } from './report.ts';

export interface EvalOptions {
  scenariosDir: string;
  fixturesDir: string;
  outDir: string;
  provider: 'mock' | 'ollama';
  model?: string;
  filterTags?: string[];
  filterIds?: string[];
  concurrency?: number;
  baselineFile?: string;
  updateBaseline?: boolean;
  keepArtifacts?: boolean;
  signal?: AbortSignal;
  metrics?: Metrics;
}

export interface ScenarioMetrics {
  steps: number;
  toolCalls: number;
  toolErrors: number;
  durationMs: number;
  tokens: number;
}

export interface ScenarioResult {
  id: string;
  title: string;
  role: Scenario['role'];
  tags: string[];
  ok: boolean;
  assertions: AssertionResult[];
  metrics: ScenarioMetrics;
  run?: AgentRunResult;
  error?: string;
  traceFile?: string;
  artifactDir?: string;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  successRate: number;
  avgSteps: number;
  avgToolCalls: number;
  toolErrorRate: number;
  p50DurationMs: number;
  p95DurationMs: number;
  totalTokens: number;
  durationMs: number;
}

export interface EvalReport {
  runId: string;
  startedAt: string;
  endedAt: string;
  provider: string;
  model?: string;
  summary: EvalSummary;
  scenarios: ScenarioResult[];
  baseline: { file?: string; updated: boolean; regressions: string[] };
  reportDir: string;
}

export async function loadScenarios(dir: string): Promise<Scenario[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const scenarios: Scenario[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = join(dir, entry.name);
    const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as unknown;
    scenarios.push(parseScenario(parsed, path));
  }
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) {
      throw new Error(`Duplicate scenario id: ${scenario.id}`);
    }
    ids.add(scenario.id);
  }
  return scenarios;
}

/**
 * Run every scenario in an isolated temporary workspace, collect assertions,
 * compare against the baseline, then write JSON/Markdown/JUnit reports and
 * JSONL traces. Fixtures are never modified.
 */
export async function runEvaluation(options: EvalOptions): Promise<EvalReport> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const runId = `eval_${randomUUID().slice(0, 8)}`;
  let scenarios = await loadScenarios(options.scenariosDir);
  if (options.filterTags?.length) {
    scenarios = scenarios.filter((scenario) => scenario.tags.some((tag) => options.filterTags!.includes(tag)));
  }
  if (options.filterIds?.length) {
    scenarios = scenarios.filter((scenario) => options.filterIds!.includes(scenario.id));
  }
  if (scenarios.length === 0) {
    throw new Error('No scenario matched the filters');
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = join(options.outDir, `${timestamp}_${runId}`);
  await fs.mkdir(join(reportDir, 'traces'), { recursive: true });

  const baselineFile = options.baselineFile ?? join(process.cwd(), 'eval', 'baseline.json');
  const baseline = await readBaseline(baselineFile);
  const nextBaseline: Record<string, BaselineEntry> = { ...(baseline?.scenarios ?? {}) };
  const metrics = options.metrics ?? new Metrics();
  const tempBase = process.env.SYSML_AI_TMP && existsSync(process.env.SYSML_AI_TMP) ? process.env.SYSML_AI_TMP : tmpdir();
  await fs.mkdir(tempBase, { recursive: true });

  // Warm up the generated ANTLR parser once: the first parse pays a large
  // JIT cost and would otherwise pollute the first scenario's duration metric.
  ModelIndex.build([{ uri: 'warmup.sysml', text: 'package Warmup { part def A; }' }]);

  const concurrency = Math.max(1, options.concurrency ?? 2);
  const results = await mapLimit(scenarios, concurrency, async (scenario) => {
    if (options.signal?.aborted) {
      throw new Error('Evaluation cancelled');
    }
    const result = await runScenario(scenario, {
      ...options,
      reportDir,
      tempBase,
      baseline,
    });
    metrics.inc('scenario_total', 1, { scenario: scenario.id, status: result.ok ? 'pass' : 'fail' });
    metrics.observe('scenario_duration_ms', result.metrics.durationMs, { scenario: scenario.id });
    if (result.ok) {
      nextBaseline[scenario.id] = {
        ok: true,
        steps: result.metrics.steps,
        toolCalls: result.metrics.toolCalls,
        toolErrors: result.metrics.toolErrors,
        durationMs: result.metrics.durationMs,
        tokens: result.metrics.tokens,
      };
    } else {
      const previous = nextBaseline[scenario.id];
      nextBaseline[scenario.id] = {
        ok: false,
        steps: previous?.steps ?? result.metrics.steps,
        toolCalls: previous?.toolCalls ?? result.metrics.toolCalls,
        toolErrors: previous?.toolErrors ?? result.metrics.toolErrors,
        durationMs: previous?.durationMs ?? result.metrics.durationMs,
        tokens: previous?.tokens ?? result.metrics.tokens,
      };
    }
    return result;
  });

  if (options.updateBaseline) {
    await writeBaseline(baselineFile, nextBaseline);
  }

  const passed = results.filter((result) => result.ok).length;
  const durations = results.map((result) => result.metrics.durationMs).sort((a, b) => a - b);
  const totalToolCalls = results.reduce((sum, result) => sum + result.metrics.toolCalls, 0);
  const totalToolErrors = results.reduce((sum, result) => sum + result.metrics.toolErrors, 0);
  const summary: EvalSummary = {
    total: results.length,
    passed,
    failed: results.length - passed,
    successRate: results.length === 0 ? 0 : Math.round((passed / results.length) * 1000) / 1000,
    avgSteps: average(results.map((result) => result.metrics.steps)),
    avgToolCalls: average(results.map((result) => result.metrics.toolCalls)),
    toolErrorRate: totalToolCalls === 0 ? 0 : Math.round((totalToolErrors / totalToolCalls) * 1000) / 1000,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    totalTokens: results.reduce((sum, result) => sum + result.metrics.tokens, 0),
    durationMs: Math.round(performance.now() - started),
  };

  const regressions = results.filter((result) =>
    result.assertions.some((assertion) => assertion.name.startsWith('non_regression:') && !assertion.ok)
  );
  const report: EvalReport = {
    runId,
    startedAt,
    endedAt: new Date().toISOString(),
    provider: options.provider,
    ...(options.model ? { model: options.model } : {}),
    summary,
    scenarios: results,
    baseline: {
      file: baselineFile,
      updated: options.updateBaseline === true,
      regressions: regressions.map((result) => result.id),
    },
    reportDir,
  };

  await writeReports(report, metrics.snapshot());
  return report;
}

async function runScenario(
  scenario: Scenario,
  options: EvalOptions & { reportDir: string; tempBase: string; baseline?: Baseline }
): Promise<ScenarioResult> {
  const traceFile = join(options.reportDir, 'traces', `${safeName(scenario.id)}.jsonl`);
  const tracer = new TraceRecorder({
    file: traceFile,
    attributes: { component: 'eval', scenario: scenario.id, role: scenario.role },
  });
  const tempRoot = await fs.mkdtemp(join(options.tempBase, 'sysml-ai-eval-'));
  const workspace = join(tempRoot, 'workspace');
  const started = performance.now();

  try {
    const fixturesRoot = resolve(options.fixturesDir);
    const fixture = resolve(fixturesRoot, scenario.fixture);
    if (fixture !== fixturesRoot && !fixture.startsWith(`${fixturesRoot}${sep}`)) {
      throw new Error(`Scenario '${scenario.id}' fixture escapes the fixtures directory: ${scenario.fixture}`);
    }
    const stat = await fs.stat(fixture);
    if (stat.isDirectory()) {
      await fs.cp(fixture, workspace, {
        recursive: true,
        filter: (source) => !source.split(/[\\/]/).includes('.sysml-ai'),
      });
    } else {
      await fs.mkdir(workspace, { recursive: true });
      await fs.copyFile(fixture, join(workspace, basename(fixture)));
    }

    const engine = await WorkspaceEngine.open(workspace);
    const role = roleFor(scenario.role);
    const providerKind = options.provider === 'ollama' ? 'ollama' : scenario.provider.kind;
    const provider =
      providerKind === 'script'
        ? new MockProvider(scenario.script ?? [])
        : new OllamaProvider({ model: scenario.provider.model ?? options.model, temperature: scenario.provider.temperature });

    const runtime = createToolRuntime(engine, {
      actor: `eval:${scenario.id}`,
      tracer,
      capabilities: role.capabilities,
      dryRun: false,
      ...(options.metrics ? { metrics: options.metrics } : {}),
    });

    tracer.event('eval.scenario_start', {
      scenario: scenario.id,
      fixture: scenario.fixture,
      provider: providerKind,
      model: provider.model,
      goal: scenario.goal,
    });

    const run = await runAgent({
      role: scenario.role,
      goal: scenario.goal,
      context: scenario.context,
      provider,
      runtime,
      tracer,
      budget: scenario.budget,
      signal: options.signal,
      ...(options.metrics ? { metrics: options.metrics } : {}),
    });

    const assertions = evaluateAssertions({ scenario, run, engine });
    const current: BaselineEntry = {
      ok: assertionsPassed(assertions),
      steps: run.steps,
      toolCalls: run.toolCalls.length,
      toolErrors: run.toolCalls.filter((call) => !call.ok).length,
      durationMs: run.durationMs,
      tokens: run.usage.promptTokens + run.usage.completionTokens,
    };
    assertions.push(...compareToBaseline(scenario.id, current, options.baseline));
    const ok = assertionsPassed(assertions);

    let artifactDir: string | undefined;
    if (options.keepArtifacts || !ok) {
      artifactDir = join(options.reportDir, 'artifacts', safeName(scenario.id));
      await fs.cp(workspace, artifactDir, { recursive: true });
    }

    tracer.event('eval.scenario_end', {
      scenario: scenario.id,
      ok,
      steps: run.steps,
      toolCalls: run.toolCalls.length,
      durationMs: run.durationMs,
    });

    return {
      id: scenario.id,
      title: scenario.title,
      role: scenario.role,
      tags: scenario.tags,
      ok,
      assertions,
      metrics: {
        steps: current.steps,
        toolCalls: current.toolCalls,
        toolErrors: current.toolErrors,
        durationMs: run.durationMs,
        tokens: current.tokens,
      },
      run,
      traceFile,
      ...(artifactDir ? { artifactDir } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tracer.event('eval.scenario_error', { scenario: scenario.id, message }, 'error');
    const assertions: AssertionResult[] = [
      { name: 'execution', ok: false, severity: 'error', detail: message },
    ];
    const current: BaselineEntry = {
      ok: false,
      steps: 0,
      toolCalls: 0,
      toolErrors: 0,
      durationMs: Math.round(performance.now() - started),
      tokens: 0,
    };
    assertions.push(...compareToBaseline(scenario.id, current, options.baseline));
    return {
      id: scenario.id,
      title: scenario.title,
      role: scenario.role,
      tags: scenario.tags,
      ok: false,
      assertions,
      metrics: current,
      error: message,
      traceFile,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed) {
    throw failed.reason;
  }
  return results;
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]+/g, '_');
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}
