import { z } from 'zod';
import { defineTool } from '../contracts/tool.ts';

export const findingSchema = z.object({
  code: z.string().describe('Stable finding code, e.g. MISSING_REQUIREMENT or UNRESOLVED_REFERENCE'),
  message: z.string(),
  severity: z.enum(['info', 'warning', 'error']).default('info'),
  evidence: z.array(z.string()).default([]).describe('Tool names, qnames, file:line, observed values'),
});

export const finishInputSchema = z.object({
  summary: z.string().describe('What was done or concluded, with qnames and revisions'),
  verdict: z.enum(['pass', 'fail', 'inconclusive']).optional().describe('Required for evaluator runs'),
  findings: z.array(findingSchema).default([]),
  claims: z.array(z.string()).default([]).describe('Atomic claims supported by tool output'),
  confidence: z.number().min(0).max(1).optional(),
});

export type FinishPayload = z.infer<typeof finishInputSchema>;

export const finishTool = defineTool(
  {
    name: 'agent.finish',
    description:
      'End the agent run. Provide a grounded summary, optional verdict/findings/claims. This is the only valid way to finish.',
    input: finishInputSchema,
    output: z.object({ accepted: z.literal(true) }),
    capabilities: [],
    sideEffect: 'none',
    timeoutMs: 1_000,
    idempotent: true,
    tags: ['agent', 'control'],
  },
  () => ({ accepted: true as const })
);
