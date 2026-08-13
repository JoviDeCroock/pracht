import { isJsonValue, isPlainObject } from "./schema-json-value.ts";

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
  } else if (Array.isArray(schema.enum)) {
    for (const [index, value] of schema.enum.entries()) {
      if (!isJsonValue(value)) {
        invalid.push(`${path}/enum/${index}:<expected JSON value>`);
      }
    }
  }
  for (const keyword of ["const", "default"] as const) {
    if (keyword in schema && !isJsonValue(schema[keyword])) {
      invalid.push(`${path}/${keyword}:<expected JSON value>`);
    }
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
