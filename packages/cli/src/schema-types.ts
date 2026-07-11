/**
 * JSON Schema (supported subset) → TypeScript type text, for `pracht typegen`.
 *
 * Only the capability schema subset enforced by `defineCapability()` reaches
 * this printer (see packages/capabilities/src/schema.ts), so unknown keywords
 * simply fall back to `unknown` instead of guessing.
 *
 * Position matters for optionality:
 * - `"input"` — a property is optional for the caller when it is not
 *   `required` or when it declares a `default` (defaults are applied before
 *   validation, so the caller may always omit it);
 * - `"output"` — a property is optional exactly when it is not `required`.
 */

export type SchemaTypePosition = "input" | "output";

export function schemaToTypeText(schema: unknown, position: SchemaTypePosition): string {
  if (!isPlainObject(schema)) return "unknown";

  if ("const" in schema) {
    return jsonToLiteralType(schema.const);
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map(jsonToLiteralType).join(" | ");
  }

  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${schemaToTypeText(schema.items, position)}>`;
    case "object":
      return objectTypeText(schema, position);
    default:
      return "unknown";
  }
}

function objectTypeText(schema: Record<string, unknown>, position: SchemaTypePosition): string {
  const properties = isPlainObject(schema.properties) ? schema.properties : null;
  const additional = schema.additionalProperties;

  if (!properties || Object.keys(properties).length === 0) {
    if (additional === false) return "Record<string, never>";
    if (isPlainObject(additional)) {
      return `Record<string, ${schemaToTypeText(additional, position)}>`;
    }
    return "Record<string, unknown>";
  }

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );

  const members = Object.entries(properties).map(([name, propertySchema]) => {
    const hasDefault = isPlainObject(propertySchema) && "default" in propertySchema;
    const optional = position === "input" ? !required.has(name) || hasDefault : !required.has(name);
    return `${JSON.stringify(name)}${optional ? "?" : ""}: ${schemaToTypeText(propertySchema, position)};`;
  });

  if (additional !== false) {
    // Open objects accept extra members; type them so access stays checked.
    members.push("[key: string]: unknown;");
  }

  return `{ ${members.join(" ")} }`;
}

/** Render a JSON value as a TypeScript literal type (for `const`/`enum`). */
function jsonToLiteralType(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(jsonToLiteralType).join(", ")}]`;
  }
  if (isPlainObject(value)) {
    const members = Object.entries(value).map(
      ([name, member]) => `${JSON.stringify(name)}: ${jsonToLiteralType(member)};`,
    );
    return `{ ${members.join(" ")} }`;
  }
  return "unknown";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
