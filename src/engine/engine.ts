import { ModelIndex } from './index.ts';
import { WorkspaceStore } from './store.ts';
import { ModelTransaction } from './transaction.ts';
import type { TransactionOptions, ModelSnapshotInfo, ValidationReport } from './types.ts';

/**
 * Deterministic SysML model engine. This is the only component allowed to read
 * or mutate model files. Agents reach it exclusively through typed tools.
 */
export class WorkspaceEngine {
  readonly store: WorkspaceStore;

  private constructor(store: WorkspaceStore) {
    this.store = store;
  }

  static async open(root: string): Promise<WorkspaceEngine> {
    return new WorkspaceEngine(await WorkspaceStore.open(root));
  }

  index(): ModelIndex {
    return this.store.index();
  }

  snapshotInfo(): ModelSnapshotInfo {
    return this.store.index().snapshotInfo(this.store.root);
  }

  validate(): ValidationReport {
    return this.store.index().diagnostics;
  }

  beginTransaction(options: TransactionOptions): ModelTransaction {
    return new ModelTransaction(this.store, options);
  }

  async reload(): Promise<void> {
    await this.store.reload();
  }
}
