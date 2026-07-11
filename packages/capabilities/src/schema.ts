/**
 * Dependency-free JSON Schema subset validator.
 *
 * Capabilities store plain JSON Schema so the graph stays serializable and
 * the same schema can be projected to agent surfaces (WebMCP, MCP) without a
 * runtime schema library in application bundles. Only a deliberate subset is
 * supported; schemas using anything else are rejected at definition time so
 * a keyword the validator would silently ignore can never widen what an
 * exposed capability accepts.
 *
 * Supported keywords:
 *   type (object/array/string/number/integer/boolean/null), properties,
 *   required, additionalProperties, items, enum, const, minimum, maximum,
 *   minLength, maxLength, default (applied to input), plus the pure
 *   annotations title and description.
 */

export type JsonSchema = Record<string, unknown>;

export interface SchemaIssue {
  /** JSON-pointer-ish path into the validated value, e.g. "/limit". Empty for the root. */
  path: string;
  message: string;
}

const SUPPORTED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "default",
  // Pure annotations — never affect validation but are useful for agents.
  "title",
  "description",
]);

const SUPPORTED_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

/**
 * Walk a schema and collect every keyword outside the supported subset,
 * prefixed with its schema path (e.g. `/properties/query/pattern`). Used by
 * `defineCapability()` to fail fast and by `pracht verify` messaging.
 */
export function collectUnsupportedSchemaKeywords(schema: unknown, path = ""): string[] {
  if (!isPlainObject(schema)) return [];

  const unsupported: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      unsupported.push(`${path}/${key}`);
    }
  }

  if (typeof schema.type === "string" && !SUPPORTED_TYPES.has(schema.type)) {
    unsupported.push(`${path}/type:${String(schema.type)}`);
  }
  if (Array.isArray(schema.type)) {
    unsupported.push(`${path}/type:<array of types>`);
  }

  if (isPlainObject(schema.properties)) {
    for (const [name, propertySchema] of Object.entries(schema.properties)) {
      unsupported.push(
        ...collectUnsupportedSchemaKeywords(propertySchema, `${path}/properties/${name}`),
      );
    }
  }
  if (isPlainObject(schema.items)) {
    unsupported.push(...collectUnsupportedSchemaKeywords(schema.items, `${path}/items`));
  }
  if (Array.isArray(schema.items)) {
    unsupported.push(`${path}/items:<tuple form>`);
  }
  if (isPlainObject(schema.additionalProperties)) {
    unsupported.push(
      ...collectUnsupportedSchemaKeywords(
        schema.additionalProperties,
        `${path}/additionalProperties`,
      ),
    );
  }

  return unsupported;
}

/** Collect malformed values for keywords in the supported schema subset. */
export function collectInvalidSchemaKeywordValues(schema: unknown, path = ""): string[] {
  if (!isPlainObject(schema)) return [`${path || "/"}:<expected schema object>`];

  const invalid: string[] = [];
  if ("type" in schema && (typeof schema.type !== "string" || !SUPPORTED_TYPES.has(schema.type))) {
    invalid.push(`${path}/type:<expected supported type string>`);
  }
  if ("properties" in schema && !isPlainObject(schema.properties)) {
    invalid.push(`${path}/properties:<expected object>`);
  }
  if (
    "required" in schema &&
    (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string"))
  ) {
    invalid.push(`${path}/required:<expected string array>`);
  }
  if (
    "additionalProperties" in schema &&
    typeof schema.additionalProperties !== "boolean" &&
    !isPlainObject(schema.additionalProperties)
  ) {
    invalid.push(`${path}/additionalProperties:<expected boolean or schema object>`);
  }
  if ("items" in schema && !isPlainObject(schema.items)) {
    invalid.push(`${path}/items:<expected schema object>`);
  }
  if ("enum" in schema && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    invalid.push(`${path}/enum:<expected non-empty array>`);
  }
  for (const keyword of ["minimum", "maximum"] as const) {
    if (
      keyword in schema &&
      (typeof schema[keyword] !== "number" || !Number.isFinite(schema[keyword]))
    ) {
      invalid.push(`${path}/${keyword}:<expected finite number>`);
    }
  }
  for (const keyword of ["minLength", "maxLength"] as const) {
    if (
      keyword in schema &&
      (typeof schema[keyword] !== "number" ||
        !Number.isInteger(schema[keyword]) ||
        schema[keyword] < 0)
    ) {
      invalid.push(`${path}/${keyword}:<expected non-negative integer>`);
    }
  }
  for (const keyword of ["title", "description"] as const) {
    if (keyword in schema && typeof schema[keyword] !== "string") {
      invalid.push(`${path}/${keyword}:<expected string>`);
    }
  }

  if (isPlainObject(schema.properties)) {
    for (const [name, propertySchema] of Object.entries(schema.properties)) {
      invalid.push(
        ...collectInvalidSchemaKeywordValues(propertySchema, `${path}/properties/${name}`),
      );
    }
  }
  if (isPlainObject(schema.items)) {
    invalid.push(...collectInvalidSchemaKeywordValues(schema.items, `${path}/items`));
  }
  if (isPlainObject(schema.additionalProperties)) {
    invalid.push(
      ...collectInvalidSchemaKeywordValues(
        schema.additionalProperties,
        `${path}/additionalProperties`,
      ),
    );
  }

  return invalid;
}

/**
 * Return a copy of `value` with schema `default`s filled in for missing
 * object properties, recursively. The input value is never mutated.
 */
export function applySchemaDefaults(schema: unknown, value: unknown): unknown {
  if (!isPlainObject(schema)) return value;

  if (isPlainObject(value) && isPlainObject(schema.properties)) {
    const result: Record<string, unknown> = { ...value };
    for (const [name, propertySchema] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(result, name)) {
        if (isPlainObject(propertySchema) && "default" in propertySchema) {
          result[name] = cloneJson(propertySchema.default);
        }
        continue;
      }
      result[name] = applySchemaDefaults(propertySchema, result[name]);
    }
    return result;
  }

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    return value.map((item) => applySchemaDefaults(schema.items, item));
  }

  return value;
}

/**
 * Validate `value` against the schema subset. Returns an empty array when the
 * value conforms. Every issue carries a path scoped to the offending value so
 * callers (and agents) can pinpoint what to fix.
 */
export function validateAgainstSchema(schema: unknown, value: unknown, path = ""): SchemaIssue[] {
  if (!isPlainObject(schema)) return [];

  const issues: SchemaIssue[] = [];

  if ("const" in schema && !jsonEquals(value, schema.const)) {
    issues.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
    return issues;
  }

  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => jsonEquals(value, candidate))
  ) {
    issues.push({
      path,
      message: `must be one of ${schema.enum.map((candidate) => JSON.stringify(candidate)).join(", ")}`,
    });
    return issues;
  }

  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type && !matchesType(type, value)) {
    issues.push({ path, message: `must be of type ${type}, got ${describeValue(value)}` });
    return issues;
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      issues.push({ path, message: `must be at least ${schema.minLength} character(s) long` });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      issues.push({ path, message: `must be at most ${schema.maxLength} character(s) long` });
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      issues.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      issues.push({ path, message: `must be <= ${schema.maximum}` });
    }
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};

    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (typeof name === "string" && !Object.hasOwn(value, name)) {
          issues.push({ path: `${path}/${name}`, message: "is required" });
        }
      }
    }

    for (const [name, propertyValue] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) {
        const propertySchema = properties[name];
        issues.push(...validateAgainstSchema(propertySchema, propertyValue, `${path}/${name}`));
        continue;
      }

      if (schema.additionalProperties === false) {
        issues.push({ path: `${path}/${name}`, message: "is not an allowed property" });
      } else if (isPlainObject(schema.additionalProperties)) {
        issues.push(
          ...validateAgainstSchema(schema.additionalProperties, propertyValue, `${path}/${name}`),
        );
      }
    }
  }

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    for (let index = 0; index < value.length; index += 1) {
      issues.push(...validateAgainstSchema(schema.items, value[index], `${path}/${index}`));
    }
  }

  return issues;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function jsonEquals(left: unknown, right: unknown): boolean {
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
      leftKeys.every((key) => key in right && jsonEquals(left[key], right[key]))
    );
  }
  return false;
}

function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
