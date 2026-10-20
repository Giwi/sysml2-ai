import type { AgentRunResult } from '../agent/loop.ts';
import type { WorkspaceEngine } from '../engine/engine.ts';
import type { Scenario } from './scenario.ts';

export interface AssertionResult {
  name: string;
  ok: boolean;
  severity: 'error' | 'warning';
  detail: string;
}

export interface AssertionContext {
  scenario: Scenario;
  run: AgentRunResult;
  engine: WorkspaceEngine;
}

export function evaluateAssertions(context: AssertionContext): AssertionResult[] {
  const { scenario, run, engine } = context;
  const index = engine.index();
  const expect = scenario.expect;
  const results: AssertionResult[] = [];
  const add = (name: string, ok: boolean, detail: string, severity: 'error' | 'warning' = 'error'): void => {
    results.push({ name, ok, detail, severity });
  };

  add('status', run.status === expect.status, `expected '${expect.status}', got '${run.status}'`);
  if (expect.finishRequired) {
    add('finish', Boolean(run.finish), run.finish ? 'agent.finish called' : 'agent.finish was not called');
  }
  if (expect.verdict) {
    add('verdict', run.finish?.verdict === expect.verdict, `expected '${expect.verdict}', got '${run.finish?.verdict ?? 'missing'}'`);
  }

  add('valid', index.diagnostics.valid === expect.valid, `expected valid=${expect.valid}, got valid=${index.diagnostics.valid}`);
  add('errors', index.diagnostics.errors.count <= expect.maxErrors, `${index.diagnostics.errors.count} error(s), max ${expect.maxErrors}`);
  if (expect.maxUnresolvedReferences !== undefined) {
    add(
      'unresolved_references',
      index.diagnostics.unresolvedReferences <= expect.maxUnresolvedReferences,
      `${index.diagnostics.unresolvedReferences} unresolved reference(s), max ${expect.maxUnresolvedReferences}`
    );
  }

  if (expect.maxSteps !== undefined) {
    add('max_steps', run.steps <= expect.maxSteps, `${run.steps} step(s), max ${expect.maxSteps}`);
  }
  if (expect.maxToolCalls !== undefined) {
    add('max_tool_calls', run.toolCalls.length <= expect.maxToolCalls, `${run.toolCalls.length} tool call(s), max ${expect.maxToolCalls}`);
  }
  const toolErrors = run.toolCalls.filter((call) => !call.ok);
  if (expect.maxToolErrors !== undefined) {
    add('max_tool_errors', toolErrors.length <= expect.maxToolErrors, `${toolErrors.length} tool error(s), max ${expect.maxToolErrors}`);
  }
  if (expect.maxDurationMs !== undefined) {
    add('max_duration', run.durationMs <= expect.maxDurationMs, `${run.durationMs}ms, max ${expect.maxDurationMs}ms`);
  }
  if (expect.maxTokens !== undefined) {
    const tokens = run.usage.promptTokens + run.usage.completionTokens;
    add('max_tokens', tokens <= expect.maxTokens, `${tokens} token(s), max ${expect.maxTokens}`);
  }

  if (expect.changed !== undefined) {
    const changed = run.revisionBefore !== run.revisionAfter;
    add('changed', changed === expect.changed, `expected changed=${expect.changed}, model ${changed ? 'changed' : 'unchanged'}`);
  }
  if (expect.minElements !== undefined) {
    add('min_elements', index.elements.length >= expect.minElements, `${index.elements.length} element(s), min ${expect.minElements}`);
  }
  if (expect.maxElements !== undefined) {
    add('max_elements', index.elements.length <= expect.maxElements, `${index.elements.length} element(s), max ${expect.maxElements}`);
  }

  for (const expected of expect.elementsPresent) {
    const entry = index.entryFor(expected.qname);
    const kindOk = !expected.kind || entry?.sym.kind === expected.kind;
    add(
      `present:${expected.qname}`,
      Boolean(entry) && kindOk,
      entry ? `found as '${entry.sym.kind}'${expected.kind ? ` (expected '${expected.kind}')` : ''}` : 'not found'
    );
  }
  for (const qname of expect.elementsAbsent) {
    add(`absent:${qname}`, !index.entryFor(qname), index.entryFor(qname) ? 'still present' : 'absent');
  }

  const called = new Set(run.toolCalls.map((call) => call.name));
  for (const tool of expect.requiredTools) {
    add(`required_tool:${tool}`, called.has(tool), called.has(tool) ? 'called' : 'not called');
  }
  for (const tool of expect.forbiddenTools) {
    add(`forbidden_tool:${tool}`, !called.has(tool), called.has(tool) ? 'was called' : 'not called');
  }

  const summary = `${run.summary}\n${run.finish?.summary ?? ''}`.toLowerCase();
  for (const needle of expect.summaryContains) {
    add(`summary_contains:${needle}`, summary.includes(needle.toLowerCase()), summary.includes(needle.toLowerCase()) ? 'found' : 'missing');
  }

  if (run.status !== 'completed') {
    add('run_error', false, run.error ? `${run.error.code}: ${run.error.message}` : `status ${run.status}`);
  }

  return results;
}

export function assertionsPassed(results: AssertionResult[]): boolean {
  return results.every((result) => result.severity !== 'error' || result.ok);
}
