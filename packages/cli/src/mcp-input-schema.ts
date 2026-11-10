/**
 * Input schemas for the `pracht dev-mcp` tools.
 *
 * The authoring tools take flat argument objects of strings, booleans, bounded
 * integers, string enums and arrays of those. This module describes exactly
 * that: one declaration per tool yields the JSON Schema (draft-07) advertised
 * in `tools/list`, validates `tools/call` arguments, and types the handler's
 * input. Keeping it local spares every app's `@pracht/cli` install a schema
 * library.
 *
 * Validation strips unknown keys, and invalid arguments are reported as a JSON
 * array of `{ code, path, message, ... }` issues — the same shape and wording
 * agents saw when these schemas were zod objects.
 */

type PathSegment = string | number;

export interface InputIssue {
  code: string;
  path: PathSegment[];
  message: string;
  [detail: string]: unknown;
}

type JsonSchema = Readonly<Record<string, unknown>>;

const INVALID: unique symbol = Symbol("invalid");

export interface InputSchema<T> {
  /** JSON Schema for one value of this type. */
  readonly json: JsonSchema;
  /** Returns the parsed value, or records issues and returns `INVALID`. */
  parse(value: unknown, path: PathSegment[], issues: InputIssue[]): T | typeof INVALID;
}

export interface InputField<T, Optional extends boolean = boolean> {
  readonly schema: InputSchema<T>;
  readonly optional: Optional;
  readonly description: string;
}

export type InputShape = Readonly<Record<string, InputField<unknown>>>;

type FieldValue<F> = F extends InputField<infer T, boolean> ? T : never;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** The handler input a shape validates to. */
export type InferInput<S extends InputShape> = Simplify<
  {
    -readonly [K in keyof S as S[K]["optional"] extends true ? never : K]: FieldValue<S[K]>;
  } & {
    -readonly [K in keyof S as S[K]["optional"] extends true ? K : never]?: FieldValue<S[K]>;
  }
>;

export function required<T>(schema: InputSchema<T>, description: string): InputField<T, false> {
  return { schema, optional: false, description };
}

export function optional<T>(schema: InputSchema<T>, description: string): InputField<T, true> {
  return { schema, optional: true, description };
}

export function string(): InputSchema<string> {
  return {
    json: { type: "string" },
    parse: (value, path, issues) =>
      typeof value === "string" ? value : invalidType("string", value, path, issues),
  };
}

export function boolean(): InputSchema<boolean> {
  return {
    json: { type: "boolean" },
    parse: (value, path, issues) =>
      typeof value === "boolean" ? value : invalidType("boolean", value, path, issues),
  };
}

export interface IntegerBounds {
  minimum?: number;
  /** Values must be strictly greater than this. Takes the place of `minimum`. */
  exclusiveMinimum?: number;
  maximum?: number;
}

/** A safe integer, optionally bounded. */
export function integer(bounds: IntegerBounds = {}): InputSchema<number> {
  const { exclusiveMinimum, maximum, minimum } = bounds;
  return {
    json: {
      type: "integer",
      ...(exclusiveMinimum === undefined
        ? { minimum: minimum ?? Number.MIN_SAFE_INTEGER }
        : { exclusiveMinimum }),
      maximum: maximum ?? Number.MAX_SAFE_INTEGER,
    },
    parse(value, path, issues) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        // NaN and ±Infinity are numbers to typeof, so the issue says which.
        const received =
          typeof value === "number" ? (Number.isNaN(value) ? "NaN" : "Infinity") : undefined;
        return invalidType("number", value, path, issues, received);
      }
      if (!Number.isInteger(value)) {
        issues.push({
          expected: "int",
          format: "safeint",
          code: "invalid_type",
          path,
          message: "Invalid input: expected int, received number",
        });
        return INVALID;
      }
      const before = issues.length;
      if (value > Number.MAX_SAFE_INTEGER) {
        issues.push(unsafeInteger("too_big", "maximum", Number.MAX_SAFE_INTEGER, path));
      } else if (value < Number.MIN_SAFE_INTEGER) {
        issues.push(unsafeInteger("too_small", "minimum", Number.MIN_SAFE_INTEGER, path));
      }
      if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) {
        issues.push(outOfRange("too_small", "minimum", exclusiveMinimum, false, path));
      } else if (minimum !== undefined && value < minimum) {
        issues.push(outOfRange("too_small", "minimum", minimum, true, path));
      }
      if (maximum !== undefined && value > maximum) {
        issues.push(outOfRange("too_big", "maximum", maximum, true, path));
      }
      return issues.length === before ? value : INVALID;
    },
  };
}

/** One of a fixed set of strings. */
export function oneOf<const Values extends readonly [string, ...string[]]>(
  values: Values,
): InputSchema<Values[number]> {
  return {
    json: { type: "string", enum: [...values] },
    parse(value, path, issues) {
      if ((values as readonly unknown[]).includes(value)) return value as Values[number];
      issues.push({
        code: "invalid_value",
        values: [...values],
        path,
        message: `Invalid option: expected one of ${values.map((v) => JSON.stringify(v)).join("|")}`,
      });
      return INVALID;
    },
  };
}

export function arrayOf<T>(items: InputSchema<T>): InputSchema<T[]> {
  return {
    json: { type: "array", items: items.json },
    parse(value, path, issues) {
      if (!Array.isArray(value)) return invalidType("array", value, path, issues);
      const parsed: T[] = [];
      let ok = true;
      for (let index = 0; index < value.length; index++) {
        const item = items.parse(value[index], [...path, index], issues);
        if (item === INVALID) ok = false;
        else parsed.push(item);
      }
      return ok ? parsed : INVALID;
    },
  };
}

/** The `inputSchema` advertised for a tool in `tools/list`. */
export function toJsonSchema(shape: InputShape): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const requiredKeys: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    // Optional fields lead with their description and required ones trail
    // with it, the key order the zod-generated schemas had.
    properties[key] = field.optional
      ? { description: field.description, ...field.schema.json }
      : { ...field.schema.json, description: field.description };
    if (!field.optional) requiredKeys.push(key);
  }
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties,
    ...(requiredKeys.length > 0 ? { required: requiredKeys } : {}),
  };
}

export type ParseInputResult<S extends InputShape> =
  | { success: true; data: InferInput<S> }
  | { success: false; issues: InputIssue[]; message: string };

/**
 * Validates tool arguments against a shape. Keys the shape does not declare
 * are dropped from the result.
 */
export function parseInput<S extends InputShape>(shape: S, input: unknown): ParseInputResult<S> {
  const issues: InputIssue[] = [];
  const data: Record<string, unknown> = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    invalidType("object", input, [], issues);
  } else {
    for (const [key, field] of Object.entries(shape)) {
      const value = Object.hasOwn(input, key) ? (input as Record<string, unknown>)[key] : undefined;
      if (value === undefined && field.optional) continue;
      const parsed = field.schema.parse(value, [key], issues);
      if (parsed !== INVALID) data[key] = parsed;
    }
  }
  if (issues.length > 0) {
    return { success: false, issues, message: JSON.stringify(issues, null, 2) };
  }
  return { success: true, data: data as InferInput<S> };
}

function invalidType(
  expected: string,
  value: unknown,
  path: PathSegment[],
  issues: InputIssue[],
  received?: string,
): typeof INVALID {
  issues.push({
    expected,
    code: "invalid_type",
    ...(received === undefined ? {} : { received }),
    path,
    message: `Invalid input: expected ${expected}, received ${describeValue(value)}`,
  });
  return INVALID;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  return typeof value;
}

function unsafeInteger(
  code: "too_big" | "too_small",
  boundKey: "maximum" | "minimum",
  bound: number,
  path: PathSegment[],
): InputIssue {
  return {
    code,
    [boundKey]: bound,
    note: "Integers must be within the safe integer range.",
    origin: "int",
    inclusive: true,
    path,
    message: `${code === "too_big" ? "Too big" : "Too small"}: expected int to be ${code === "too_big" ? "<=" : ">="}${bound}`,
  };
}

function outOfRange(
  code: "too_big" | "too_small",
  boundKey: "maximum" | "minimum",
  bound: number,
  inclusive: boolean,
  path: PathSegment[],
): InputIssue {
  const operator = code === "too_big" ? "<" : ">";
  return {
    origin: "number",
    code,
    [boundKey]: bound,
    inclusive,
    path,
    message: `${code === "too_big" ? "Too big" : "Too small"}: expected number to be ${operator}${inclusive ? "=" : ""}${bound}`,
  };
}
