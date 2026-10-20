import type { EditableKind } from './types.ts';

const DEFINITION_PREFIX: Record<string, string> = {
  'part def': 'part def',
  'item def': 'item def',
  'attribute def': 'attribute def',
  'port def': 'port def',
  'interface def': 'interface def',
  'connection def': 'connection def',
  'flow def': 'flow def',
  'allocation def': 'allocation def',
  'action def': 'action def',
  'state def': 'state def',
  'calculation def': 'calc def',
  'constraint def': 'constraint def',
  'requirement def': 'requirement def',
  'concern def': 'concern def',
  'analysis def': 'analysis def',
  'verification def': 'verification def',
  'use case def': 'use case def',
  'view def': 'view def',
  'viewpoint def': 'viewpoint def',
  'enum def': 'enum def',
  'metadata def': 'metadata def',
  'occurrence def': 'occurrence def',
  'individual def': 'individual def',
};

const USAGE_PREFIX: Record<string, string> = {
  part: 'part',
  item: 'item',
  attribute: 'attribute',
  port: 'port',
  action: 'action',
  state: 'state',
  constraint: 'constraint',
  requirement: 'requirement',
};

const BRACED_DEFINITIONS = new Set<string>(['package', ...Object.keys(DEFINITION_PREFIX)]);

export const EDITABLE_KINDS: EditableKind[] = [
  'package',
  ...(Object.keys(DEFINITION_PREFIX) as EditableKind[]),
  ...(Object.keys(USAGE_PREFIX) as EditableKind[]),
  'comment',
];

export function nameIsValid(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function escapeDoc(text: string): string {
  return text.replaceAll('*/', '* /').replaceAll('\r', '');
}

/**
 * Render a declaration, without indentation. `body` is raw SysML placed inside
 * the braces; `doc` becomes a SysML documentation comment.
 */
export function renderDeclaration(kind: EditableKind, name: string, body?: string, doc?: string): string {
  const docLine = doc ? `doc /* ${escapeDoc(doc)} */` : undefined;
  const inner = [docLine, body?.trim()].filter(Boolean).join('\n');

  if (kind === 'comment') {
    const text = escapeDoc(doc ?? body ?? name);
    return `comment /* ${text} */`;
  }

  if (kind === 'package') {
    return `package ${name} {\n${indentBlock(inner || '// empty package')}\n}`;
  }

  const prefix = DEFINITION_PREFIX[kind] ?? USAGE_PREFIX[kind];
  if (!prefix) {
    throw new Error(`Unsupported element kind: ${kind}`);
  }

  // Requirements without an explicit body still get a text attribute so the
  // created element is meaningful and valid.
  const effectiveInner =
    !inner && (kind === 'requirement def' || kind === 'requirement')
      ? 'attribute text : String = "TODO: requirement text";'
      : inner;

  if (Object.hasOwn(USAGE_PREFIX, kind)) {
    if (!effectiveInner) {
      return `${prefix} ${name};`;
    }
    if (kind === 'attribute' && /^\s*=/.test(effectiveInner)) {
      return `${prefix} ${name} ${effectiveInner.trim()};`;
    }
    return `${prefix} ${name} {\n${indentBlock(effectiveInner)}\n}`;
  }

  if (BRACED_DEFINITIONS.has(kind) && effectiveInner) {
    return `${prefix} ${name} {\n${indentBlock(effectiveInner)}\n}`;
  }
  return `${prefix} ${name};`;
}

export function indentBlock(text: string, spaces = 4): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.trim() ? pad + line : line))
    .join('\n');
}
