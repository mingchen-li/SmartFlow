import { z } from 'zod';

/**
 * RFC 6902 JSON Patch for Agent-originated mutations (ADR-0005).
 *
 * Agent proposals are typed operations, never direct writes. The Server
 * applies them to a draft copy, validates the result with the strict Workflow
 * IR schema and `validateWorkflow`, and only then persists it. This module is
 * pure and shared by the Server and the Web preview UI.
 */

export const JsonPatchOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('add'),
    path: z.string(),
    value: z.unknown(),
  }),
  z.strictObject({
    op: z.literal('remove'),
    path: z.string(),
  }),
  z.strictObject({
    op: z.literal('replace'),
    path: z.string(),
    value: z.unknown(),
  }),
  z.strictObject({
    op: z.literal('move'),
    from: z.string(),
    path: z.string(),
  }),
  z.strictObject({
    op: z.literal('copy'),
    from: z.string(),
    path: z.string(),
  }),
  z.strictObject({
    op: z.literal('test'),
    path: z.string(),
    value: z.unknown(),
  }),
]);
export type JsonPatchOperation = z.infer<typeof JsonPatchOperationSchema>;

export type JsonPatchErrorCode =
  | 'INVALID_PATH'
  | 'PATH_NOT_FOUND'
  | 'INVALID_OPERATION'
  | 'TEST_FAILED';

export class JsonPatchError extends Error {
  readonly code: JsonPatchErrorCode;
  readonly path: string;
  readonly operationIndex: number;

  constructor(
    code: JsonPatchErrorCode,
    message: string,
    path: string,
    operationIndex: number,
  ) {
    super(message);
    this.name = 'JsonPatchError';
    this.code = code;
    this.path = path;
    this.operationIndex = operationIndex;
  }
}

export interface JsonPatchApplication {
  result: unknown;
  /** Ordered operations that restore the input document when applied to `result`. */
  inverse: JsonPatchOperation[];
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeToken(token: string, path: string, operationIndex: number): string {
  if (/~(?![01])/.test(token)) {
    throw new JsonPatchError(
      'INVALID_PATH',
      `Invalid JSON Pointer escape in "${path}".`,
      path,
      operationIndex,
    );
  }
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function parsePointer(
  path: string,
  operationIndex: number,
): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) {
    throw new JsonPatchError(
      'INVALID_PATH',
      `JSON Pointer "${path}" must start with "/".`,
      path,
      operationIndex,
    );
  }
  return path
    .slice(1)
    .split('/')
    .map((token) => decodeToken(token, path, operationIndex));
}

function parseArrayIndex(
  token: string,
  length: number,
  allowEnd: boolean,
  path: string,
  operationIndex: number,
): number {
  if (allowEnd && token === '-') return length;
  if (!/^(?:0|[1-9]\d*)$/.test(token)) {
    throw new JsonPatchError(
      'INVALID_PATH',
      `"${token}" is not a valid array index in "${path}".`,
      path,
      operationIndex,
    );
  }

  const index = Number(token);
  if (allowEnd ? index > length : index >= length) {
    throw new JsonPatchError(
      'PATH_NOT_FOUND',
      `Array index ${index} is outside "${path}".`,
      path,
      operationIndex,
    );
  }
  return index;
}

interface ParentReference {
  parent: JsonObject | unknown[];
  key: string;
}

/** Resolves the container and final token of a pointer. Root writes are not allowed. */
function resolveParent(
  document: unknown,
  tokens: readonly string[],
  path: string,
  operationIndex: number,
): ParentReference {
  if (tokens.length === 0) {
    throw new JsonPatchError(
      'INVALID_PATH',
      'Root-level patch operations are not supported.',
      path,
      operationIndex,
    );
  }

  let current = document;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index]!;
    if (Array.isArray(current)) {
      const arrayIndex = parseArrayIndex(
        token,
        current.length,
        false,
        path,
        operationIndex,
      );
      current = current[arrayIndex];
    } else if (isJsonObject(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, token)) {
        throw new JsonPatchError(
          'PATH_NOT_FOUND',
          `The parent path "${path}" does not exist.`,
          path,
          operationIndex,
        );
      }
      current = current[token];
    } else {
      throw new JsonPatchError(
        'PATH_NOT_FOUND',
        `The parent path "${path}" does not exist.`,
        path,
        operationIndex,
      );
    }
  }

  if (!Array.isArray(current) && !isJsonObject(current)) {
    throw new JsonPatchError(
      'PATH_NOT_FOUND',
      `The parent path "${path}" does not exist.`,
      path,
      operationIndex,
    );
  }

  return { parent: current, key: tokens[tokens.length - 1]! };
}

function resolveValue(
  document: unknown,
  tokens: readonly string[],
  path: string,
  operationIndex: number,
): unknown {
  if (tokens.length === 0) return document;

  const { parent, key } = resolveParent(document, tokens, path, operationIndex);
  if (Array.isArray(parent)) {
    const index = parseArrayIndex(key, parent.length, false, path, operationIndex);
    return parent[index];
  }

  if (!Object.prototype.hasOwnProperty.call(parent, key)) {
    throw new JsonPatchError(
      'PATH_NOT_FOUND',
      `The path "${path}" does not exist.`,
      path,
      operationIndex,
    );
  }
  return parent[key];
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    );
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        jsonEqual(left[key], right[key]),
    );
  }
  return false;
}

/** Inserts or replaces a value and returns operations that undo the insertion. */
function addValue(
  parent: JsonObject | unknown[],
  key: string,
  value: unknown,
  path: string,
  operationIndex: number,
  cloneValue: boolean,
): JsonPatchOperation[] {
  if (Array.isArray(parent)) {
    const index = parseArrayIndex(key, parent.length, true, path, operationIndex);
    parent.splice(index, 0, cloneValue ? structuredClone(value) : value);
    // A "-" token addresses the end of the array; its inverse needs the
    // concrete index. Otherwise the operation path already identifies the
    // inserted element.
    const undoPath =
      key === '-' ? `${path.slice(0, path.length - 2)}/${index}` : path;
    return [{ op: 'remove', path: undoPath }];
  }

  const existed = Object.prototype.hasOwnProperty.call(parent, key);
  const previous = existed ? parent[key] : undefined;
  parent[key] = cloneValue ? structuredClone(value) : value;
  return existed
    ? [{ op: 'replace', path, value: previous }]
    : [{ op: 'remove', path }];
}

/** Removes a value and returns operations that restore it. */
function removeValue(
  parent: JsonObject | unknown[],
  key: string,
  path: string,
  operationIndex: number,
): JsonPatchOperation[] {
  if (Array.isArray(parent)) {
    const index = parseArrayIndex(key, parent.length, false, path, operationIndex);
    const [removed] = parent.splice(index, 1);
    return [{ op: 'add', path, value: removed }];
  }

  if (!Object.prototype.hasOwnProperty.call(parent, key)) {
    throw new JsonPatchError(
      'PATH_NOT_FOUND',
      `The path "${path}" does not exist.`,
      path,
      operationIndex,
    );
  }
  const removed = parent[key];
  delete parent[key];
  return [{ op: 'add', path, value: removed }];
}

function applyOperation(
  document: unknown,
  operation: JsonPatchOperation,
  operationIndex: number,
): JsonPatchOperation[] {
  const pathTokens = parsePointer(operation.path, operationIndex);

  switch (operation.op) {
    case 'add': {
      const { parent, key } = resolveParent(
        document,
        pathTokens,
        operation.path,
        operationIndex,
      );
      return addValue(
        parent,
        key,
        operation.value,
        operation.path,
        operationIndex,
        true,
      );
    }
    case 'remove': {
      const { parent, key } = resolveParent(
        document,
        pathTokens,
        operation.path,
        operationIndex,
      );
      return removeValue(parent, key, operation.path, operationIndex);
    }
    case 'replace': {
      const { parent, key } = resolveParent(
        document,
        pathTokens,
        operation.path,
        operationIndex,
      );
      if (Array.isArray(parent)) {
        const index = parseArrayIndex(
          key,
          parent.length,
          false,
          operation.path,
          operationIndex,
        );
        const previous = parent[index];
        parent[index] = structuredClone(operation.value);
        return [{ op: 'replace', path: operation.path, value: previous }];
      }

      if (!Object.prototype.hasOwnProperty.call(parent, key)) {
        throw new JsonPatchError(
          'PATH_NOT_FOUND',
          `The path "${operation.path}" does not exist.`,
          operation.path,
          operationIndex,
        );
      }
      const previous = parent[key];
      parent[key] = structuredClone(operation.value);
      return [{ op: 'replace', path: operation.path, value: previous }];
    }
    case 'move': {
      if (operation.from === operation.path) return [];
      if (operation.from !== '' && operation.path.startsWith(`${operation.from}/`)) {
        throw new JsonPatchError(
          'INVALID_OPERATION',
          `Cannot move "${operation.from}" into its own child "${operation.path}".`,
          operation.path,
          operationIndex,
        );
      }

      const fromTokens = parsePointer(operation.from, operationIndex);
      const fromParentReference = resolveParent(
        document,
        fromTokens,
        operation.from,
        operationIndex,
      );
      const source = resolveValue(
        document,
        fromTokens,
        operation.from,
        operationIndex,
      );
      const sourceValue = structuredClone(source);
      removeValue(
        fromParentReference.parent,
        fromParentReference.key,
        operation.from,
        operationIndex,
      );

      const { parent, key } = resolveParent(
        document,
        pathTokens,
        operation.path,
        operationIndex,
      );
      const targetUndo = addValue(
        parent,
        key,
        sourceValue,
        operation.path,
        operationIndex,
        false,
      );
      return [...targetUndo, { op: 'add', path: operation.from, value: sourceValue }];
    }
    case 'copy': {
      const fromTokens = parsePointer(operation.from, operationIndex);
      const source = structuredClone(
        resolveValue(document, fromTokens, operation.from, operationIndex),
      );
      const { parent, key } = resolveParent(
        document,
        pathTokens,
        operation.path,
        operationIndex,
      );
      return addValue(parent, key, source, operation.path, operationIndex, false);
    }
    case 'test': {
      const value = resolveValue(
        document,
        pathTokens,
        operation.path,
        operationIndex,
      );
      if (!jsonEqual(value, operation.value)) {
        throw new JsonPatchError(
          'TEST_FAILED',
          `The value at "${operation.path}" does not match the expected value.`,
          operation.path,
          operationIndex,
        );
      }
      return [];
    }
  }
}

/**
 * Applies RFC 6902 operations to a deep copy of `document` and returns the
 * result together with an inverse patch for safe rollback.
 */
export function applyJsonPatch(
  document: unknown,
  operations: readonly JsonPatchOperation[],
): JsonPatchApplication {
  const working = structuredClone(document);
  const undoGroups: JsonPatchOperation[][] = [];

  operations.forEach((operation, index) => {
    undoGroups.push(applyOperation(working, operation, index));
  });

  const inverse: JsonPatchOperation[] = [];
  for (let index = undoGroups.length - 1; index >= 0; index -= 1) {
    inverse.push(...undoGroups[index]!);
  }

  return { result: working, inverse };
}

/**
 * Resolves a JSON Pointer against a document. Used by the diff preview; throws
 * `JsonPatchError` when the path is missing.
 */
export function resolveJsonPointer(document: unknown, path: string): unknown {
  return resolveValue(document, parsePointer(path, 0), path, 0);
}

/** Formats a pointer as a readable dotted/indexed path, e.g. `nodes[0].label`. */
export function formatJsonPointer(path: string): string {
  if (path === '') return 'Workflow';
  const tokens = path
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));

  return tokens
    .map((token, index) => {
      if (/^(?:0|[1-9]\d*)$/.test(token)) return `[${token}]`;
      return index === 0 ? token : `.${token}`;
    })
    .join('');
}
