import { promises as fs } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fail, makeError, toStructuredError } from '../contracts/errors.ts';
import type { StructuredError } from '../contracts/errors.ts';
import type { AgentBudget, AgentRunResult } from '../agent/loop.ts';
import { runAgent } from '../agent/loop.ts';
import { MockProvider } from '../agent/provider.ts';
import type { LlmProvider, ScriptedStep } from '../agent/provider.ts';
import { roleFor } from '../agent/roles.ts';
import type { AgentRoleName } from '../agent/roles.ts';
import type { WorkspaceEngine } from '../engine/engine.ts';
import { createToolRuntime } from '../tools/index.ts';
import type { Metrics } from '../observability/metrics.ts';
import { TraceRecorder } from '../observability/trace.ts';
import { FileLockManager } from './lock.ts';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export interface SupervisionTask {
  id: string;
  role: AgentRoleName;
  goal: string;
  context?: string;
  dependsOn?: string[];
  /** Files this task may write. All writes serialize unless explicit locks differ. */
  targetFiles?: string[];
  write?: boolean;
  retries?: number;
  retryOn?: 'error' | 'any' | 'never';
  timeoutMs?: number;
  budget?: Partial<AgentBudget>;
  /** Evaluator gate: the task only succeeds with this verdict. */
  requireVerdict?: 'pass' | 'fail' | 'inconclusive';
  critical?: boolean;
  script?: ScriptedStep[];
}

export interface SupervisionPlan {
  id: string;
  tasks: SupervisionTask[];
  maxConcurrency?: number;
  maxWriteConcurrency?: number;
  stopOnFailure?: boolean;
}

export interface TaskState {
  id: string;
  role: AgentRoleName;
  status: TaskStatus;
  attempts: number;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  result?: AgentRunResult;
  error?: StructuredError;
  skippedReason?: string;
}

export interface SupervisionResult {
  runId: string;
  planId: string;
  status: 'completed' | 'failed' | 'partial' | 'cancelled';
  tasks: Record<string, TaskState>;
  durationMs: number;
  startedAt: string;
  endedAt: string;
  traceId: string;
}

export interface SupervisorOptions {
  engine: WorkspaceEngine;
  providerFactory?: (task: SupervisionTask, attempt: number) => LlmProvider | Promise<LlmProvider>;
  tracer?: TraceRecorder;
  metrics?: Metrics;
  signal?: AbortSignal;
  dryRun?: boolean;
  checkpointFile?: string;
  resume?: boolean;
  runId?: string;
  lockOptions?: { timeoutMs?: number; staleMs?: number };
}

interface Checkpoint {
  planHash: string;
  planId: string;
  runId: string;
  updatedAt: string;
  tasks: Record<string, TaskState>;
}

/**
 * Dependency-aware multi-agent supervisor.
 *
 * - read tasks run in parallel, write tasks serialise by default (`maxWriteConcurrency = 1`)
 * - per-task retries with backoff, per-task timeout and cooperative cancellation
 * - checkpoint after every task, resumable on the next process
 * - evaluator gates can fail a task even when the agent run itself completed
 * - failures skip dependants; stopOnFailure halts new launches
 */
export class Supervisor {
  private readonly engine: WorkspaceEngine;
  private readonly tracer: TraceRecorder;
  private readonly locks: FileLockManager;
  private readonly metrics?: Metrics;
  private readonly state: Record<string, TaskState> = {};
  private readonly options: SupervisorOptions;

  constructor(options: SupervisorOptions) {
    this.options = options;
    this.engine = options.engine;
    this.tracer = options.tracer ?? new TraceRecorder({ attributes: { component: 'supervisor' } });
    this.metrics = options.metrics;
    this.locks = new FileLockManager(options.engine.store.root, options.lockOptions);
  }

  async run(plan: SupervisionPlan): Promise<SupervisionResult> {
    validatePlan(plan);
    const runId = this.options.runId ?? `sup_${randomUUID().slice(0, 10)}`;
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const span = this.tracer.startSpan('supervisor.run', { planId: plan.id, runId, tasks: plan.tasks.length });
    const checkpointFile = this.options.checkpointFile;
    const planHash = hashPlan(plan);

    // A Supervisor instance can run several plans; never leak task state
    // between runs, except for the checkpoint explicitly being resumed.
    for (const key of Object.keys(this.state)) {
      delete this.state[key];
    }

    if (checkpointFile && this.options.resume) {
      const checkpoint = await readCheckpoint(checkpointFile);
      if (checkpoint && checkpoint.planHash === planHash) {
        for (const [id, state] of Object.entries(checkpoint.tasks)) {
          if (state.status === 'completed') {
            this.state[id] = state;
          }
        }
        this.tracer.event('supervisor.resume', { checkpointFile, completed: Object.keys(this.state) });
      } else if (checkpoint) {
        this.tracer.event('supervisor.checkpoint_mismatch', { checkpointFile }, 'warn');
      }
    }

    for (const task of plan.tasks) {
      if (!this.state[task.id]) {
        this.state[task.id] = { id: task.id, role: task.role, status: 'pending', attempts: 0 };
      }
    }

    const maxConcurrency = Math.max(1, plan.maxConcurrency ?? 4);
    const maxWrites = Math.max(1, plan.maxWriteConcurrency ?? 1);
    const running = new Map<string, Promise<void>>();
    let runningWrites = 0;
    let stopRequested = false;

    const save = async (): Promise<void> => {
      if (!checkpointFile) return;
      const checkpoint: Checkpoint = {
        planHash,
        planId: plan.id,
        runId,
        updatedAt: new Date().toISOString(),
        tasks: this.state,
      };
      await fs.mkdir(dirname(checkpointFile), { recursive: true });
      const temp = `${checkpointFile}.tmp`;
      await fs.writeFile(temp, JSON.stringify(checkpoint, null, 2), 'utf8');
      await fs.rename(temp, checkpointFile);
    };

    try {
      while (true) {
        if (this.options.signal?.aborted) {
          stopRequested = true;
        }

        // Mark tasks whose dependencies can no longer succeed.
        for (const task of plan.tasks) {
          const state = this.state[task.id];
          if (state.status !== 'pending') continue;
          const blocked = (task.dependsOn ?? []).some((dep) => {
            const depState = this.state[dep];
            return !depState || (depState.status !== 'completed' && depState.status !== 'running' && depState.status !== 'pending');
          });
          if (blocked) {
            state.status = 'skipped';
            state.skippedReason = 'dependency failed or was skipped';
            state.endedAt = new Date().toISOString();
            this.tracer.event('supervisor.task_skipped', { task: task.id, reason: state.skippedReason }, 'warn');
            await save();
          }
        }

        if (!stopRequested) {
          for (const task of plan.tasks) {
            if (running.size >= maxConcurrency) break;
            const state = this.state[task.id];
            if (state.status !== 'pending') continue;
            const deps = task.dependsOn ?? [];
            if (!deps.every((dep) => this.state[dep]?.status === 'completed')) continue;
            const write = task.write ?? task.role === 'editor';
            if (write && runningWrites >= maxWrites) continue;

            state.status = 'running';
            state.startedAt = new Date().toISOString();
            const taskStarted = performance.now();
            if (write) runningWrites += 1;

            const promise = this.runTask(task, runId)
              .then(async (outcome) => {
                const taskState = this.state[task.id];
                taskState.status = outcome.ok ? 'completed' : 'failed';
                taskState.attempts = outcome.attempts;
                taskState.endedAt = new Date().toISOString();
                taskState.durationMs = Math.round(performance.now() - taskStarted);
                if (outcome.result) taskState.result = outcome.result;
                if (outcome.error) taskState.error = outcome.error;
                if (!outcome.ok && task.critical !== false && plan.stopOnFailure) {
                  stopRequested = true;
                }
                this.tracer.event('supervisor.task_end', {
                  task: task.id,
                  status: taskState.status,
                  attempts: outcome.attempts,
                  durationMs: taskState.durationMs,
                }, outcome.ok ? 'info' : 'error');
                await save();
              })
              .catch(async (thrown) => {
                const taskState = this.state[task.id];
                taskState.status = 'failed';
                taskState.endedAt = new Date().toISOString();
                taskState.durationMs = Math.round(performance.now() - taskStarted);
                taskState.error = makeError('INTERNAL', thrown instanceof Error ? thrown.message : String(thrown));
                await save();
              })
              .finally(() => {
                running.delete(task.id);
                if (write) runningWrites -= 1;
              });
            running.set(task.id, promise);
            this.tracer.event('supervisor.task_start', { task: task.id, role: task.role, write });
          }
        }

        if (running.size === 0) {
          const pending = plan.tasks.filter((task) => this.state[task.id].status === 'pending');
          if (pending.length === 0 || stopRequested) {
            for (const task of pending) {
              this.state[task.id].status = 'cancelled';
              this.state[task.id].endedAt = new Date().toISOString();
              this.state[task.id].skippedReason = stopRequested ? 'run cancelled' : 'unreachable';
            }
            break;
          }
          // No running task and no ready task: dependency cycle should have been
          // caught, so mark the rest cancelled rather than loop forever.
          if (!plan.tasks.some((task) => this.state[task.id].status === 'pending')) {
            break;
          }
          const ready = plan.tasks.some((task) => {
            const state = this.state[task.id];
            return (
              state.status === 'pending' &&
              (task.dependsOn ?? []).every((dep) => this.state[dep]?.status === 'completed')
            );
          });
          if (!ready) {
            for (const task of pending) {
              this.state[task.id].status = 'skipped';
              this.state[task.id].skippedReason = 'unreachable dependency graph';
            }
            break;
          }
        }

        await Promise.race([...running.values()]);
      }
    } finally {
      if (running.size > 0) {
        await Promise.allSettled([...running.values()]);
      }
    }

    await save();
    const states = plan.tasks.map((task) => this.state[task.id]);
    const failed = states.some((state) => state.status === 'failed');
    const cancelled = this.options.signal?.aborted === true || states.some((state) => state.status === 'cancelled');
    const skipped = states.some((state) => state.status === 'skipped');
    const status: SupervisionResult['status'] = failed
      ? 'failed'
      : cancelled
        ? 'cancelled'
        : skipped
          ? 'partial'
          : 'completed';
    const durationMs = Math.round(performance.now() - started);
    const endedAt = new Date().toISOString();

    const result: SupervisionResult = {
      runId,
      planId: plan.id,
      status,
      tasks: Object.fromEntries(plan.tasks.map((task) => [task.id, this.state[task.id]])),
      durationMs,
      startedAt,
      endedAt,
      traceId: this.tracer.traceId,
    };
    this.metrics?.inc('supervisor_runs_total', 1, { plan: plan.id, status });
    this.metrics?.observe('supervisor_duration_ms', durationMs, { plan: plan.id });
    this.tracer.event('supervisor.end', { status, durationMs }, status === 'completed' ? 'info' : 'warn');
    span.end(status === 'completed' ? 'ok' : 'error', { status });
    return result;
  }

  stateOf(taskId: string): TaskState | undefined {
    return this.state[taskId];
  }

  /**
   * Execute one task with its own timeout, lock and retry budget. A retry
   * starts a fresh agent run and provider; the transaction journal stays the
   * source of truth for what actually reached the model.
   */
  private async runTask(
    task: SupervisionTask,
    runId: string
  ): Promise<{ ok: boolean; attempts: number; result?: AgentRunResult; error?: StructuredError }> {
    const role = roleFor(task.role);
    const maxAttempts = Math.max(1, (task.retries ?? 0) + 1);
    const retryOn = task.retryOn ?? 'error';
    let lastResult: AgentRunResult | undefined;
    let lastError: StructuredError | undefined;
    let attemptsMade = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attemptsMade = attempt;
      if (this.options.signal?.aborted) {
        return {
          ok: false,
          attempts: attempt - 1,
          ...(lastError ? { error: lastError } : { error: makeError('CANCELLED', 'Supervisor cancelled') }),
        };
      }
      const timeoutMs = task.timeoutMs ?? role.budget.maxWallClockMs;
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = this.options.signal
        ? AbortSignal.any([this.options.signal, timeout])
        : timeout;
      const write = task.write ?? task.role === 'editor';
      const lockKeys = write ? (task.targetFiles?.length ? task.targetFiles : ['__workspace_write__']) : [];
      let release: (() => Promise<void>) | undefined;
      try {
        if (lockKeys.length > 0) {
          const lock = await this.locks.acquireMany(lockKeys, signal);
          release = lock.release;
        }
        const provider = await this.providerFor(task, attempt);
        const runtime = createToolRuntime(this.engine, {
          actor: `supervisor:${task.id}`,
          tracer: this.tracer,
          capabilities: role.capabilities,
          dryRun: this.options.dryRun ?? false,
          metrics: this.metrics,
          signal,
        });
        const context = [
          task.context,
          `Supervisor plan: ${runId}`,
          `Task: ${task.id} (attempt ${attempt}/${maxAttempts})`,
          task.targetFiles?.length ? `Target files: ${task.targetFiles.join(', ')}` : undefined,
        ]
          .filter(Boolean)
          .join('\n');

        const result = await runAgent({
          role: task.role,
          goal: task.goal,
          context,
          provider,
          runtime,
          tracer: this.tracer,
          budget: { ...role.budget, ...task.budget },
          signal,
          metrics: this.metrics,
        });
        lastResult = result;

        const verdict = result.finish?.verdict;
        const verdictOk = !task.requireVerdict || verdict === task.requireVerdict;
        if (result.status === 'completed' && verdictOk) {
          return { ok: true, attempts: attempt, result };
        }
        if (result.status === 'completed' && !verdictOk) {
          lastError = makeError('VALIDATION_FAILED', `Evaluator verdict '${verdict ?? 'missing'}' did not meet '${task.requireVerdict}'`, {
            details: { task: task.id, verdict, findings: result.finish?.findings },
            suggestions: ['Inspect the evaluator findings and plan a repair task'],
          });
        } else {
          lastError =
            result.error ??
            makeError('INTERNAL', `Agent task ended with status '${result.status}'`, {
              details: { task: task.id, status: result.status },
            });
        }
      } catch (thrown) {
        const structured = toStructuredError(thrown);
        lastError = makeError(structured.code, structured.message, {
          details: structured.details ?? { task: task.id, attempt },
          retryable: structured.retryable,
        });
      } finally {
        if (release) {
          await release();
        }
      }

      const retryable = lastError?.retryable === true || retryOn === 'any';
      if (retryOn === 'never' || !retryable || attempt >= maxAttempts) {
        break;
      }
      this.tracer.event(
        'supervisor.task_retry',
        { task: task.id, attempt, nextAttempt: attempt + 1, error: lastError },
        'warn'
      );
      await sleep(500 * attempt);
    }

    return {
      ok: false,
      attempts: attemptsMade,
      ...(lastResult ? { result: lastResult } : {}),
      ...(lastError ? { error: lastError } : { error: makeError('INTERNAL', `Task '${task.id}' failed`) }),
    };
  }

  private async providerFor(task: SupervisionTask, attempt: number): Promise<LlmProvider> {
    if (task.script) {
      return new MockProvider(task.script);
    }
    if (!this.options.providerFactory) {
      fail('INVALID_OPERATION', `No provider configured for task '${task.id}'`, {
        suggestions: ['Pass providerFactory or a scripted task'],
      });
    }
    return this.options.providerFactory(task, attempt);
  }
}

function validatePlan(plan: SupervisionPlan): void {
  if (plan.tasks.length === 0) {
    fail('INVALID_INPUT', 'Supervision plan has no tasks');
  }
  const ids = new Set<string>();
  for (const task of plan.tasks) {
    if (ids.has(task.id)) {
      fail('INVALID_INPUT', `Duplicate task id: ${task.id}`);
    }
    ids.add(task.id);
  }
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!ids.has(dep)) {
        fail('INVALID_INPUT', `Task '${task.id}' depends on unknown task '${dep}'`);
      }
    }
  }
  // Kahn cycle detection.
  const indegree = new Map(plan.tasks.map((task) => [task.id, (task.dependsOn ?? []).length]));
  const dependants = new Map<string, string[]>();
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn ?? []) {
      dependants.set(dep, [...(dependants.get(dep) ?? []), task.id]);
    }
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const next of dependants.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  if (visited !== plan.tasks.length) {
    fail('INVALID_INPUT', 'Supervision plan contains a dependency cycle', {
      details: { tasks: plan.tasks.map((task) => task.id) },
    });
  }
}

function hashPlan(plan: SupervisionPlan): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: plan.id,
        tasks: plan.tasks.map((task) => ({
          id: task.id,
          role: task.role,
          goal: task.goal,
          context: task.context ?? '',
          dependsOn: task.dependsOn ?? [],
          targetFiles: task.targetFiles ?? [],
          write: task.write,
          retries: task.retries ?? 0,
          retryOn: task.retryOn ?? 'error',
          timeoutMs: task.timeoutMs,
          budget: task.budget ?? {},
          requireVerdict: task.requireVerdict,
          critical: task.critical,
          script: task.script,
        })),
      })
    )
    .digest('hex')
    .slice(0, 16);
}

async function readCheckpoint(file: string): Promise<Checkpoint | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Checkpoint;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
