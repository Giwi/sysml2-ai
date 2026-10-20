/**
 * Structured errors are the contract between the engine and the agents.
 *
 * A tool must never leak an exception across the boundary: every failure is
 * converted into one of these records. `retryable` tells the agent whether
 * calling again (possibly after inspecting the model) can succeed.
 */

export type ErrorCategory =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'capability'
  | 'budget'
  | 'provider'
  | 'timeout'
  | 'cancelled'
  | 'internal';

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_OPERATION'
  | 'SYNTAX_ERROR'
  | 'VALIDATION_FAILED'
  | 'DUPLICATE_NAME'
  | 'NAME_COLLISION'
  | 'UNRESOLVED_REFERENCE'
  | 'ELEMENT_NOT_FOUND'
  | 'FILE_NOT_FOUND'
  | 'FILE_EXISTS'
  | 'REFERENCED_ELEMENT'
  | 'REVISION_CONFLICT'
  | 'LOCKED'
  | 'PATH_ESCAPE'
  | 'CAPABILITY_DENIED'
  | 'BUDGET_EXCEEDED'
  | 'TOOL_TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'CANCELLED'
  | 'INTERNAL';

export interface SourceLocation {
  uri: string;
  /** 0-based line. */
  line: number;
  /** 0-based character column. */
  character: number;
  endLine?: number;
  endCharacter?: number;
}

export interface StructuredError {
  code: ErrorCode;
  category: ErrorCategory;
  message: string;
  /** True when the same call may succeed once the model or environment changed. */
  retryable: boolean;
  /** Machine readable payload: offending qname, conflicting revision, issues, ... */
  details?: Record<string, unknown>;
  location?: SourceLocation;
  /** Concrete next actions the agent can take. */
  suggestions?: string[];
  causeId?: string;
}

const CATEGORY_BY_CODE: Record<ErrorCode, ErrorCategory> = {
  INVALID_INPUT: 'validation',
  INVALID_OPERATION: 'validation',
  SYNTAX_ERROR: 'validation',
  VALIDATION_FAILED: 'validation',
  DUPLICATE_NAME: 'validation',
  NAME_COLLISION: 'validation',
  UNRESOLVED_REFERENCE: 'validation',
  ELEMENT_NOT_FOUND: 'not_found',
  FILE_NOT_FOUND: 'not_found',
  FILE_EXISTS: 'conflict',
  REFERENCED_ELEMENT: 'conflict',
  REVISION_CONFLICT: 'conflict',
  LOCKED: 'conflict',
  PATH_ESCAPE: 'validation',
  CAPABILITY_DENIED: 'capability',
  BUDGET_EXCEEDED: 'budget',
  TOOL_TIMEOUT: 'timeout',
  PROVIDER_ERROR: 'provider',
  CANCELLED: 'cancelled',
  INTERNAL: 'internal',
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'REVISION_CONFLICT',
  'LOCKED',
  'TOOL_TIMEOUT',
  'PROVIDER_ERROR',
  'UNRESOLVED_REFERENCE',
]);

export interface ErrorInit {
  details?: Record<string, unknown>;
  location?: SourceLocation;
  suggestions?: string[];
  causeId?: string;
  retryable?: boolean;
}

export function makeError(code: ErrorCode, message: string, init: ErrorInit = {}): StructuredError {
  return {
    code,
    category: CATEGORY_BY_CODE[code],
    message,
    retryable: init.retryable ?? RETRYABLE.has(code),
    ...(init.details ? { details: init.details } : {}),
    ...(init.location ? { location: init.location } : {}),
    ...(init.suggestions?.length ? { suggestions: init.suggestions } : {}),
    ...(init.causeId ? { causeId: init.causeId } : {}),
  };
}

/** Error thrown inside the engine, carrying the agent-facing representation. */
export class EngineError extends Error {
  readonly error: StructuredError;

  constructor(error: StructuredError) {
    super(error.message);
    this.name = 'EngineError';
    this.error = error;
  }
}

/** Throw a structured error across the engine boundary. */
export function fail(code: ErrorCode, message: string, init: ErrorInit = {}): never {
  throw new EngineError(makeError(code, message, init));
}

export function isEngineError(value: unknown): value is EngineError {
  return value instanceof EngineError;
}

/** Convert any thrown value into a structured error. */
export function toStructuredError(thrown: unknown, fallbackCode: ErrorCode = 'INTERNAL'): StructuredError {
  if (isEngineError(thrown)) {
    return thrown.error;
  }
  if (isStructuredError(thrown)) {
    return thrown;
  }
  if (thrown instanceof Error) {
    const aborted = thrown.name === 'AbortError';
    return makeError(aborted ? 'CANCELLED' : fallbackCode, thrown.message, {
      details: thrown.stack ? { stack: thrown.stack.split('\n').slice(0, 8).join('\n') } : undefined,
    });
  }
  return makeError(fallbackCode, String(thrown));
}

function isStructuredError(value: unknown): value is StructuredError {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<StructuredError>;
  return typeof candidate.code === 'string' && typeof candidate.category === 'string' && typeof candidate.message === 'string';
}
