import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fail, makeError } from '../contracts/errors.ts';

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
}

export interface LockRelease {
  release(): Promise<void>;
}

export class FileLockManager {
  private readonly lockDir: string;
  private readonly timeoutMs: number;
  private readonly staleMs: number;
  private readonly pollMs: number;

  constructor(root: string, options: LockOptions = {}) {
    this.lockDir = join(root, '.sysml-ai', 'locks');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.staleMs = options.staleMs ?? 120_000;
    this.pollMs = options.pollMs ?? 100;
  }

  async acquireMany(keys: string[], signal?: AbortSignal): Promise<LockRelease> {
    const unique = [...new Set(keys)].sort();
    const releases: LockRelease[] = [];
    try {
      for (const key of unique) {
        releases.push(await this.acquire(key, signal));
      }
      return {
        release: async () => {
          for (const lock of releases.reverse()) {
            await lock.release();
          }
        },
      };
    } catch (error) {
      for (const lock of releases.reverse()) {
        await lock.release();
      }
      throw error;
    }
  }

  async acquire(key: string, signal?: AbortSignal): Promise<LockRelease> {
    await fs.mkdir(this.lockDir, { recursive: true });
    const path = join(this.lockDir, `${createHash('sha256').update(key).digest('hex').slice(0, 24)}.lock`);
    const deadline = Date.now() + this.timeoutMs;
    while (true) {
      if (signal?.aborted) {
        fail('CANCELLED', 'Lock acquisition cancelled');
      }
      try {
        const handle = await fs.open(path, 'wx');
        await handle.writeFile(JSON.stringify({ pid: process.pid, key, at: Date.now() }), 'utf8');
        await handle.close();
        let released = false;
        return {
          release: async () => {
            if (released) return;
            released = true;
            await fs.rm(path, { force: true });
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        const stat = await fs.stat(path).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs > this.staleMs) {
          await fs.rm(path, { force: true });
          continue;
        }
        if (Date.now() > deadline) {
          fail('LOCKED', `Model lock '${key}' is held by another writer`, {
            details: { key, lockFile: path, staleMs: this.staleMs },
            suggestions: ['Wait for the other agent to finish', 'Reduce write concurrency'],
          });
        }
        await sleep(this.pollMs, signal);
      }
    }
  }

  async inspect(): Promise<Array<{ key: string; pid?: number; at?: number; file: string }>> {
    const entries = await fs.readdir(this.lockDir, { withFileTypes: true }).catch(() => []);
    const out: Array<{ key: string; pid?: number; at?: number; file: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.lock')) continue;
      const file = join(this.lockDir, entry.name);
      const payload: { key?: string; pid?: number; at?: number } = await fs
        .readFile(file, 'utf8')
        .then((text) => JSON.parse(text) as { key?: string; pid?: number; at?: number })
        .catch(() => ({}));
      out.push({ file, ...payload, key: payload.key ?? entry.name });
    }
    return out;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeError('CANCELLED', 'Lock wait cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(makeError('CANCELLED', 'Lock wait cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
