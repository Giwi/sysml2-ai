import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { AssertionResult } from './assertions.ts';

export interface BaselineEntry {
  ok: boolean;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  durationMs: number;
  tokens: number;
}

export interface Baseline {
  version: 1;
  generatedAt: string;
  scenarios: Record<string, BaselineEntry>;
}

export interface BaselineTolerance {
  steps: number;
  toolCalls: number;
  durationFactor: number;
  durationSlackMs: number;
  tokenFactor: number;
  tokenSlack: number;
}

export const DEFAULT_TOLERANCE: BaselineTolerance = {
  steps: 2,
  toolCalls: 2,
  durationFactor: 1.5,
  durationSlackMs: 5_000,
  tokenFactor: 1.25,
  tokenSlack: 500,
};

export async function readBaseline(file: string): Promise<Baseline | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Baseline;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function writeBaseline(file: string, scenarios: Record<string, BaselineEntry>): Promise<Baseline> {
  const baseline: Baseline = {
    version: 1,
    generatedAt: new Date().toISOString(),
    scenarios,
  };
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  return baseline;
}

export function compareToBaseline(
  id: string,
  current: BaselineEntry,
  baseline: Baseline | undefined,
  tolerance: BaselineTolerance = DEFAULT_TOLERANCE
): AssertionResult[] {
  const previous = baseline?.scenarios[id];
  const results: AssertionResult[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    results.push({ name: `non_regression:${name}`, ok, severity: 'error', detail });
  };

  if (!previous) {
    results.push({
      name: 'non_regression:new',
      ok: true,
      severity: 'warning',
      detail: 'no baseline entry (run with --update-baseline to record one)',
    });
    return results;
  }

  if (previous.ok && !current.ok) {
    add('success', false, 'scenario used to pass and now fails');
  } else {
    add('success', true, `baseline ok=${previous.ok}, current ok=${current.ok}`);
  }
  add(
    'steps',
    current.steps <= previous.steps + tolerance.steps,
    `${current.steps} step(s) vs baseline ${previous.steps} (+${tolerance.steps} allowed)`
  );
  add(
    'tool_calls',
    current.toolCalls <= previous.toolCalls + tolerance.toolCalls,
    `${current.toolCalls} call(s) vs baseline ${previous.toolCalls} (+${tolerance.toolCalls} allowed)`
  );
  const maxDuration = Math.max(previous.durationMs * tolerance.durationFactor, previous.durationMs + tolerance.durationSlackMs);
  add('duration', current.durationMs <= maxDuration, `${current.durationMs}ms vs baseline ${previous.durationMs}ms (max ${Math.round(maxDuration)}ms)`);
  const maxTokens = previous.tokens * tolerance.tokenFactor + tolerance.tokenSlack;
  add('tokens', current.tokens <= maxTokens, `${current.tokens} token(s) vs baseline ${previous.tokens} (max ${Math.round(maxTokens)})`);
  return results;
}
