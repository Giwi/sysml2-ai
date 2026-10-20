import { randomUUID } from 'node:crypto';
import { EngineError, fail, makeError } from '../contracts/errors.ts';
import { ModelIndex, offsetAt, positionAt, suggestNames, declarationStartOffset } from './index.ts';
import type { SourceFile } from './index.ts';
import { renderDeclaration, nameIsValid } from './templates.ts';
import { WorkspaceStore } from './store.ts';
import type {
  AppliedOperation,
  CommitResult,
  CreateElementInput,
  DeleteElementInput,
  LspRange,
  ModelSnapshotInfo,
  RenameElementInput,
  ReplaceOp,
  TransactionOptions,
  ValidationReport,
} from './types.ts';

export interface MutationResult {
  operation: AppliedOperation;
  qname?: string;
  details?: Record<string, unknown>;
}

export interface EngineLike {
  readonly store: WorkspaceStore;
  index(): ModelIndex;
  snapshotInfo(): ModelSnapshotInfo;
  beginTransaction(options: TransactionOptions): ModelTransaction;
}

/**
 * A transaction owns a private copy of every model file. Nothing reaches the
 * disk until `commit()` validates the whole working model and wins the
 * optimistic revision check.
 */
export class ModelTransaction {
  readonly id: string;
  readonly actor: string;
  readonly baseRevision: string;
  readonly baseTexts: Map<string, string>;
  readonly options: Required<Pick<TransactionOptions, 'validateOnCommit' | 'write'>>;
  private working: Map<string, string>;
  private readonly operations: AppliedOperation[] = [];
  private cachedIndex?: ModelIndex;
  private closed = false;
  private readonly store: WorkspaceStore;

  constructor(store: WorkspaceStore, options: TransactionOptions) {
    this.store = store;
    this.id = `tx_${randomUUID().slice(0, 12)}`;
    this.actor = options.actor;
    this.baseRevision = store.index().revision;
    this.baseTexts = new Map(store.list().map((file) => [file.uri, file.text]));
    this.working = new Map(this.baseTexts);
    this.options = {
      validateOnCommit: options.validateOnCommit ?? true,
      write: options.write ?? true,
    };
  }

  get workingTexts(): ReadonlyMap<string, string> {
    return this.working;
  }

  get appliedOperations(): readonly AppliedOperation[] {
    return this.operations;
  }

  index(): ModelIndex {
    if (!this.cachedIndex) {
      this.cachedIndex = ModelIndex.build(this.snapshotSources());
    }
    return this.cachedIndex;
  }

  validate(): ValidationReport {
    return this.index().diagnostics;
  }

  read(uri: string): string {
    const text = this.working.get(uri);
    if (text === undefined) {
      fail('FILE_NOT_FOUND', `Unknown model file: ${uri}`, {
        details: { available: [...this.working.keys()] },
        suggestions: ['Call model.list_files to discover the workspace files'],
      });
    }
    return text;
  }

  createFile(uri: string, packageName?: string): MutationResult {
    this.assertOpen();
    this.store.absolutePath(uri);
    if (this.working.has(uri)) {
      fail('FILE_EXISTS', `File already exists: ${uri}`, {
        suggestions: ['Choose another path or edit the existing file'],
      });
    }
    if (packageName) {
      this.validateName(packageName);
    }
    const text = packageName ? `package ${packageName} {\n}\n` : '\n';
    this.working.set(uri, text);
    this.invalidate();
    const operation: AppliedOperation = {
      op: 'create_file',
      uri,
      description: `Created ${uri}${packageName ? ` with package ${packageName}` : ''}`,
    };
    this.operations.push(operation);
    return { operation, ...(packageName ? { qname: packageName } : {}), details: { bytes: text.length } };
  }

  /**
   * Render a declaration from a high-level template and insert it inside the
   * parent body (or create a body when the parent ends with `;`). The caller
   * still has to commit, so the whole model is validated before any write.
   */
  createElement(input: CreateElementInput): MutationResult {
    this.assertOpen();
    this.validateName(input.name);
    const text = this.read(input.uri);
    const index = this.index();

    const qname = input.parentQname ? `${input.parentQname}::${input.name}` : input.name;
    if (index.byQName.has(qname)) {
      const existing = index.byQName.get(qname)![0];
      fail('NAME_COLLISION', `An element named '${qname}' already exists`, {
        details: { qname, existingUri: existing.sym.uri },
        location: { uri: existing.sym.uri, line: existing.sym.range.start.line, character: existing.sym.range.start.character },
        suggestions: ['Choose a different name', 'Use model.rename_element to change the existing element'],
      });
    }

    const declaration = renderDeclaration(input.kind, input.name, input.body, input.doc);
    let updated: string;
    let insertAt: number;

    if (input.parentQname) {
      const parent = index.entryFor(input.parentQname);
      if (!parent) {
        const suggestions = suggestNames(index, input.parentQname);
        fail('ELEMENT_NOT_FOUND', `Parent element not found: '${input.parentQname}'`, {
          details: { parentQname: input.parentQname, suggestions },
          suggestions: suggestions.length
            ? [`Did you mean: ${suggestions.join(', ')}?`, 'Call model.list_elements to inspect available parents']
            : ['Call model.list_elements to inspect available parents'],
        });
      }
      if (parent.sym.uri !== input.uri) {
        fail('INVALID_OPERATION', `Parent '${input.parentQname}' is declared in ${parent.sym.uri}, not ${input.uri}`, {
          suggestions: [`Use uri '${parent.sym.uri}'`],
        });
      }
      const placement = placeInside(text, parent.sym.range, declaration);
      updated = placement.text;
      insertAt = placement.insertAt;
    } else {
      const placement = placeTopLevel(text, declaration);
      updated = placement.text;
      insertAt = placement.insertAt;
    }

    this.working.set(input.uri, updated);
    this.invalidate();
    const position = positionAt(updated, insertAt);
    const operation: AppliedOperation = {
      op: 'create_element',
      uri: input.uri,
      qname,
      description: `Created ${input.kind} '${qname}' at ${input.uri}:${position.line + 1}`,
    };
    this.operations.push(operation);
    return { operation, qname, details: { position } };
  }

  /**
   * Rename the declaration and every resolved incoming reference. Edits are
   * grouped per file and applied in reverse offset order, then committed as a
   * single transaction.
   */
  renameElement(input: RenameElementInput): MutationResult {
    this.assertOpen();
    this.validateName(input.newName);
    const index = this.index();
    const target = index.entryFor(input.qname);
    if (!target) {
      throw this.notFound(input.qname, 'element');
    }
    const oldName = target.sym.name;
    if (oldName === input.newName) {
      return {
        operation: {
          op: 'rename_element',
          uri: target.sym.uri,
          qname: input.qname,
          description: `Element '${input.qname}' already has that name`,
        },
        qname: input.qname,
        details: { referencesUpdated: 0, changed: false },
      };
    }

    const parentQname = target.sym.parent && !target.sym.parent.isFileRoot ? target.sym.parent.qname : undefined;
    const newQname = parentQname ? `${parentQname}::${input.newName}` : input.newName;
    if (index.byQName.has(newQname)) {
      fail('NAME_COLLISION', `An element named '${newQname}' already exists`, {
        details: { qname: newQname },
        suggestions: ['Choose a different name'],
      });
    }

    const editsByUri = new Map<string, Array<{ start: number; end: number; text: string }>>();
    const pushEdit = (uri: string, range: LspRange, replacement: string): void => {
      const fileText = this.read(uri);
      const list = editsByUri.get(uri) ?? [];
      list.push({
        start: offsetAt(fileText, range.start.line, range.start.character),
        end: offsetAt(fileText, range.end.line, range.end.character),
        text: replacement,
      });
      editsByUri.set(uri, list);
    };

    pushEdit(target.sym.uri, target.sym.nameRange, input.newName);

    let referencesUpdated = 0;
    if (input.updateReferences !== false) {
      for (const incoming of index.incomingFor(input.qname)) {
        const replaced = replaceReferenceName(incoming.text, oldName, input.newName);
        if (replaced !== undefined) {
          pushEdit(incoming.uri, incoming.range, replaced);
          referencesUpdated += 1;
        }
      }
    }

    for (const [uri, edits] of editsByUri) {
      const updated = applyOffsets(this.read(uri), edits);
      this.working.set(uri, updated);
    }
    this.invalidate();

    const operation: AppliedOperation = {
      op: 'rename_element',
      uri: target.sym.uri,
      qname: newQname,
      description: `Renamed '${input.qname}' to '${newQname}' and updated ${referencesUpdated} reference(s)`,
    };
    this.operations.push(operation);
    return {
      operation,
      qname: newQname,
      details: { previousQname: input.qname, referencesUpdated, updateReferences: input.updateReferences !== false },
    };
  }

  deleteElement(input: DeleteElementInput): MutationResult {
    this.assertOpen();
    const index = this.index();
    const target = index.entryFor(input.qname);
    if (!target) {
      throw this.notFound(input.qname, 'element');
    }
    const incoming = index.incomingFor(input.qname);
    if (incoming.length > 0 && !input.force) {
      fail('REFERENCED_ELEMENT', `Element '${input.qname}' is referenced ${incoming.length} time(s)`, {
        details: {
          qname: input.qname,
          references: incoming.slice(0, 20),
        },
        suggestions: [
          'Rename or edit the referencing elements first',
          'Pass force=true only if the resulting dangling references are acceptable (commit validation may still reject them)',
        ],
      });
    }

    const text = this.read(target.sym.uri);
    const start = declarationStartOffset(text, target.sym.range);
    const end = offsetAt(text, target.sym.range.end.line, target.sym.range.end.character);
    const expanded = expandDeletion(text, start, end);
    const updated = text.slice(0, expanded.start) + text.slice(expanded.end);
    this.working.set(target.sym.uri, updated);
    this.invalidate();

    const operation: AppliedOperation = {
      op: 'delete_element',
      uri: target.sym.uri,
      qname: input.qname,
      description: `Deleted '${input.qname}' from ${target.sym.uri}`,
    };
    this.operations.push(operation);
    return { operation, qname: input.qname, details: { deletedReferences: incoming.length } };
  }

  replaceText(op: ReplaceOp): MutationResult {
    this.assertOpen();
    return this.applyReplacements([op])[0];
  }

  /** Apply a batch of surgical replacements atomically, in reverse offset order. */
  applyReplacements(ops: ReplaceOp[]): MutationResult[] {
    this.assertOpen();
    if (ops.length === 0) {
      fail('INVALID_INPUT', 'The edit batch is empty');
    }
    const byUri = new Map<string, Array<{ op: ReplaceOp; start: number; end: number }>>();
    for (const op of ops) {
      const text = this.read(op.uri);
      const start = offsetAt(text, op.range.start.line, op.range.start.character);
      const end = offsetAt(text, op.range.end.line, op.range.end.character);
      if (end < start) {
        fail('INVALID_INPUT', `Invalid range in ${op.uri}: end is before start`, { location: { uri: op.uri, ...op.range.start } });
      }
      const list = byUri.get(op.uri) ?? [];
      list.push({ op, start, end });
      byUri.set(op.uri, list);
    }

    for (const [uri, entries] of byUri) {
      entries.sort((a, b) => b.start - a.start);
      const text = this.read(uri);
      let lastStart = Number.POSITIVE_INFINITY;
      let updated = text;
      for (const entry of entries) {
        if (entry.end > lastStart) {
          fail('INVALID_OPERATION', `Overlapping replacements in ${uri}`, {
            details: { uri, ranges: entries.map((e) => e.op.range) },
            suggestions: ['Merge overlapping ranges into a single replacement'],
          });
        }
        updated = updated.slice(0, entry.start) + entry.op.text + updated.slice(entry.end);
        lastStart = entry.start;
      }
      this.working.set(uri, updated);
    }
    this.invalidate();

    return ops.map((op) => {
      const operation: AppliedOperation = {
        op: 'replace_text',
        uri: op.uri,
        description: `Replaced text at ${op.uri}:${op.range.start.line + 1}`,
      };
      this.operations.push(operation);
      return { operation, details: { range: op.range } };
    });
  }

  /**
   * Validate the working model, then write all changed files atomically.
   * The store wins an optimistic revision check before the first rename, so a
   * concurrent edit surfaces as REVISION_CONFLICT instead of silent overwrite.
   */
  async commit(): Promise<CommitResult> {
    this.assertOpen();
    const diagnostics = this.validate();
    if (this.options.validateOnCommit && !diagnostics.valid) {
      const first = diagnostics.errors.items[0];
      fail('VALIDATION_FAILED', `The edited model is invalid: ${diagnostics.errors.count} error(s)`, {
        details: {
          errors: diagnostics.errors.items.slice(0, 20),
          warnings: diagnostics.warnings.items.slice(0, 10),
          transactionId: this.id,
        },
        ...(first?.range
          ? { location: { uri: first.uri, line: first.range.start.line, character: first.range.start.character } }
          : {}),
        suggestions: [
          'Inspect the reported errors, fix the transaction with replace_text, then commit again',
          'Call rollback() to discard the transaction',
        ],
      });
    }

    const changes = new Map<string, string>();
    for (const [uri, text] of this.working) {
      if (this.baseTexts.get(uri) !== text) {
        changes.set(uri, text);
      }
    }

    const result = await this.store.commit({
      transactionId: this.id,
      actor: this.actor,
      baseRevision: this.baseRevision,
      baseTexts: this.baseTexts,
      changes,
      operations: this.operations,
      diagnostics,
      write: this.options.write,
    });
    this.closed = true;
    return result;
  }

  rollback(): void {
    if (this.closed) {
      return;
    }
    this.working = new Map(this.baseTexts);
    this.operations.length = 0;
    this.invalidate();
    this.closed = true;
  }

  private snapshotSources(): SourceFile[] {
    return [...this.working.entries()].map(([uri, text]) => ({ uri, text }));
  }

  private invalidate(): void {
    this.cachedIndex = undefined;
  }

  private assertOpen(): void {
    if (this.closed) {
      fail('INVALID_OPERATION', 'This transaction is already closed');
    }
  }

  private validateName(name: string): void {
    if (!nameIsValid(name)) {
      fail('INVALID_INPUT', `Invalid SysML identifier: '${name}'`, {
        details: { name },
        suggestions: ['Use a camelCase or PascalCase identifier matching [A-Za-z_][A-Za-z0-9_]*'],
      });
    }
  }

  private notFound(qname: string, what: string): EngineError {
    const suggestions = suggestNames(this.index(), qname);
    return new EngineError(
      makeError('ELEMENT_NOT_FOUND', `${what} not found: '${qname}'`, {
        details: { qname, suggestions },
        suggestions: suggestions.length
          ? [`Did you mean: ${suggestions.join(', ')}?`, 'Call model.list_elements to search the model']
          : ['Call model.list_elements to search the model'],
      })
    );
  }
}

function replaceReferenceName(text: string, oldName: string, newName: string): string | undefined {
  if (text === oldName) {
    return newName;
  }
  if (text.endsWith(`::${oldName}`)) {
    return `${text.slice(0, text.length - oldName.length)}${newName}`;
  }
  if (text === `'${oldName}'`) {
    return newName;
  }
  return undefined;
}

function applyOffsets(text: string, edits: Array<{ start: number; end: number; text: string }>): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.end > lastStart) {
      fail('INVALID_OPERATION', 'Overlapping edits produced by the operation');
    }
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    lastStart = edit.start;
  }
  return out;
}

function placeInside(
  text: string,
  parentRange: LspRange,
  declaration: string
): { text: string; insertAt: number } {
  const start = offsetAt(text, parentRange.start.line, parentRange.start.character);
  const end = offsetAt(text, parentRange.end.line, parentRange.end.character);
  // The parser range includes the closing brace; prefer that exact token over
  // searching for `}`, which could match a brace inside a comment/string.
  const closeAbsolute = text[end - 1] === '}' ? end - 1 : -1;

  const parentLineIndent = lineIndentAt(text, start);
  const childIndent = parentLineIndent + '    ';

  if (closeAbsolute >= 0) {
    const closeLineStart = text.lastIndexOf('\n', closeAbsolute) + 1;
    const closingIndent = text.slice(closeLineStart, closeAbsolute).match(/^\s*/)?.[0] ?? parentLineIndent;
    let prefix = text.slice(0, closeAbsolute);
    if (closingIndent.length > 0 && prefix.endsWith(closingIndent)) {
      prefix = prefix.slice(0, -closingIndent.length);
    }
    const needsNewline = !prefix.endsWith('\n');
    const insertion = `${needsNewline ? '\n' : ''}${indentDeclaration(declaration, childIndent)}\n${closingIndent}`;
    return {
      text: prefix + insertion + text.slice(closeAbsolute),
      insertAt: closeAbsolute,
    };
  }

  // Semicolon-terminated declaration: expand it into a body.
  const semicolon = text.lastIndexOf(';', end);
  if (semicolon >= start) {
    const replacement = ` {\n${indentDeclaration(declaration, childIndent)}\n${parentLineIndent}}`;
    return {
      text: text.slice(0, semicolon) + replacement + text.slice(semicolon + 1),
      insertAt: semicolon,
    };
  }

  const insertion = `\n${indentDeclaration(declaration, childIndent)}\n`;
  return { text: text.slice(0, end) + insertion + text.slice(end), insertAt: end };
}

/** Indent every non-empty line of a rendered declaration. */
function indentDeclaration(declaration: string, indent: string): string {
  return declaration
    .split('\n')
    .map((line) => (line.trim() ? indent + line : line))
    .join('\n');
}

function placeTopLevel(text: string, declaration: string): { text: string; insertAt: number } {
  const separator = text.length === 0 ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return {
    text: `${text}${separator}${declaration}\n`,
    insertAt: text.length,
  };
}

function lineIndentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  return text.slice(lineStart, offset).match(/^\s*/)?.[0] ?? '';
}

function expandDeletion(text: string, start: number, end: number): { start: number; end: number } {
  let lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  if (!/^\s*$/.test(text.slice(lineStart, start))) {
    lineStart = start;
  }
  let lineEnd = end;
  while (lineEnd < text.length && text[lineEnd] !== '\n') {
    lineEnd += 1;
  }
  if (text[lineEnd] === '\n') {
    lineEnd += 1;
  }
  // Remove a single blank line left behind by the deletion.
  if (text.slice(lineEnd, lineEnd + 1) === '\n') {
    lineEnd += 1;
  }
  return { start: lineStart, end: lineEnd };
}

/** Convenience wrapper used by tests and by the CLI. */
export async function inTransaction<T>(
  engine: EngineLike,
  options: TransactionOptions,
  fn: (tx: ModelTransaction) => T | Promise<T>
): Promise<{ value: T; commit: CommitResult }> {
  const tx = engine.beginTransaction(options);
  try {
    const value = await fn(tx);
    const commit = await tx.commit();
    return { value, commit };
  } catch (error) {
    tx.rollback();
    throw error;
  }
}
