import { z } from 'zod';

export const positionSchema = z.object({
  line: z.number().int().min(0).describe('0-based line number'),
  character: z.number().int().min(0).describe('0-based character offset'),
});

export const rangeSchema = z.object({
  start: positionSchema,
  end: positionSchema,
});

export const replaceOpSchema = z.object({
  type: z.literal('replace'),
  uri: z.string(),
  range: rangeSchema,
  text: z.string(),
});

export const issueSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  uri: z.string(),
  range: rangeSchema.optional(),
  qname: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const numberedIssuesSchema = z.object({
  count: z.number().int(),
  items: z.array(issueSchema),
  truncated: z.boolean().optional(),
});

export const validationReportSchema = z.object({
  valid: z.boolean(),
  revision: z.string(),
  errors: numberedIssuesSchema,
  warnings: numberedIssuesSchema,
  unresolvedReferences: z.number().int(),
  filesChecked: z.number().int(),
  elementsChecked: z.number().int(),
});

export const elementSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string().optional(),
  qname: z.string(),
  kind: z.string(),
  uri: z.string(),
  parentQname: z.string().optional(),
  range: rangeSchema,
  childrenCount: z.number().int(),
});

export const referenceViewSchema = z.object({
  kind: z.string(),
  text: z.string(),
  uri: z.string(),
  range: rangeSchema,
  targetQname: z.string().optional(),
  resolved: z.boolean(),
});

export const incomingReferenceSchema = z.object({
  uri: z.string(),
  range: rangeSchema,
  text: z.string(),
  kind: z.string(),
  sourceLine: z.string(),
});

export const elementViewSchema = elementSummarySchema.extend({
  children: z.array(elementSummarySchema),
  refs: z.array(referenceViewSchema),
  source: z.string(),
  incomingReferences: z.array(incomingReferenceSchema),
});

export const fileInfoSchema = z.object({
  uri: z.string(),
  revision: z.string(),
  bytes: z.number().int(),
  elementCount: z.number().int(),
  errorCount: z.number().int(),
});

export const mutationResultSchema = z.object({
  transactionId: z.string(),
  revision: z.string(),
  dryRun: z.boolean(),
  qname: z.string().optional(),
  operation: z.string(),
  description: z.string(),
  changedFiles: z.array(
    z.object({
      uri: z.string(),
      beforeRevision: z.string(),
      afterRevision: z.string(),
      added: z.number().int(),
      removed: z.number().int(),
    })
  ),
  diagnostics: validationReportSchema,
  details: z.record(z.string(), z.unknown()).optional(),
});
