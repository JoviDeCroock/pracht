import { cloneJson, isPlainObject } from "./schema-json-value.ts";

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
