import { z } from 'zod';
import { defineTool } from '../contracts/tool.ts';
import { fail } from '../contracts/errors.ts';
import type { ToolContext } from '../contracts/tool.ts';
import { suggestNames } from '../engine/index.ts';
import { symbolAtPosition } from '../engine/parser/model.ts';
import type { ModelTransaction, MutationResult } from '../engine/transaction.ts';
import type { CommitResult, EditableKind } from '../engine/types.ts';
import { EDITABLE_KINDS } from '../engine/templates.ts';
import {
  elementSummarySchema,
  elementViewSchema,
  fileInfoSchema,
  mutationResultSchema,
  rangeSchema,
  replaceOpSchema,
  validationReportSchema,
} from './schemas.ts';

const READ = ['read'] as const;
const WRITE = ['read', 'write'] as const;

const qname = z.string().min(1).describe('Fully qualified SysML name, e.g. "VehicleModel::Vehicle"');

export const listFilesTool = defineTool(
  {
    name: 'model.list_files',
    description: 'List SysML/KerML files in the workspace with their revision and element counts.',
    input: z.object({}),
    output: z.object({
      root: z.string(),
      revision: z.string(),
      files: z.array(fileInfoSchema),
      totalElements: z.number().int(),
    }),
    capabilities: [...READ],
    sideEffect: 'read',
    timeoutMs: 10_000,
    idempotent: true,
    tags: ['model', 'read'],
  },
  async (_input, ctx) => {
    const snapshot = ctx.engine.snapshotInfo();
    return {
      root: snapshot.root,
      revision: snapshot.revision,
      files: snapshot.files,
      totalElements: snapshot.files.reduce((sum, file) => sum + file.elementCount, 0),
    };
  }
);

export const listElementsTool = defineTool(
  {
    name: 'model.list_elements',
    description:
      'Search model elements by name, kind, file or qualified-name prefix. Use this before editing to discover exact qnames.',
    input: z.object({
      uri: z.string().optional().describe('Restrict to one file'),
      kind: z.string().optional().describe('Exact element kind, e.g. "Part Definition"'),
      nameContains: z.string().optional(),
      qnamePrefix: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    }),
    output: z.object({
      total: z.number().int(),
      items: z.array(elementSummarySchema),
      revision: z.string(),
    }),
    capabilities: [...READ],
    sideEffect: 'read',
    timeoutMs: 10_000,
    idempotent: true,
    tags: ['model', 'search'],
  },
  (input, ctx) => {
    const index = ctx.engine.index();
    const found = index.find(input);
    return { ...found, revision: index.revision };
  }
);

export const getElementTool = defineTool(
  {
    name: 'model.get_element',
    description:
      'Read one element: qname, kind, source, direct children, outgoing references and incoming references. Provide qname, or uri+line, or name.',
    input: z.object({
      qname: qname.optional(),
      name: z.string().optional().describe('Last name segment when unambiguous'),
      uri: z.string().optional(),
      line: z.number().int().min(0).optional().describe('0-based line for position lookup'),
      character: z.number().int().min(0).default(0),
      sourceLimit: z.number().int().min(100).max(20_000).default(4_000),
    }),
    output: elementViewSchema.extend({ revision: z.string() }),
    capabilities: [...READ],
    sideEffect: 'read',
    timeoutMs: 10_000,
    idempotent: true,
    tags: ['model', 'read'],
  },
  (input, ctx) => {
    const index = ctx.engine.index();
    let entry = input.qname ? index.entryFor(input.qname) : undefined;

    if (!entry && input.uri && input.line !== undefined) {
      const file = index.files.get(input.uri);
      if (!file) {
        fail('FILE_NOT_FOUND', `Unknown model file: ${input.uri}`, {
          details: { available: [...index.files.keys()] },
        });
      }
      const sym = symbolAtPosition(file.model, input.line, input.character);
      if (sym) {
        entry = index.byId.get(sym.id);
      }
    }

    if (!entry && input.name) {
      const matches = index.entriesForName(input.name);
      if (matches.length === 1) {
        entry = matches[0];
      } else if (matches.length > 1) {
        fail('INVALID_INPUT', `Name '${input.name}' is ambiguous (${matches.length} matches)`, {
          details: { candidates: matches.map((m) => m.sym.qname) },
          suggestions: ['Call model.get_element with an exact qname'],
        });
      }
    }

    if (!entry) {
      const suggestions = suggestNames(index, input.qname ?? input.name ?? '');
      fail('ELEMENT_NOT_FOUND', `Element not found: ${input.qname ?? input.name ?? `${input.uri}:${input.line}`}`, {
        details: { suggestions },
        suggestions: suggestions.length
          ? [`Did you mean: ${suggestions.join(', ')}?`, 'Call model.list_elements to search']
          : ['Call model.list_elements to search'],
      });
    }

    return { ...index.elementView(entry, input.sourceLimit), revision: index.revision };
  }
);

export const getSourceTool = defineTool(
  {
    name: 'model.get_source',
    description: 'Read a bounded range of a model file, with 1-based line labels.',
    input: z.object({
      uri: z.string(),
      startLine: z.number().int().min(0).default(0).describe('0-based, inclusive'),
      endLine: z.number().int().min(0).optional().describe('0-based, inclusive'),
    }),
    output: z.object({
      uri: z.string(),
      revision: z.string(),
      startLine: z.number().int(),
      endLine: z.number().int(),
      totalLines: z.number().int(),
      text: z.string(),
      truncated: z.boolean(),
    }),
    capabilities: [...READ],
    sideEffect: 'read',
    timeoutMs: 10_000,
    idempotent: true,
    tags: ['model', 'read'],
  },
  (input, ctx) => {
    const file = ctx.engine.store.get(input.uri);
    if (!file) {
      fail('FILE_NOT_FOUND', `Unknown model file: ${input.uri}`, {
        details: { available: ctx.engine.store.list().map((f) => f.uri) },
        suggestions: ['Call model.list_files'],
      });
    }
    const lines = file.text.split('\n');
    const start = Math.max(0, Math.min(input.startLine, Math.max(0, lines.length - 1)));
    const requestedEnd = input.endLine ?? lines.length - 1;
    const end = Math.min(Math.max(start, requestedEnd), start + 399, lines.length - 1);
    return {
      uri: input.uri,
      revision: file.revision,
      startLine: start,
      endLine: end,
      totalLines: lines.length,
      text: lines
        .slice(start, end + 1)
        .map((line, i) => `${String(start + i + 1).padStart(5)} | ${line}`)
        .join('\n'),
      truncated: end < requestedEnd,
    };
  }
);

export const validateTool = defineTool(
  {
    name: 'model.validate',
    description:
      'Validate the whole workspace: syntax errors, duplicate qualified names, unresolved references. Well-formed models have zero errors; unresolved references are warnings.',
    input: z.object({
      uri: z.string().optional(),
      includeWarnings: z.boolean().default(true),
    }),
    output: validationReportSchema,
    capabilities: [...READ],
    sideEffect: 'read',
    timeoutMs: 20_000,
    idempotent: true,
    tags: ['model', 'validation'],
  },
  (input, ctx) => {
    const report = ctx.engine.validate();
    if (!input.uri && input.includeWarnings) {
      return report;
    }
    const filter = (issue: (typeof report.errors.items)[number]): boolean =>
      (!input.uri || issue.uri === input.uri) && (input.includeWarnings || issue.severity !== 'warning');
    const errors = report.errors.items.filter(filter);
    const warnings = report.warnings.items.filter(filter);
    return {
      ...report,
      valid: report.valid && errors.length === 0,
      errors: { ...report.errors, count: errors.length, items: errors },
      warnings: { ...report.warnings, count: warnings.length, items: warnings },
    };
  }
);

export const findReferencesTool = defineTool(
  {
    name: 'model.find_references',
    description: 'Find every reference that resolves to an element. Use before renaming or deleting it.',
    input: z.object({
      qname,
      limit: z.number().int().min(1).max(200).default(50),
    }),
    output: z.object({
      qname: z.string(),
      total: z.number().int(),
      references: z.array(
        z.object({
          uri: z.string(),
          range: rangeSchema,
          text: z.string(),
          kind: z.string(),
          sourceLine: z.string(),
        })
      ),
    }),
    capabilities: [...READ],
    sideEffect: 'read',
    timeoutMs: 10_000,
    idempotent: true,
    tags: ['model', 'references'],
  },
  (input, ctx) => {
    const index = ctx.engine.index();
    if (!index.entryFor(input.qname)) {
      fail('ELEMENT_NOT_FOUND', `Element not found: '${input.qname}'`, {
        details: { suggestions: suggestNames(index, input.qname) },
      });
    }
    const refs = index.incomingFor(input.qname);
    return { qname: input.qname, total: refs.length, references: refs.slice(0, input.limit) };
  }
);

export const createElementTool = defineTool(
  {
    name: 'model.create_element',
    description:
      'Create a named element inside an existing file, optionally inside a parent package/definition. Generates syntactically valid SysML and commits atomically.',
    input: z.object({
      uri: z.string(),
      parentQname: z.string().optional().describe('Container qname; omit for a top-level declaration'),
      kind: z.enum(EDITABLE_KINDS as [EditableKind, ...EditableKind[]]),
      name: z.string(),
      body: z.string().optional().describe('Raw SysML placed inside the body'),
      doc: z.string().optional().describe('Documentation comment'),
    }),
    output: mutationResultSchema,
    capabilities: [...WRITE],
    sideEffect: 'write',
    timeoutMs: 30_000,
    idempotent: false,
    tags: ['model', 'edit'],
  },
  (input, ctx) =>
    mutate(ctx, (tx) =>
      tx.createElement({
        uri: input.uri,
        parentQname: input.parentQname,
        kind: input.kind,
        name: input.name,
        body: input.body,
        doc: input.doc,
      })
    )
);

export const createFileTool = defineTool(
  {
    name: 'model.create_file',
    description: 'Create a new empty SysML file, optionally with a root package.',
    input: z.object({
      uri: z.string().describe('Workspace-relative path ending in .sysml or .kerml'),
      packageName: z.string().optional(),
    }),
    output: mutationResultSchema,
    capabilities: [...WRITE],
    sideEffect: 'write',
    timeoutMs: 30_000,
    idempotent: false,
    tags: ['model', 'edit'],
  },
  (input, ctx) => mutate(ctx, (tx) => tx.createFile(input.uri, input.packageName))
);

export const renameElementTool = defineTool(
  {
    name: 'model.rename_element',
    description:
      'Rename an element and (by default) every resolved reference to it. Fails on name collisions. Prefer this over textual replacement.',
    input: z.object({
      qname,
      newName: z.string(),
      updateReferences: z.boolean().default(true),
    }),
    output: mutationResultSchema,
    capabilities: [...WRITE],
    sideEffect: 'write',
    timeoutMs: 30_000,
    idempotent: false,
    tags: ['model', 'edit'],
  },
  (input, ctx) => mutate(ctx, (tx) => tx.renameElement(input))
);

export const deleteElementTool = defineTool(
  {
    name: 'model.delete_element',
    description:
      'Delete an element and its children. Refuses when other elements reference it unless force=true; commit validation still applies.',
    input: z.object({
      qname,
      force: z.boolean().default(false),
    }),
    output: mutationResultSchema,
    capabilities: [...WRITE],
    sideEffect: 'write',
    timeoutMs: 30_000,
    idempotent: false,
    tags: ['model', 'edit'],
  },
  (input, ctx) => mutate(ctx, (tx) => tx.deleteElement(input))
);

export const editTool = defineTool(
  {
    name: 'model.edit',
    description:
      'Apply one or more surgical text replacements atomically. Ranges are 0-based line/character offsets. The whole model is validated before commit; all edits roll back on failure.',
    input: z.object({
      ops: z
        .array(replaceOpSchema)
        .min(1)
        .max(100),
      expectRevision: z.string().optional().describe('Reject the batch if the model changed since this revision'),
      intent: z.string().optional(),
    }),
    output: mutationResultSchema,
    capabilities: [...WRITE],
    sideEffect: 'write',
    timeoutMs: 30_000,
    idempotent: false,
    tags: ['model', 'edit'],
  },
  (input, ctx) => {
    const index = ctx.engine.index();
    if (input.expectRevision && input.expectRevision !== index.revision) {
      fail('REVISION_CONFLICT', 'Model revision changed before the edit batch started', {
        details: { expected: input.expectRevision, actual: index.revision },
        suggestions: ['Re-read the model and recompute the edit ranges'],
      });
    }
    return mutate(ctx, (tx) => {
      const results = tx.applyReplacements(input.ops);
      return results[0] ?? { operation: { op: 'edit', uri: input.ops[0].uri, description: 'Edit batch' } };
    }, input.intent);
  }
);

export async function mutate(
  ctx: ToolContext,
  fn: (tx: ModelTransaction) => MutationResult,
  intent?: string
): Promise<z.infer<typeof mutationResultSchema>> {
  const tx = ctx.engine.beginTransaction({
    actor: ctx.actor,
    write: !ctx.dryRun,
    validateOnCommit: true,
  });
  try {
    if (ctx.signal?.aborted) {
      fail('CANCELLED', 'Edit cancelled before it started');
    }
    const result = fn(tx);
    const commit: CommitResult = await tx.commit();
    return {
      transactionId: commit.transactionId,
      revision: commit.revision,
      dryRun: ctx.dryRun,
      ...(result.qname ? { qname: result.qname } : {}),
      operation: result.operation.op,
      description: result.operation.description,
      changedFiles: commit.changedFiles,
      diagnostics: commit.diagnostics,
      ...(result.details || intent ? { details: { ...result.details, ...(intent ? { intent } : {}) } } : {}),
    };
  } catch (error) {
    tx.rollback();
    throw error;
  }
}

export { qname, READ, WRITE };
