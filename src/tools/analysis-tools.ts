import { z } from 'zod';
import { defineTool } from '../contracts/tool.ts';
import { fail } from '../contracts/errors.ts';
import { sliceRange, suggestNames } from '../engine/index.ts';
import type { ModelIndex } from '../engine/index.ts';
import { symbolAtPosition } from '../engine/parser/model.ts';
import { rangeSchema } from './schemas.ts';

const ANALYZE = ['read', 'analyze'] as const;

export interface RequirementCoverage {
  qname: string;
  name: string;
  text: string;
  uri: string;
  kind: string;
  evidence: Array<{ kind: string; uri: string; line: number; sourceLine: string; reference: string }>;
}

export interface CoverageReport {
  total: number;
  covered: number;
  uncovered: number;
  coverage: number;
  requirements: RequirementCoverage[];
  orphans: string[];
}

const KEYWORDS = new Set([
  'satisfy',
  'verify',
  'allocate',
  'to',
  'from',
  'the',
  'a',
  'an',
  'requirement',
  'by',
  'and',
  'or',
  'in',
  'of',
]);

const COVERAGE_CACHE = new WeakMap<ModelIndex, CoverageReport>();

/** Requirements and their traceability evidence. Cached per immutable index. */
export function collectRequirements(index: ModelIndex): CoverageReport {
  const cached = COVERAGE_CACHE.get(index);
  if (cached) {
    return cached;
  }
  const report = computeRequirements(index);
  COVERAGE_CACHE.set(index, report);
  return report;
}

const RELATION_PATTERN = /\b(satisfy|verify|allocate)\b([^;{}]*)/g;
const REF_PATTERN = /[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*/g;

function computeRequirements(index: ModelIndex): CoverageReport {
  const requirements: RequirementCoverage[] = [];
  for (const { sym } of index.elements) {
    if (!/^Requirement( Definition)?$/.test(sym.kind)) {
      continue;
    }
    const file = index.files.get(sym.uri);
    const source = file ? sliceRange(file.text, sym.range) : '';
    const text = extractRequirementText(source) ?? '(no text attribute)';
    requirements.push({
      qname: sym.qname,
      name: sym.name,
      text,
      uri: sym.uri,
      kind: sym.kind,
      evidence: [],
    });
  }

  const byName = new Map<string, RequirementCoverage[]>();
  for (const req of requirements) {
    const list = byName.get(req.name) ?? [];
    list.push(req);
    byName.set(req.name, list);
  }

  for (const [uri, { text }] of index.files) {
    const lines = text.split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = stripComment(lines[lineIndex]);
      RELATION_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = RELATION_PATTERN.exec(line)) !== null) {
        const relKind = match[1];
        const refs = extractRefs(match[2]);
        if (refs.length === 0) {
          continue;
        }
        const reference = relKind === 'allocate' ? refs[refs.length - 1] : refs[0];
        const last = reference.split('::').pop()!;
        const targets = byName.get(last) ?? [];
        if (targets.length !== 1) {
          continue;
        }
        targets[0].evidence.push({
          kind: relKind,
          uri,
          line: lineIndex,
          sourceLine: lines[lineIndex].trim().slice(0, 240),
          reference,
        });
      }
    }
  }

  const covered = requirements.filter((r) => r.evidence.length > 0).length;
  return {
    total: requirements.length,
    covered,
    uncovered: requirements.length - covered,
    coverage: requirements.length === 0 ? 1 : Math.round((covered / requirements.length) * 1000) / 1000,
    requirements,
    orphans: requirements.filter((r) => r.evidence.length === 0).map((r) => r.qname),
  };
}

const summaryTool = defineTool(
  {
    name: 'analysis.summary',
    description:
      'Deterministic model metrics: files, elements by kind, package count, containment depth, requirement coverage and validation errors. Use to orient yourself before deeper analysis.',
    input: z.object({}),
    output: z.object({
      revision: z.string(),
      files: z.number().int(),
      elements: z.number().int(),
      byKind: z.record(z.string(), z.number().int()),
      packages: z.number().int(),
      definitions: z.number().int(),
      usages: z.number().int(),
      requirements: z.object({
        total: z.number().int(),
        covered: z.number().int(),
        uncovered: z.number().int(),
        coverage: z.number(),
      }),
      errors: z.number().int(),
      warnings: z.number().int(),
      unresolvedReferences: z.number().int(),
      maxDepth: z.number().int(),
      orphans: z.array(z.string()),
    }),
    capabilities: [...ANALYZE],
    sideEffect: 'read',
    timeoutMs: 20_000,
    idempotent: true,
    tags: ['analysis', 'metrics'],
  },
  (_input, ctx) => {
    const index = ctx.engine.index();
    const byKind: Record<string, number> = {};
    let definitions = 0;
    let usages = 0;
    let maxDepth = 0;
    for (const { sym } of index.elements) {
      byKind[sym.kind] = (byKind[sym.kind] ?? 0) + 1;
      if (sym.kind.includes('Definition')) definitions += 1;
      else usages += 1;
      let depth = 0;
      let parent = sym.parent;
      while (parent && !parent.isFileRoot) {
        depth += 1;
        parent = parent.parent;
      }
      maxDepth = Math.max(maxDepth, depth);
    }
    const coverage = collectRequirements(index);
    return {
      revision: index.revision,
      files: index.files.size,
      elements: index.elements.length,
      byKind,
      packages: byKind.Package ?? 0,
      definitions,
      usages,
      requirements: {
        total: coverage.total,
        covered: coverage.covered,
        uncovered: coverage.uncovered,
        coverage: coverage.coverage,
      },
      errors: index.diagnostics.errors.count,
      warnings: index.diagnostics.warnings.count,
      unresolvedReferences: index.diagnostics.unresolvedReferences,
      maxDepth,
      orphans: coverage.orphans,
    };
  }
);

const requirementsTool = defineTool(
  {
    name: 'analysis.requirements',
    description:
      'List requirement definitions/usages with their text and the satisfy/verify/allocate evidence found in the model. Reports uncovered requirements.',
    input: z.object({
      includeUncoveredOnly: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(100),
    }),
    output: z.object({
      revision: z.string(),
      total: z.number().int(),
      covered: z.number().int(),
      uncovered: z.number().int(),
      coverage: z.number(),
      requirements: z.array(
        z.object({
          qname: z.string(),
          name: z.string(),
          text: z.string(),
          uri: z.string(),
          kind: z.string(),
          evidence: z.array(
            z.object({
              kind: z.string(),
              uri: z.string(),
              line: z.number().int(),
              sourceLine: z.string(),
              reference: z.string(),
            })
          ),
        })
      ),
      orphans: z.array(z.string()),
      truncated: z.boolean(),
    }),
    capabilities: [...ANALYZE],
    sideEffect: 'read',
    timeoutMs: 20_000,
    idempotent: true,
    tags: ['analysis', 'requirements', 'traceability'],
  },
  (input, ctx) => {
    const index = ctx.engine.index();
    const coverage = collectRequirements(index);
    const filtered = input.includeUncoveredOnly
      ? coverage.requirements.filter((r) => r.evidence.length === 0)
      : coverage.requirements;
    return {
      revision: index.revision,
      total: coverage.total,
      covered: coverage.covered,
      uncovered: coverage.uncovered,
      coverage: coverage.coverage,
      requirements: filtered.slice(0, input.limit),
      orphans: coverage.orphans,
      truncated: filtered.length > input.limit,
    };
  }
);

const impactTool = defineTool(
  {
    name: 'analysis.impact',
    description:
      'Compute the transitive impact of changing an element: every element whose references resolve to it, up to maxDepth.',
    input: z.object({
      qname: z.string().min(1),
      maxDepth: z.number().int().min(1).max(10).default(3),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    output: z.object({
      root: z.string(),
      nodes: z.array(
        z.object({
          qname: z.string(),
          kind: z.string(),
          uri: z.string(),
          depth: z.number().int(),
        })
      ),
      edges: z.array(
        z.object({
          from: z.string(),
          to: z.string(),
          kind: z.string(),
          uri: z.string(),
          range: rangeSchema,
        })
      ),
      truncated: z.boolean(),
    }),
    capabilities: [...ANALYZE],
    sideEffect: 'read',
    timeoutMs: 20_000,
    idempotent: true,
    tags: ['analysis', 'impact'],
  },
  (input, ctx) => {
    const index = ctx.engine.index();
    const root = index.entryFor(input.qname);
    if (!root) {
      fail('ELEMENT_NOT_FOUND', `Element not found: '${input.qname}'`, {
        details: { suggestions: suggestNames(index, input.qname) },
      });
    }
    const nodes: Array<{ qname: string; kind: string; uri: string; depth: number }> = [
      { qname: root.sym.qname, kind: root.sym.kind, uri: root.sym.uri, depth: 0 },
    ];
    const edges: Array<{ from: string; to: string; kind: string; uri: string; range: z.infer<typeof rangeSchema> }> = [];
    const seen = new Set([root.sym.qname]);
    let frontier = [root.sym.qname];
    let truncated = false;

    for (let depth = 1; depth <= input.maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const target of frontier) {
        for (const ref of index.incomingFor(target)) {
          const container = containingElement(index, ref.uri, ref.range.start.line, ref.range.start.character);
          if (!container) {
            continue;
          }
          edges.push({
            from: container.qname,
            to: target,
            kind: ref.kind,
            uri: ref.uri,
            range: ref.range,
          });
          if (seen.has(container.qname)) {
            continue;
          }
          seen.add(container.qname);
          if (nodes.length >= input.limit) {
            truncated = true;
            continue;
          }
          nodes.push({ qname: container.qname, kind: container.kind, uri: container.uri, depth });
          next.push(container.qname);
        }
      }
      frontier = next;
    }

    return { root: input.qname, nodes, edges, truncated };
  }
);

const traceabilityTool = defineTool(
  {
    name: 'analysis.traceability',
    description:
      'Show requirement traceability: which elements satisfy, verify or allocate to each requirement, plus the requirements with no evidence.',
    input: z.object({
      qname: z.string().optional().describe('Restrict to one requirement'),
      limit: z.number().int().min(1).max(200).default(100),
    }),
    output: z.object({
      revision: z.string(),
      coverage: z.number(),
      links: z.array(
        z.object({
          requirement: z.string(),
          evidence: z.array(
            z.object({
              kind: z.string(),
              uri: z.string(),
              line: z.number().int(),
              sourceLine: z.string(),
              reference: z.string(),
            })
          ),
        })
      ),
      uncovered: z.array(z.string()),
    }),
    capabilities: [...ANALYZE],
    sideEffect: 'read',
    timeoutMs: 20_000,
    idempotent: true,
    tags: ['analysis', 'traceability'],
  },
  (input, ctx) => {
    const index = ctx.engine.index();
    const coverage = collectRequirements(index);
    const filtered = input.qname
      ? coverage.requirements.filter((r) => r.qname === input.qname)
      : coverage.requirements;
    if (input.qname && filtered.length === 0) {
      fail('ELEMENT_NOT_FOUND', `Requirement not found: '${input.qname}'`);
    }
    return {
      revision: index.revision,
      coverage: coverage.coverage,
      links: filtered.slice(0, input.limit).map((r) => ({ requirement: r.qname, evidence: r.evidence })),
      uncovered: filtered.filter((r) => r.evidence.length === 0).map((r) => r.qname),
    };
  }
);

export const analysisTools = [summaryTool, requirementsTool, impactTool, traceabilityTool];

function extractRequirementText(source: string): string | undefined {
  const match = /attribute\s+text\s*:\s*\w+\s*=\s*(?:"([^"]*)"|'([^']*)')/m.exec(source);
  return match ? (match[1] ?? match[2]) : undefined;
}

function stripComment(line: string): string {
  const index = line.indexOf('//');
  return index >= 0 ? line.slice(0, index) : line;
}

function extractRefs(text: string): string[] {
  REF_PATTERN.lastIndex = 0;
  const matches = text.match(REF_PATTERN) ?? [];
  return matches.filter((ref) => !KEYWORDS.has(ref));
}

function containingElement(
  index: ModelIndex,
  uri: string,
  line: number,
  character: number
): { qname: string; kind: string; uri: string } | undefined {
  const file = index.files.get(uri);
  if (!file) {
    return undefined;
  }
  const sym = symbolAtPosition(file.model, line, character);
  if (!sym) {
    return undefined;
  }
  const entry = index.byId.get(sym.id);
  return entry ? { qname: entry.sym.qname, kind: entry.sym.kind, uri: entry.sym.uri } : undefined;
}
