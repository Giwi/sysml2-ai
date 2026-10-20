import { join } from 'node:path';
import type { LlmProvider } from '../agent/provider.ts';
import type { WorkspaceEngine } from '../engine/engine.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { TraceRecorder } from '../observability/trace.ts';
import { Supervisor } from './supervisor.ts';
import type { SupervisionPlan, SupervisionResult, SupervisionTask } from './supervisor.ts';

export interface PipelineOptions {
  engine: WorkspaceEngine;
  objective: string;
  providerFactory: (task: SupervisionTask, attempt: number) => LlmProvider | Promise<LlmProvider>;
  analysisGoals?: string[];
  editGoal: string;
  evaluationGoal: string;
  targetFiles?: string[];
  maxRepairRounds?: number;
  concurrency?: number;
  tracer: TraceRecorder;
  metrics?: Metrics;
  signal?: AbortSignal;
  dryRun?: boolean;
  checkpointDir?: string;
  resume?: boolean;
  /** Optional extra context for the first editor task. */
  editContext?: string;
}

export interface PipelinePhase {
  round: number;
  analysis?: SupervisionResult;
  edit: SupervisionResult;
  /** Absent when the editor failed before an independent evaluation. */
  evaluation?: SupervisionResult;
  verdict?: string;
  findings?: string[];
}

export interface PipelineResult {
  objective: string;
  status: 'passed' | 'failed' | 'inconclusive' | 'cancelled' | 'error';
  rounds: number;
  phases: PipelinePhase[];
  finalRevision: string;
  durationMs: number;
}

/**
 * Autonomous analyse -> edit -> evaluate loop with bounded repair rounds.
 * Analysis tasks run in parallel; writes are serialised by the supervisor.
 * The evaluator is independent (read-only) and gates the result.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const started = performance.now();
  const phases: PipelinePhase[] = [];
  const maxRounds = Math.max(0, options.maxRepairRounds ?? 1);
  const checkpointDir = options.checkpointDir;
  let verdict: string | undefined;
  let findings: string[] = [];
  let status: PipelineResult['status'] = 'inconclusive';

  const base = {
    engine: options.engine,
    providerFactory: options.providerFactory,
    tracer: options.tracer,
    metrics: options.metrics,
    signal: options.signal,
    dryRun: options.dryRun,
    resume: options.resume,
  };

  for (let round = 0; round <= maxRounds; round += 1) {
    if (options.signal?.aborted) {
      status = 'cancelled';
      break;
    }

    let analysis: SupervisionResult | undefined;
    if (round === 0 && options.analysisGoals?.length) {
      const tasks: SupervisionTask[] = options.analysisGoals.map((goal, index) => ({
        id: `analysis-${index + 1}`,
        role: 'analyst',
        goal,
        context: options.objective,
      }));
      const plan: SupervisionPlan = {
        id: `pipeline-analysis-${round}`,
        tasks,
        maxConcurrency: options.concurrency ?? 4,
      };
      analysis = await new Supervisor({
        ...base,
        ...(checkpointDir ? { checkpointFile: join(checkpointDir, `${plan.id}.json`) } : {}),
      }).run(plan);
      if (analysis.status === 'cancelled') {
        status = 'cancelled';
        break;
      }
    }

    const editGoal =
      round === 0
        ? options.editGoal
        : `${options.editGoal}\n\nThe independent evaluator rejected the previous attempt. Repair these findings:\n${findings
            .map((finding) => `- ${finding}`)
            .join('\n') || '- see evaluator findings'}`;
    const editTask: SupervisionTask = {
      id: `edit-${round}`,
      role: 'editor',
      goal: editGoal,
      context: [
        options.objective,
        ...(analysis ? summarizeAnalysis(analysis) : []),
        ...(round > 0 ? [`Previous verdict: ${verdict ?? 'unknown'}`] : []),
        ...(options.editContext ? [options.editContext] : []),
      ].join('\n'),
      ...(options.targetFiles?.length ? { targetFiles: options.targetFiles } : {}),
    };
    const editPlan: SupervisionPlan = {
      id: `pipeline-edit-${round}`,
      tasks: [editTask],
      maxConcurrency: 1,
      maxWriteConcurrency: 1,
    };
    const edit = await new Supervisor({
      ...base,
      ...(checkpointDir ? { checkpointFile: join(checkpointDir, `${editPlan.id}.json`) } : {}),
    }).run(editPlan);

    if (edit.status === 'cancelled') {
      status = 'cancelled';
      break;
    }
    if (edit.status !== 'completed') {
      status = 'error';
      phases.push({ round, ...(analysis ? { analysis } : {}), edit });
      break;
    }

    const evalTask: SupervisionTask = {
      id: `evaluate-${round}`,
      role: 'evaluator',
      goal: options.evaluationGoal,
      context: [
        `Objective: ${options.objective}`,
        `Editor summary: ${edit.tasks[editTask.id]?.result?.summary ?? '(none)'}`,
        `Model revision after edit: ${options.engine.index().revision}`,
      ].join('\n'),
    };
    const evalPlan: SupervisionPlan = {
      id: `pipeline-evaluate-${round}`,
      tasks: [evalTask],
      maxConcurrency: 1,
    };
    const evaluation = await new Supervisor({
      ...base,
      ...(checkpointDir ? { checkpointFile: join(checkpointDir, `${evalPlan.id}.json`) } : {}),
    }).run(evalPlan);

    const evalRun = evaluation.tasks[evalTask.id]?.result;
    verdict = evalRun?.finish?.verdict;
    findings = (evalRun?.finish?.findings ?? []).map(
      (finding) => `[${finding.severity}] ${finding.code}: ${finding.message}${finding.evidence.length ? ` (${finding.evidence.join('; ')})` : ''}`
    );
    phases.push({ round, ...(analysis ? { analysis } : {}), edit, evaluation, ...(verdict ? { verdict } : {}), findings });

    if (evaluation.status === 'cancelled') {
      status = 'cancelled';
      break;
    }
    if (verdict === 'pass') {
      status = 'passed';
      break;
    }
    if (round === maxRounds) {
      status = verdict === 'inconclusive' || verdict === undefined ? 'inconclusive' : 'failed';
      break;
    }
  }

  return {
    objective: options.objective,
    status,
    rounds: phases.length,
    phases,
    finalRevision: options.engine.index().revision,
    durationMs: Math.round(performance.now() - started),
  };
}

function summarizeAnalysis(result: SupervisionResult): string[] {
  const lines: string[] = ['Analysis findings:'];
  for (const [id, task] of Object.entries(result.tasks)) {
    const run = task.result;
    if (!run) continue;
    lines.push(`- ${id}: ${run.summary || '(no summary)'}`);
  }
  return lines;
}
