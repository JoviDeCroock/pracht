/**
 * Coerce HTML form fields into the shapes a capability input schema expects.
 *
 * Progressive-enhancement `<Form capability>` submissions arrive as
 * `application/x-www-form-urlencoded` strings; the framework maps them onto
 * the input schema before validation: numbers are parsed, checkbox values
 * become booleans, and repeated fields become arrays when the schema says
 * array. Values that do not parse pass through unchanged so schema validation
 * produces its usual, precise issue paths instead of a coercion error.
 */
export function coerceFormInput(
  schema: unknown,
  entries: Iterable<[string, unknown]>,
): Record<string, unknown> {
  const properties =
    isPlainObject(schema) && isPlainObject(schema.properties) ? schema.properties : {};

  const grouped = new Map<string, unknown[]>();
  for (const [name, raw] of entries) {
    const bucket = grouped.get(name) ?? [];
    bucket.push(raw);
    grouped.set(name, bucket);
  }

  const result: Record<string, unknown> = {};
  for (const [name, values] of grouped) {
    // Own-property lookup so a field named "__proto__" or "constructor" cannot
    // pick up an inherited member as its schema.
    const declared = Object.hasOwn(properties, name) ? properties[name] : undefined;
    const propertySchema = isPlainObject(declared) ? declared : null;

    let coerced: unknown;
    if (propertySchema?.type === "array") {
      const itemType = isPlainObject(propertySchema.items) ? propertySchema.items.type : undefined;
      coerced = values.map((value) => coerceScalar(itemType, value));
    } else {
      // Repeated fields collapse to the last value, like URLSearchParams.get
      // from the end — a non-array schema cannot accept more than one anyway.
      coerced = coerceScalar(propertySchema?.type, values[values.length - 1]);
    }

    // defineProperty rather than assignment: `result.__proto__ = value` hits
    // the prototype setter, so the field would silently vanish instead of
    // being rejected by the schema's `additionalProperties: false`.
    Object.defineProperty(result, name, {
      configurable: true,
      enumerable: true,
      value: coerced,
      writable: true,
    });
  }
  return result;
}

function coerceScalar(type: unknown, value: unknown): unknown {
  if (typeof value !== "string") return value;
  switch (type) {
    case "number":
    case "integer": {
      if (value.trim() === "") return value;
      const parsed = Number(value);
      return Number.isNaN(parsed) ? value : parsed;
    }
    case "boolean":
      // Checkboxes post "on" when checked and nothing when unchecked.
      if (value === "true" || value === "on") return true;
      if (value === "false") return false;
      return value;
    case "null":
      return value === "" || value === "null" ? null : value;
    default:
      return value;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
