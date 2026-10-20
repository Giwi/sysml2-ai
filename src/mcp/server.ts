import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WorkspaceEngine } from '../engine/engine.ts';
import { allTools, createToolRuntime } from '../tools/index.ts';
import { TraceRecorder } from '../observability/trace.ts';
import type { Metrics } from '../observability/metrics.ts';
import { resolve, join } from 'node:path';

export interface McpServerOptions {
  root: string;
  actor?: string;
  dryRun?: boolean;
  traceFile?: string;
  metrics?: Metrics;
}

/**
 * MCP adapter over the same tool catalog used by the in-process agents.
 * The engine remains the only component touching the model; MCP clients get
 * exactly the typed contracts, structured errors and transaction semantics.
 */
export async function startMcpServer(options: McpServerOptions): Promise<void> {
  const engine = await WorkspaceEngine.open(options.root);
  const tracer = new TraceRecorder({
    ...(options.traceFile ? { file: options.traceFile } : {}),
    attributes: { component: 'mcp' },
  });
  const runtime = createToolRuntime(engine, {
    actor: options.actor ?? 'mcp',
    tracer,
    capabilities: ['read', 'write', 'analyze', 'eval'],
    dryRun: options.dryRun ?? false,
    ...(options.metrics ? { metrics: options.metrics } : {}),
  });

  const server = new McpServer({
    name: 'sysml-ai',
    version: '0.1.0',
  });

  let registered = 0;
  for (const tool of allTools) {
    const mcpName = tool.contract.name.replaceAll('.', '__');
    registered += 1;
    const input = tool.contract.input;
    const shape = input instanceof z.ZodObject ? input.shape : {};
    server.registerTool(
      mcpName,
      {
        title: tool.contract.name,
        description: tool.contract.description,
        inputSchema: shape,
        annotations: {
          readOnlyHint: tool.contract.sideEffect !== 'write',
          destructiveHint: tool.contract.name.includes('delete'),
          idempotentHint: tool.contract.idempotent,
        },
      },
      async (args: Record<string, unknown>) => {
        const result = await runtime.call(tool.contract.name, args);
        if (result.ok) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result.data) }],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify(result.error) }],
        };
      }
    );
  }

  process.stderr.write(
    `sysml-ai MCP server: ${registered} tools on ${engine.store.root} (${engine.snapshotInfo().revision})\n`
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function defaultTraceFile(root: string): string {
  return join(resolve(root), '.sysml-ai', 'traces', 'mcp.jsonl');
}
