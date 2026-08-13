import type { CapabilityIssue } from "./schema-types.ts";

/**
 * JSON Schema describes JSON data, so reject JavaScript-only values even when
 * the schema is unconstrained or permits additional properties. This matters
 * for direct invocation and multipart forms, which can otherwise introduce
 * values such as `File`/`Blob` that JSON requests can never represent.
 */
export function findNonJsonIssue(
  value: unknown,
  path: string,
  ancestors = new Set<object>(),
): CapabilityIssue | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return null;
  }

  if (typeof value !== "object") {
    return { path, message: `must be JSON-serializable, got ${typeof value}` };
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    return { path, message: "must be JSON-serializable, got object" };
  }
  if (ancestors.has(value)) {
    return { path, message: "must be JSON-serializable, got a circular reference" };
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        ancestors.delete(value);
        return {
          path: `${path}/${index}`,
          message: "must be JSON-serializable, got a sparse array slot",
        };
      }
      const issue = findNonJsonIssue(value[index], `${path}/${index}`, ancestors);
      if (issue) {
        ancestors.delete(value);
        return issue;
      }
    }
  } else {
    for (const [key, entry] of Object.entries(value)) {
      const issue = findNonJsonIssue(entry, `${path}/${key}`, ancestors);
      if (issue) {
        ancestors.delete(value);
        return issue;
      }
    }
  }
  ancestors.delete(value);
  return null;
}

export function isJsonValue(value: unknown): boolean {
  return findNonJsonIssue(value, "") === null;
}

export function jsonEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => jsonEquals(item, right[index]))
    );
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && jsonEquals(left[key], right[key]))
    );
  }
  return false;
}

export function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
