import { findNonJsonIssue, isPlainObject, jsonEquals } from "./schema-json-value.ts";
import type { CapabilityIssue } from "./schema-types.ts";

/**
 * Validate `value` against the schema subset. Returns an empty array when the
 * value conforms. Every issue carries a path scoped to the offending value so
 * callers (and agents) can pinpoint what to fix.
 */
export function validateAgainstSchema(
  schema: unknown,
  value: unknown,
  path = "",
): CapabilityIssue[] {
  const nonJsonIssue = findNonJsonIssue(value, path);
  if (nonJsonIssue) return [nonJsonIssue];
  return validateJsonAgainstSchema(schema, value, path);
}

function validateJsonAgainstSchema(
  schema: unknown,
  value: unknown,
  path: string,
): CapabilityIssue[] {
  if (!isPlainObject(schema)) return [];

  const issues: CapabilityIssue[] = [];

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
    // JSON Schema measures string length in Unicode code points, while
    // JavaScript's String#length counts UTF-16 code units. Count code points so
    // astral characters such as emoji contribute one character, not two.
    const length = Array.from(value).length;
    if (typeof schema.minLength === "number" && length < schema.minLength) {
      issues.push({ path, message: `must be at least ${schema.minLength} character(s) long` });
    }
    if (typeof schema.maxLength === "number" && length > schema.maxLength) {
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
        issues.push(...validateJsonAgainstSchema(propertySchema, propertyValue, `${path}/${name}`));
        continue;
      }

      if (schema.additionalProperties === false) {
        issues.push({ path: `${path}/${name}`, message: "is not an allowed property" });
      } else if (isPlainObject(schema.additionalProperties)) {
        issues.push(
          ...validateJsonAgainstSchema(
            schema.additionalProperties,
            propertyValue,
            `${path}/${name}`,
          ),
        );
      }
    }
  }

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    for (let index = 0; index < value.length; index += 1) {
      issues.push(...validateJsonAgainstSchema(schema.items, value[index], `${path}/${index}`));
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
