import { createHash } from 'node:crypto';
import { parseText } from './parser/parser.ts';
import { buildDocumentModel, flattenSymbols } from './parser/model.ts';
import type { DocumentModel, SysmlSymbol } from './parser/model.ts';
import { Workspace } from './parser/workspace.ts';
import type {
  ElementSummary,
  ElementView,
  FileInfo,
  LspRange,
  ModelSnapshotInfo,
  Numbered,
  ReferenceView,
  ValidationIssue,
  ValidationReport,
} from './types.ts';
import type { IndexedSymbol } from './parser/workspace.ts';

export interface SourceFile {
  uri: string;
  text: string;
}

export interface IncomingReference {
  uri: string;
  range: LspRange;
  text: string;
  kind: string;
  sourceLine: string;
}

/** Names shipped by the SysML/KerML standard library. Unresolved references
 * to these roots are expected when the library is not indexed. */
const LIBRARY_ROOTS = new Set([
  'Base',
  'Collections',
  'ScalarValues',
  'VectorValues',
  'ComplexFunctions',
  'BooleanFunctions',
  'IntegerFunctions',
  'RationalFunctions',
  'RealFunctions',
  'StringFunctions',
  'TrigFunctions',
  'VectorFunctions',
  'OccurrenceFunctions',
  'ControlFunctions',
  'StateFunctions',
  'TransitionFunctions',
  'LinkFunctions',
  'ClockFunctions',
  'Kernel',
  'ISQ',
  'SI',
  'Units',
  'Quantities',
  'Measurement',
  'SysML',
  'Requirements',
  'AnalysisCases',
  'VerificationCases',
  'UseCases',
  'Views',
  'Metadata',
  'Connections',
  'Interfaces',
  'Flows',
  'Allocations',
  'Actions',
  'States',
  'Parts',
  'Ports',
  'Items',
  'Attributes',
  'Constraints',
  'Calculations',
  'Occurrences',
]);

const COMMON_SCALARS = new Set([
  'Real',
  'Integer',
  'Natural',
  'Boolean',
  'String',
  'Complex',
  'Number',
  'Anything',
  'DataValue',
]);

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function shortRevision(text: string): string {
  return sha256(text).slice(0, 16);
}

export function globalRevision(files: SourceFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.uri.localeCompare(b.uri))) {
    hash.update(file.uri);
    hash.update('\0');
    hash.update(file.text);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

export function offsetAt(text: string, line: number, character: number): number {
  let currentLine = 0;
  let index = 0;
  while (currentLine < line && index < text.length) {
    if (text[index] === '\n') {
      currentLine += 1;
    }
    index += 1;
  }
  return Math.min(text.length, index + Math.max(0, character));
}

export function positionAt(text: string, offset: number): { line: number; character: number } {
  const bounded = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lastNewline = -1;
  for (let i = 0; i < bounded; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      lastNewline = i;
    }
  }
  return { line, character: bounded - lastNewline - 1 };
}

export function sliceRange(text: string, range: LspRange): string {
  const start = offsetAt(text, range.start.line, range.start.character);
  const end = offsetAt(text, range.end.line, range.end.character);
  return text.slice(start, Math.max(start, end));
}

/**
 * The parser reports a definition's range starting at its name (not at
 * `part def`). Extend to the beginning of the line when only indentation and
 * declaration keywords precede the name, so deletion and source excerpts cover
 * the whole declaration. Inline declarations (after `;`, `{` or `}`) are left
 * untouched.
 */
export function declarationStartOffset(text: string, range: LspRange): number {
  const start = offsetAt(text, range.start.line, range.start.character);
  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const prefix = text.slice(lineStart, start);
  if (prefix.trim() === '') {
    return lineStart;
  }
  if (/[;{}]/.test(prefix)) {
    return start;
  }
  const words = prefix.trim().split(/\s+/);
  if (words.length <= 4 && words.every((word) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(word))) {
    return lineStart;
  }
  return start;
}

function toSummary(sym: SysmlSymbol): ElementSummary {
  return {
    id: sym.id,
    name: sym.name,
    ...(sym.shortName ? { shortName: sym.shortName } : {}),
    qname: sym.qname,
    kind: sym.kind,
    uri: sym.uri,
    ...(sym.parent && !sym.parent.isFileRoot ? { parentQname: sym.parent.qname } : {}),
    range: sym.range,
    childrenCount: sym.children.length,
  };
}

function refView(ref: SysmlSymbol['refs'][number], uri: string): ReferenceView {
  return {
    kind: ref.kind,
    text: ref.text,
    uri,
    range: ref.range,
    ...(ref.resolved ? { targetQname: ref.resolved.qname } : {}),
    resolved: Boolean(ref.resolved),
  };
}

export class ModelIndex {
  /** One entry per file. `lines` is pre-split for O(1) sourceLine lookups. */
  readonly files: Map<string, { text: string; model: DocumentModel; lines: string[] }>;
  /** Flattened containment tree, in file then source order. */
  readonly elements: IndexedSymbol[];
  /** Qualified-name index. Multiple entries mean a duplicate declaration. */
  readonly byQName: Map<string, IndexedSymbol[]>;
  /** Symbol IDs are stable for one parse (`uri#line:column`). */
  readonly byId: Map<string, IndexedSymbol>;
  readonly byName: Map<string, IndexedSymbol[]>;
  readonly byShortName: Map<string, IndexedSymbol[]>;
  /** Reverse reference index: target qname -> references that resolve to it. */
  readonly incoming: Map<string, IncomingReference[]>;
  readonly revision: string;
  readonly diagnostics: ValidationReport;
  private readonly elementCountByUri: Map<string, number>;

  private constructor(files: SourceFile[]) {
    this.files = new Map();
    this.revision = globalRevision(files);
    this.elementCountByUri = new Map();

    const workspace = new Workspace();
    for (const file of files) {
      const parsed = parseText(file.text);
      const model = buildDocumentModel(file.uri, parsed, false);
      this.files.set(file.uri, { text: file.text, model, lines: file.text.split('\n') });
      workspace.add(model);
    }
    for (const { model } of this.files.values()) {
      workspace.resolveRefs(model);
    }

    this.elements = [];
    this.byQName = new Map();
    this.byId = new Map();
    this.byName = new Map();
    this.byShortName = new Map();
    this.incoming = new Map();

    for (const [uri, { model }] of this.files) {
      const symbols = flattenSymbols(model);
      this.elementCountByUri.set(uri, symbols.length);
      for (const sym of symbols) {
        const entry: IndexedSymbol = { sym, model };
        this.elements.push(entry);
        pushToMap(this.byQName, sym.qname, entry);
        this.byId.set(sym.id, entry);
        pushToMap(this.byName, sym.name, entry);
        if (sym.shortName) {
          pushToMap(this.byShortName, sym.shortName, entry);
        }
      }
    }

    for (const { sym, model } of this.elements) {
      const lines = this.files.get(model.uri)?.lines ?? [];
      for (const ref of sym.refs) {
        if (!ref.resolved) {
          continue;
        }
        const item: IncomingReference = {
          uri: model.uri,
          range: ref.range,
          text: ref.text,
          kind: ref.kind,
          sourceLine: lines[ref.range.start.line] ?? '',
        };
        pushToMap(this.incoming, ref.resolved.qname, item);
      }
    }

    this.diagnostics = this.computeDiagnostics();
  }

  static build(files: SourceFile[]): ModelIndex {
    return new ModelIndex(files);
  }

  fileInfo(uri: string): FileInfo | undefined {
    const file = this.files.get(uri);
    if (!file) {
      return undefined;
    }
    return {
      uri,
      revision: shortRevision(file.text),
      bytes: Buffer.byteLength(file.text, 'utf8'),
      elementCount: this.elementCountByUri.get(uri) ?? 0,
      errorCount: file.model.errors.length,
    };
  }

  snapshotInfo(root: string): ModelSnapshotInfo {
    const files: FileInfo[] = [];
    for (const uri of this.files.keys()) {
      const info = this.fileInfo(uri);
      if (info) {
        files.push(info);
      }
    }
    files.sort((a, b) => a.uri.localeCompare(b.uri));
    return { root, revision: this.revision, files };
  }

  entryFor(qname: string): IndexedSymbol | undefined {
    const exact = this.byQName.get(qname);
    if (exact?.length) {
      return exact[0];
    }
    return undefined;
  }

  entriesForName(name: string): IndexedSymbol[] {
    return [...(this.byName.get(name) ?? []), ...(this.byShortName.get(name) ?? [])];
  }

  /**
   * Filter the flat element list. Kept intentionally simple: tool inputs cap
   * `limit`, so callers never materialise more than a page of summaries.
   */
  find(input: {
    uri?: string;
    kind?: string;
    nameContains?: string;
    qnamePrefix?: string;
    limit?: number;
    offset?: number;
  }): { total: number; items: ElementSummary[] } {
    const needle = input.nameContains?.toLowerCase();
    const kind = input.kind?.toLowerCase();
    const matched = this.elements.filter(({ sym }) => {
      if (input.uri && sym.uri !== input.uri) return false;
      if (kind && sym.kind.toLowerCase() !== kind) return false;
      if (needle && !sym.name.toLowerCase().includes(needle) && !sym.qname.toLowerCase().includes(needle)) return false;
      if (input.qnamePrefix && !sym.qname.startsWith(input.qnamePrefix)) return false;
      return true;
    });
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 50;
    return {
      total: matched.length,
      items: matched.slice(offset, offset + limit).map(({ sym }) => toSummary(sym)),
    };
  }

  /**
   * Full view for one element: source excerpt, direct children, outgoing refs
   * and incoming refs. Bounded so a large package cannot blow up the context.
   */
  elementView(entry: IndexedSymbol, sourceLimit = 4000): ElementView {
    const file = this.files.get(entry.sym.uri);
    const source = file ? sliceRange(file.text, declarationRangeOf(file.text, entry.sym.range)).slice(0, sourceLimit) : '';
    return {
      ...toSummary(entry.sym),
      children: entry.sym.children.map(toSummary),
      refs: entry.sym.refs.map((ref) => refView(ref, entry.sym.uri)),
      source,
      incomingReferences: (this.incoming.get(entry.sym.qname) ?? []).slice(0, 50),
    };
  }

  incomingFor(qname: string): IncomingReference[] {
    return this.incoming.get(qname) ?? [];
  }

  /**
   * Syntax errors are fatal; duplicate qnames are fatal; unresolved
   * references are warnings so partially imported models remain editable.
   */
  private computeDiagnostics(): ValidationReport {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    for (const [uri, { model }] of this.files) {
      for (const error of model.errors) {
        errors.push({
          code: 'SYNTAX_ERROR',
          severity: 'error',
          message: error.message,
          uri,
          range: {
            start: { line: error.line, character: error.column },
            end: { line: error.line, character: error.column + 1 },
          },
        });
      }
    }

    for (const [qname, entries] of this.byQName) {
      if (entries.length < 2) {
        continue;
      }
      const uris = new Set(entries.map((e) => e.sym.uri));
      const ranges = new Set(entries.map((e) => `${e.sym.range.start.line}:${e.sym.range.start.character}`));
      if (uris.size === 1 && ranges.size === 1) {
        continue; // same parse tree reached twice
      }
      for (const entry of entries) {
        errors.push({
          code: 'DUPLICATE_NAME',
          severity: 'error',
          message: `Duplicate qualified name '${qname}' in ${entries.length} locations`,
          uri: entry.sym.uri,
          range: entry.sym.nameRange,
          qname,
          details: { locations: entries.map((e) => `${e.sym.uri}:${e.sym.range.start.line + 1}`) },
        });
      }
    }

    for (const { sym, model } of this.elements) {
      for (const ref of sym.refs) {
        if (ref.resolved) {
          continue;
        }
        const root = ref.text.split('::')[0];
        if (LIBRARY_ROOTS.has(root) || COMMON_SCALARS.has(root)) {
          continue;
        }
        warnings.push({
          code: 'UNRESOLVED_REFERENCE',
          severity: 'warning',
          message: `Unresolved reference '${ref.text}' (${ref.kind})`,
          uri: model.uri,
          range: ref.range,
          qname: sym.qname,
          details: { reference: ref.text, kind: ref.kind },
        });
      }
    }

    return {
      valid: errors.length === 0,
      revision: this.revision,
      errors: numbered(errors),
      warnings: numbered(warnings),
      unresolvedReferences: warnings.filter((issue) => issue.code === 'UNRESOLVED_REFERENCE').length,
      filesChecked: this.files.size,
      elementsChecked: this.elements.length,
    };
  }
}

function pushToMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

function numbered<T>(items: T[], limit = 200): Numbered<T> {
  return {
    count: items.length,
    items: items.slice(0, limit),
    ...(items.length > limit ? { truncated: true } : {}),
  };
}

export function declarationRangeOf(text: string, range: LspRange): LspRange {
  const startOffset = declarationStartOffset(text, range);
  return {
    start: positionAt(text, startOffset),
    end: range.end,
  };
}

export function suggestNames(index: ModelIndex, query: string, limit = 5): string[] {
  const needle = query.toLowerCase();
  const scored: Array<{ qname: string; score: number }> = [];
  for (const { sym } of index.elements) {
    const name = sym.name.toLowerCase();
    let score = -1;
    if (name === needle) score = 100;
    else if (name.startsWith(needle)) score = 80 - name.length;
    else if (name.includes(needle)) score = 60 - name.length;
    else if (needle.includes(name)) score = 40 - name.length;
    else score = levenshtein(name, needle) <= Math.max(2, Math.floor(needle.length / 3)) ? 20 : -1;
    if (score >= 0) {
      scored.push({ qname: sym.qname, score });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.qname.localeCompare(b.qname))
    .slice(0, limit)
    .map((s) => s.qname);
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}
