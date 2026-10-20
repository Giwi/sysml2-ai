import { z } from 'zod';

export const scriptStepSchema = z.object({
  content: z.string().optional(),
  toolCalls: z
    .array(
      z.object({
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .optional(),
});

export const scenarioSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  role: z.enum(['analyst', 'editor', 'evaluator']),
  fixture: z.string().min(1).describe('File or directory under the fixtures root'),
  goal: z.string().min(1),
  context: z.string().optional(),
  targetFiles: z.array(z.string()).optional(),
  budget: z
    .object({
      maxSteps: z.number().int().min(1).optional(),
      maxToolCalls: z.number().int().min(1).optional(),
      maxWallClockMs: z.number().int().min(1).optional(),
      maxTokens: z.number().int().min(1).optional(),
    })
    .optional(),
  provider: z
    .object({
      kind: z.enum(['script', 'ollama']).default('script'),
      model: z.string().optional(),
      temperature: z.number().min(0).max(2).optional(),
    })
    .default({ kind: 'script' }),
  script: z.array(scriptStepSchema).optional().describe('Required when provider.kind is script'),
  expect: z
    .object({
      status: z.enum(['completed', 'budget_exceeded', 'error', 'cancelled']).default('completed'),
      finishRequired: z.boolean().default(true),
      verdict: z.enum(['pass', 'fail', 'inconclusive']).optional(),
      valid: z.boolean().default(true),
      changed: z.boolean().optional(),
      maxSteps: z.number().int().min(0).optional(),
      maxToolCalls: z.number().int().min(0).optional(),
      maxToolErrors: z.number().int().min(0).optional(),
      maxDurationMs: z.number().int().min(0).optional(),
      maxTokens: z.number().int().min(0).optional(),
      maxErrors: z.number().int().min(0).default(0),
      maxUnresolvedReferences: z.number().int().min(0).optional(),
      minElements: z.number().int().min(0).optional(),
      maxElements: z.number().int().min(0).optional(),
      elementsPresent: z.array(z.object({ qname: z.string(), kind: z.string().optional() })).default([]),
      elementsAbsent: z.array(z.string()).default([]),
      requiredTools: z.array(z.string()).default([]),
      forbiddenTools: z.array(z.string()).default([]),
      summaryContains: z.array(z.string()).default([]),
    })
    .prefault({}),
});

export type Scenario = z.infer<typeof scenarioSchema>;

/** Parse and validate one scenario file, with actionable field paths. */
export function parseScenario(value: unknown, source = '<inline>'): Scenario {
  const parsed = scenarioSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`);
    throw new Error(`Invalid scenario ${source}:\n${issues.join('\n')}`);
  }
  if (parsed.data.provider.kind === 'script' && !parsed.data.script?.length) {
    throw new Error(`Scenario ${parsed.data.id}: provider.kind=script requires a non-empty script`);
  }
  return parsed.data;
}
