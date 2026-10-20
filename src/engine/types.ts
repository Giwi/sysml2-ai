import type { LspRange } from './parser/model.ts';

export type { LspRange };

export interface Position {
  /** 0-based. */
  line: number;
  /** 0-based. */
  character: number;
}

export interface FileInfo {
  /** Workspace-relative POSIX path, used as the model URI. */
  uri: string;
  revision: string;
  bytes: number;
  elementCount: number;
  errorCount: number;
}

export interface ModelSnapshotInfo {
  root: string;
  revision: string;
  files: FileInfo[];
}

export interface ElementSummary {
  id: string;
  name: string;
  shortName?: string;
  qname: string;
  kind: string;
  uri: string;
  parentQname?: string;
  range: LspRange;
  childrenCount: number;
}

export interface ReferenceView {
  kind: string;
  text: string;
  uri: string;
  range: LspRange;
  targetQname?: string;
  resolved: boolean;
}

export interface ElementView extends ElementSummary {
  children: ElementSummary[];
  refs: ReferenceView[];
  /** Bounded source excerpt for the element. */
  source: string;
  /** References elsewhere in the workspace whose target is this element. */
  incomingReferences: Array<{ uri: string; range: LspRange; text: string; kind: string; sourceLine: string }>;
}

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
  uri: string;
  range?: LspRange;
  qname?: string;
  details?: Record<string, unknown>;
}

export interface ValidationReport {
  valid: boolean;
  revision: string;
  errors: Numbered<ValidationIssue>;
  warnings: Numbered<ValidationIssue>;
  /** Total unresolved references (not capped by `warnings`). */
  unresolvedReferences: number;
  filesChecked: number;
  elementsChecked: number;
}

export interface Numbered<T> {
  count: number;
  items: T[];
  /** True when the list was capped. */
  truncated?: boolean;
}

export type EditableKind =
  | 'package'
  | 'part def'
  | 'part'
  | 'item def'
  | 'item'
  | 'attribute def'
  | 'attribute'
  | 'port def'
  | 'port'
  | 'interface def'
  | 'connection def'
  | 'flow def'
  | 'allocation def'
  | 'action def'
  | 'action'
  | 'state def'
  | 'state'
  | 'calculation def'
  | 'constraint def'
  | 'constraint'
  | 'requirement def'
  | 'requirement'
  | 'concern def'
  | 'analysis def'
  | 'verification def'
  | 'use case def'
  | 'view def'
  | 'viewpoint def'
  | 'enum def'
  | 'metadata def'
  | 'occurrence def'
  | 'individual def'
  | 'comment';

export interface CreateElementInput {
  uri: string;
  parentQname?: string;
  kind: EditableKind;
  name: string;
  /** Raw SysML inserted inside the generated body. */
  body?: string;
  /** Documentation comment inserted inside the body. */
  doc?: string;
}

export interface RenameElementInput {
  qname: string;
  newName: string;
  updateReferences?: boolean;
}

export interface DeleteElementInput {
  qname: string;
  force?: boolean;
}

export interface ReplaceOp {
  type: 'replace';
  uri: string;
  range: {
    start: Position;
    end: Position;
  };
  text: string;
}

export interface CommitResult {
  transactionId: string;
  actor: string;
  baseRevision: string;
  revision: string;
  changedFiles: Array<{ uri: string; beforeRevision: string; afterRevision: string; added: number; removed: number }>;
  operations: AppliedOperation[];
  diagnostics: ValidationReport;
  committedAt: string;
}

export interface AppliedOperation {
  op: string;
  uri: string;
  qname?: string;
  description: string;
}

export interface TransactionOptions {
  actor: string;
  /** Refuse to commit when validation reports errors. Default true. */
  validateOnCommit?: boolean;
  /** Write changes to disk. Default true. */
  write?: boolean;
}
