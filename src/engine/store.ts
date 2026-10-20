import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../contracts/errors.ts';
import { ModelIndex, shortRevision } from './index.ts';
import type { SourceFile } from './index.ts';
import type { CommitResult } from './types.ts';

export interface StoredFile {
  uri: string;
  text: string;
  revision: string;
  mtimeMs: number;
}

export interface StoreCommitRequest {
  transactionId: string;
  actor: string;
  intent?: string;
  baseRevision: string;
  baseTexts: Map<string, string | undefined>;
  changes: Map<string, string>;
  operations: CommitResult['operations'];
  diagnostics: CommitResult['diagnostics'];
  write: boolean;
}

const MODEL_EXTENSIONS = ['.sysml', '.kerml'];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.sysml-ai', '.vscode', '.idea']);
const STATE_DIR = '.sysml-ai';

export class WorkspaceStore {
  readonly root: string;
  private files = new Map<string, StoredFile>();
  private cachedIndex?: ModelIndex;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(root: string): Promise<WorkspaceStore> {
    const absoluteRoot = resolve(root);
    const stat = await fs.stat(absoluteRoot).catch(() => undefined);
    if (!stat?.isDirectory()) {
      fail('FILE_NOT_FOUND', `Model directory not found: ${absoluteRoot}`);
    }
    const store = new WorkspaceStore(absoluteRoot);
    await store.reload();
    return store;
  }

  async reload(): Promise<void> {
    this.files.clear();
    this.cachedIndex = undefined;
    const paths = await walk(this.root);
    const loaded = await Promise.all(
      paths.map(async (path) => {
        const [text, stat] = await Promise.all([fs.readFile(path, 'utf8'), fs.stat(path)]);
        return {
          uri: toUri(this.root, path),
          text,
          revision: shortRevision(text),
          mtimeMs: stat.mtimeMs,
        };
      })
    );
    for (const file of loaded) {
      this.files.set(file.uri, file);
    }
  }

  list(): StoredFile[] {
    return [...this.files.values()].sort((a, b) => a.uri.localeCompare(b.uri));
  }

  get(uri: string): StoredFile | undefined {
    return this.files.get(normalizeUri(uri));
  }

  snapshot(): SourceFile[] {
    return this.list().map(({ uri, text }) => ({ uri, text }));
  }

  index(): ModelIndex {
    if (!this.cachedIndex) {
      this.cachedIndex = ModelIndex.build(this.snapshot());
    }
    return this.cachedIndex;
  }

  /** Path of a workspace-relative model URI, guarded against traversal. */
  absolutePath(uri: string): string {
    const normalized = normalizeUri(uri);
    if (!normalized || isAbsolute(normalized) || normalized.split('/').includes('..')) {
      fail('PATH_ESCAPE', `Invalid model path: ${uri}`, {
        suggestions: ['Use a workspace-relative POSIX path such as "models/vehicle.sysml"'],
      });
    }
    if (!MODEL_EXTENSIONS.some((ext) => normalized.endsWith(ext))) {
      fail('INVALID_INPUT', `Not a SysML/KerML file: ${normalized}`, {
        details: { extensions: MODEL_EXTENSIONS },
      });
    }
    const absolute = resolve(this.root, normalized);
    const rel = relative(this.root, absolute);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      fail('PATH_ESCAPE', `Path escapes the workspace: ${uri}`);
    }
    return absolute;
  }

  async readDisk(uri: string): Promise<string | undefined> {
    const path = this.absolutePath(uri);
    try {
      return await fs.readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Two-phase write:
   * 1. check disk revisions and stage every new file under `.sysml-ai`;
   * 2. re-check, rename into place, restore backups on any failure.
   *
   * The journal is best effort: losing observability must not undo a valid
   * model commit.
   */
  async commit(request: StoreCommitRequest): Promise<CommitResult> {
    const changed = [...request.changes.entries()].filter(([uri, text]) => request.baseTexts.get(uri) !== text);
    if (changed.length === 0) {
      return {
        transactionId: request.transactionId,
        actor: request.actor,
        baseRevision: request.baseRevision,
        revision: this.index().revision,
        changedFiles: [],
        operations: request.operations,
        diagnostics: request.diagnostics,
        committedAt: new Date().toISOString(),
      };
    }

    // Optimistic concurrency check before touching anything.
    for (const [uri] of changed) {
      const disk = await this.readDisk(uri);
      const base = request.baseTexts.get(uri);
      if ((disk ?? undefined) !== (base ?? undefined)) {
        fail('REVISION_CONFLICT', `File '${uri}' changed on disk since the transaction started`, {
          details: {
            uri,
            expectedRevision: base === undefined ? 'missing' : shortRevision(base),
            actualRevision: disk === undefined ? 'missing' : shortRevision(disk),
          },
          location: { uri, line: 0, character: 0 },
          suggestions: ['Re-read the model and retry the edit against the current revision'],
        });
      }
    }

    const txDir = join(this.root, STATE_DIR, 'transactions', request.transactionId);
    const backupDir = join(txDir, 'backup');
    const stagingDir = join(txDir, 'staging');
    await fs.mkdir(backupDir, { recursive: true });
    await fs.mkdir(stagingDir, { recursive: true });

    const staged: Array<{ uri: string; target: string; temp: string; backup?: string; created: boolean; afterRevision: string }> = [];
    const before = new Map<string, string | undefined>();

    for (const [uri, text] of changed) {
      const target = this.absolutePath(uri);
      const base = request.baseTexts.get(uri);
      before.set(uri, base);
      const created = base === undefined;
      let backup: string | undefined;
      if (!created) {
        backup = join(backupDir, uri.replaceAll('/', '__'));
        await fs.writeFile(backup, base, 'utf8');
      }
      const temp = join(stagingDir, `${uri.replaceAll('/', '__')}.${randomUUID().slice(0, 8)}.tmp`);
      await fs.writeFile(temp, text, 'utf8');
      staged.push({ uri, target, temp, backup, created, afterRevision: shortRevision(text) });
    }

    // Second check right before renaming, to narrow the race window.
    for (const item of staged) {
      const disk = existsSync(item.target) ? await fs.readFile(item.target, 'utf8') : undefined;
      const base = before.get(item.uri);
      if ((disk ?? undefined) !== (base ?? undefined)) {
        await cleanupStaging(staged);
        fail('REVISION_CONFLICT', `File '${item.uri}' changed during commit`, {
          details: { uri: item.uri },
          retryable: true,
        });
      }
    }

    if (request.write) {
      const renamed: typeof staged = [];
      try {
        for (const item of staged) {
          await fs.mkdir(dirname(item.target), { recursive: true });
          await fs.rename(item.temp, item.target);
          renamed.push(item);
        }
      } catch (error) {
        // Best effort rollback of the files already renamed.
        for (const item of renamed.reverse()) {
          if (item.created) {
            await fs.rm(item.target, { force: true });
          } else if (item.backup) {
            await fs.copyFile(item.backup, item.target);
          }
        }
        await cleanupStaging(staged);
        fail('INTERNAL', `Failed to write model transaction: ${(error as Error).message}`, {
          details: { transactionId: request.transactionId },
        });
      }

      for (const item of staged) {
        const stat = await fs.stat(item.target);
        this.files.set(item.uri, {
          uri: item.uri,
          text: request.changes.get(item.uri) ?? '',
          revision: item.afterRevision,
          mtimeMs: stat.mtimeMs,
        });
      }
      this.cachedIndex = undefined;
    } else {
      await cleanupStaging(staged);
      // Dry runs keep no backups: nothing changed on disk.
      await fs.rm(txDir, { recursive: true, force: true });
    }

    const changedFiles = staged.map((item) => {
      const beforeText = before.get(item.uri) ?? '';
      const afterText = request.changes.get(item.uri) ?? '';
      const stats = lineStats(beforeText, afterText);
      return {
        uri: item.uri,
        beforeRevision: before.get(item.uri) === undefined ? 'missing' : shortRevision(beforeText),
        afterRevision: item.afterRevision,
        added: stats.added,
        removed: stats.removed,
      };
    });

    const result: CommitResult = {
      transactionId: request.transactionId,
      actor: request.actor,
      baseRevision: request.baseRevision,
      revision: request.write ? this.index().revision : globalAfter(request.baseRevision, changedFiles),
      changedFiles,
      operations: request.operations,
      diagnostics: request.diagnostics,
      committedAt: new Date().toISOString(),
    };

    await this.appendJournal({
      ...result,
      intent: request.intent,
      write: request.write,
    }).catch(() => undefined);
    return result;
  }

  private async appendJournal(entry: Record<string, unknown>): Promise<void> {
    const dir = join(this.root, STATE_DIR);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(join(dir, 'journal.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
  }

  /** Restore a file to a previous revision captured by the journal/backup system. */
  async restore(transactionId: string, uri: string): Promise<string> {
    const normalized = normalizeUri(uri);
    this.absolutePath(normalized); // validates extension and traversal
    const backup = join(this.root, STATE_DIR, 'transactions', transactionId, 'backup', normalized.replaceAll('/', '__'));
    const text = await fs.readFile(backup, 'utf8').catch(() => undefined);
    if (text === undefined) {
      fail('FILE_NOT_FOUND', `No backup for '${normalized}' in transaction ${transactionId}`);
    }
    const target = this.absolutePath(normalized);
    await fs.writeFile(target, text, 'utf8');
    this.files.set(normalized, {
      uri: normalized,
      text,
      revision: shortRevision(text),
      mtimeMs: Date.now(),
    });
    this.cachedIndex = undefined;
    return shortRevision(text);
  }
}

function normalizeUri(uri: string): string {
  return uri.replaceAll('\\', '/').replace(/^\.\//, '');
}

function toUri(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/');
}

/** Added/removed line counts using a longest-common-subsequence diff. */
function lineStats(before: string, after: string): { added: number; removed: number } {
  const a = before.length === 0 ? [] : before.split('\n');
  const b = after.length === 0 ? [] : after.split('\n');
  if (a.length === 0) return { added: b.length, removed: 0 };
  if (b.length === 0) return { added: 0, removed: a.length };
  // Guard against pathological files; fall back to whole-file counts.
  if (a.length * b.length > 4_000_000) {
    return { added: b.length, removed: a.length };
  }
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  const common = previous[b.length];
  return { added: b.length - common, removed: a.length - common };
}

function globalAfter(baseRevision: string, changed: Array<{ afterRevision: string }>): string {
  return shortRevision(`${baseRevision}:${changed.map((c) => c.afterRevision).join(',')}`);
}

async function cleanupStaging(staged: Array<{ temp: string }>): Promise<void> {
  await Promise.all(staged.map((item) => fs.rm(item.temp, { force: true })));
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        await visit(path);
      } else if (entry.isFile() && MODEL_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        out.push(path);
      }
    }
  };
  await visit(root);
  return out.sort();
}
