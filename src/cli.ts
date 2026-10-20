import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkspaceEngine } from './engine/engine.ts';
import { allTools, createToolRuntime } from './tools/index.ts';
import { runAgent } from './agent/loop.ts';
import { MockProvider, OllamaProvider, listOllamaModels } from './agent/provider.ts';
import { roleFor } from './agent/roles.ts';
import type { AgentRoleName } from './agent/roles.ts';
import { TraceRecorder } from './observability/trace.ts';
import { Metrics } from './observability/metrics.ts';
import { startMetricsServer, pushToPushgateway } from './observability/prometheus.ts';
import { runEvaluation } from './eval/runner.ts';
import { Supervisor } from './orchestration/supervisor.ts';
import type { SupervisionPlan } from './orchestration/supervisor.ts';
import { toolSchema } from './contracts/tool.ts';

const HELP = `sysml-ai: agentic SysML v2 modelling

Usage:
  node src/cli.ts tools [--role analyst|editor|evaluator] [--json]
  node src/cli.ts agent --dir <model-dir> --role <role> --goal <text> [--provider ollama|mock] [--model <name>] [--script <file>] [--dry-run]
  node src/cli.ts eval [--scenarios <dir>] [--fixtures <dir>] [--out <dir>] [--provider mock|ollama] [--model <name>] [--concurrency 2] [--tags a,b] [--ids a,b] [--update-baseline] [--keep-artifacts]
  node src/cli.ts supervise --dir <model-dir> --plan <plan.json> [--provider ollama|mock] [--model <name>] [--checkpoint <file>] [--resume] [--dry-run]
  node src/cli.ts mcp --dir <model-dir>
  node src/cli.ts doctor [--model <name>]

Prometheus (agent, eval, supervise):
  --pushgateway <url>   Pushgateway base URL, e.g. http://127.0.0.1:9091
  --push-job <name>     default sysml-ai-<command>
  --push-instance <id>  default hostname

MCP scrape endpoint (long-running server only):
  --metrics-port <port>  0 picks a free port
  --metrics-host <host>  default 127.0.0.1

Environment:
  OLLAMA_HOST       default http://127.0.0.1:11434
  OLLAMA_MODEL      default qwen2.5-coder:7b
  PUSHGATEWAY_URL   default for --pushgateway
`;

interface Args {
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue; // positional words are not used by any command
    }
    const [rawKey, inline] = arg.slice(2).split('=', 2);
    const key = rawKey.startsWith('no-') ? rawKey.slice(3) : rawKey;
    if (inline !== undefined) {
      flags[key] = inline;
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = rawKey.startsWith('no-') ? false : true;
      }
    }
  }
  return { flags };
}

function str(flags: Record<string, string | boolean>, key: string, fallback?: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : fallback;
}

function bool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === 'true';
}

interface ActiveMetrics {
  metrics: Metrics;
  close(): Promise<void>;
}

interface RunMetrics {
  metrics: Metrics;
  finish(): Promise<void>;
}

/**
 * Short-lived agents cannot be scraped reliably: they push at the end of the
 * run to a Prometheus Pushgateway. The endpoint remains available for the
 * long-running MCP server only.
 */
function startRunMetrics(args: Args, component: 'agent' | 'eval' | 'supervise'): RunMetrics {
  const metrics = new Metrics();
  const url = str(args.flags, 'pushgateway', process.env.PUSHGATEWAY_URL);
  return {
    metrics,
    finish: async () => {
      if (!url) {
        return;
      }
      try {
        const pushed = await pushToPushgateway(metrics, {
          url,
          job: str(args.flags, 'push-job', `sysml-ai-${component}`)!,
          instance: str(args.flags, 'push-instance', hostname())!,
          labels: { component },
          timeoutMs: 5_000,
        });
        if (pushed.bytes > 0) {
          process.stderr.write(`Pushed ${pushed.bytes} bytes of metrics to ${pushed.url}\n`);
        }
      } catch (error) {
        // Observability must never mask a successful model edit or evaluation.
        process.stderr.write(`Metrics push failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    },
  };
}

/** Prometheus scrape endpoint for the long-running MCP server. */
async function startMetricsEndpoint(args: Args): Promise<ActiveMetrics> {
  const metrics = new Metrics();
  const portValue = str(args.flags, 'metrics-port');
  if (portValue === undefined) {
    return { metrics, close: async () => undefined };
  }
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --metrics-port: ${portValue}`);
  }
  const server = await startMetricsServer(metrics, {
    port,
    host: str(args.flags, 'metrics-host', '127.0.0.1'),
  });
  process.stderr.write(`Prometheus metrics: ${server.url}\n`);
  return { metrics, close: () => server.close() };
}

async function main(): Promise<void> {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;
    case 'tools':
      await toolsCommand(args);
      return;
    case 'agent':
      await agentCommand(args);
      return;
    case 'eval':
      await evalCommand(args);
      return;
    case 'supervise':
      await superviseCommand(args);
      return;
    case 'mcp':
      await mcpCommand(args);
      return;
    case 'doctor':
      await doctorCommand(args);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

async function toolsCommand(args: Args): Promise<void> {
  const role = (str(args.flags, 'role', 'editor') as AgentRoleName) ?? 'editor';
  const config = roleFor(role);
  const visible = allTools
    .filter((tool) => tool.contract.capabilities.every((cap) => config.capabilities.includes(cap)))
    .map((tool) => toolSchema(tool as never));
  if (bool(args.flags, 'json')) {
    process.stdout.write(`${JSON.stringify(visible, null, 2)}\n`);
    return;
  }
  for (const tool of visible) {
    process.stdout.write(`${tool.name.padEnd(28)} [${tool.sideEffect}] ${tool.description}\n`);
  }
  process.stdout.write(`\n${visible.length} tool(s) visible to role '${role}'.\n`);
}

async function agentCommand(args: Args): Promise<void> {
  const dir = str(args.flags, 'dir', '.')!;
  const role = (str(args.flags, 'role', 'editor') as AgentRoleName) ?? 'editor';
  const goal = str(args.flags, 'goal');
  if (!goal) {
    throw new Error('Missing --goal');
  }
  const providerKind = str(args.flags, 'provider', 'ollama');
  const model = str(args.flags, 'model');
  const provider =
    providerKind === 'mock'
      ? new MockProvider(JSON.parse(await fs.readFile(required(str(args.flags, 'script'), '--script'), 'utf8')))
      : new OllamaProvider({ model });
  const engine = await WorkspaceEngine.open(dir);
  const runId = `cli_${randomUUID().slice(0, 8)}`;
  const tracerFile = join(engine.store.root, '.sysml-ai', 'traces', `${runId}.jsonl`);
  const tracer = new TraceRecorder({ runId, file: tracerFile, attributes: { component: 'cli', role } });
  const active = startRunMetrics(args, 'agent');
  try {
    const runtime = createToolRuntime(engine, {
      actor: `cli:${role}`,
      tracer,
      capabilities: roleFor(role).capabilities,
      dryRun: bool(args.flags, 'dry-run'),
      metrics: active.metrics,
    });
    const result = await runAgent({
      role,
      goal,
      provider,
      runtime,
      tracer,
      metrics: active.metrics,
      context: str(args.flags, 'context'),
      budget: {
        ...(str(args.flags, 'max-steps') ? { maxSteps: Number(str(args.flags, 'max-steps')) } : {}),
        ...(str(args.flags, 'max-tool-calls') ? { maxToolCalls: Number(str(args.flags, 'max-tool-calls')) } : {}),
      },
    });
    process.stdout.write(`${JSON.stringify({ ...result, traceFile: tracerFile }, null, 2)}\n`);
    if (result.status !== 'completed') {
      process.exitCode = 1;
    }
  } finally {
    await active.finish();
  }
}

async function evalCommand(args: Args): Promise<void> {
  const provider = (str(args.flags, 'provider', 'mock') as 'mock' | 'ollama') ?? 'mock';
  const active = startRunMetrics(args, 'eval');
  try {
    const report = await runEvaluation({
      scenariosDir: str(args.flags, 'scenarios', join(process.cwd(), 'eval', 'scenarios'))!,
      fixturesDir: str(args.flags, 'fixtures', join(process.cwd(), 'eval', 'fixtures'))!,
      outDir: str(args.flags, 'out', join(process.cwd(), 'eval', 'reports'))!,
      provider,
      model: str(args.flags, 'model'),
      concurrency: str(args.flags, 'concurrency') ? Number(str(args.flags, 'concurrency')) : 2,
      filterTags: csv(str(args.flags, 'tags')),
      filterIds: csv(str(args.flags, 'ids')),
      updateBaseline: bool(args.flags, 'update-baseline'),
      keepArtifacts: bool(args.flags, 'keep-artifacts'),
      metrics: active.metrics,
    });
    process.stdout.write(
      `${JSON.stringify({ summary: report.summary, reportDir: report.reportDir, baseline: report.baseline }, null, 2)}\n`
    );
    if (report.summary.failed > 0 || report.baseline.regressions.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await active.finish();
  }
}

async function superviseCommand(args: Args): Promise<void> {
  const dir = str(args.flags, 'dir', '.')!;
  const planPath = required(str(args.flags, 'plan'), '--plan');
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as SupervisionPlan;
  const providerKind = str(args.flags, 'provider', 'ollama');
  const model = str(args.flags, 'model');
  const engine = await WorkspaceEngine.open(dir);
  const tracerFile = join(engine.store.root, '.sysml-ai', 'traces', `supervise-${randomUUID().slice(0, 8)}.jsonl`);
  const tracer = new TraceRecorder({ file: tracerFile, attributes: { component: 'cli-supervisor' } });
  const active = startRunMetrics(args, 'supervise');
  try {
    const supervisor = new Supervisor({
      engine,
      tracer,
      metrics: active.metrics,
      dryRun: bool(args.flags, 'dry-run'),
      ...(str(args.flags, 'checkpoint') ? { checkpointFile: str(args.flags, 'checkpoint') } : {}),
      resume: bool(args.flags, 'resume'),
      providerFactory: (task) => {
        if (providerKind === 'mock') {
          if (!task.script) {
            throw new Error(`Task '${task.id}' has no script and provider is mock`);
          }
          return new MockProvider(task.script);
        }
        return new OllamaProvider({ model });
      },
    });
    const result = await supervisor.run(plan as SupervisionPlan);
    process.stdout.write(`${JSON.stringify({ ...result, traceFile: tracerFile }, null, 2)}\n`);
    if (result.status !== 'completed') {
      process.exitCode = 1;
    }
  } finally {
    await active.finish();
  }
}

async function mcpCommand(args: Args): Promise<void> {
  const dir = str(args.flags, 'dir', '.')!;
  const active = await startMetricsEndpoint(args);
  const { startMcpServer, defaultTraceFile } = await import('./mcp/server.ts');
  try {
    await startMcpServer({ root: dir, traceFile: defaultTraceFile(dir), metrics: active.metrics });
  } catch (error) {
    await active.close();
    throw error;
  }
}

async function doctorCommand(args: Args): Promise<void> {
  try {
    const models = await listOllamaModels();
    process.stdout.write(`Ollama reachable. Models: ${models.length ? models.join(', ') : '(none pulled)'}\n`);
    const wanted = str(args.flags, 'model', process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:7b')!;
    if (!models.includes(wanted) && !models.some((m) => m.startsWith(`${wanted}:`))) {
      process.stdout.write(`Model '${wanted}' is not pulled. Run: ollama pull ${wanted}\n`);
    }
  } catch (error) {
    process.stderr.write(`Ollama unavailable: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === '') {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function csv(value: string | undefined): string[] | undefined {
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : undefined;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
