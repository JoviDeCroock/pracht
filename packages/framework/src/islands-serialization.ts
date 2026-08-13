import { ISLAND_STRATEGIES } from "./islands-shared.ts";
import type { IslandStrategy } from "./types.ts";

interface IslandIdentity {
  file: string;
  name: string;
}

export function validateIslandStrategy(
  client: unknown,
  descriptor: IslandIdentity,
): IslandStrategy {
  if (client == null) return "load";
  if (typeof client === "string" && (ISLAND_STRATEGIES as readonly string[]).includes(client)) {
    return client as IslandStrategy;
  }
  throw new Error(
    `Island "${descriptor.name}" (${descriptor.file}) received an invalid client strategy ` +
      `${JSON.stringify(client)}. Expected one of: ${ISLAND_STRATEGIES.map((strategy) => `"${strategy}"`).join(", ")}.`,
  );
}

/** Validate the JSON wire contract used to revive island props in the browser. */
export function validateSerializableIslandProps(
  props: Record<string, unknown>,
  descriptor: IslandIdentity,
): void {
  for (const [key, value] of Object.entries(props)) {
    validateIslandPropValue(value, `props.${key}`, descriptor, new Set());
  }
}

function validateIslandPropValue(
  value: unknown,
  path: string,
  descriptor: IslandIdentity,
  seen: Set<unknown>,
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw islandPropError(path, `is ${String(value)}, which JSON cannot represent`, descriptor);
    }
    return;
  }

  if (value === undefined) {
    // JSON.stringify drops undefined object properties; the island simply
    // will not receive the prop, matching normal component semantics.
    return;
  }

  if (typeof value === "function") {
    throw islandPropError(path, "is a function", descriptor);
  }
  if (typeof value === "symbol") {
    throw islandPropError(path, "is a symbol", descriptor);
  }
  if (typeof value === "bigint") {
    throw islandPropError(path, "is a bigint", descriptor);
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      throw islandPropError(path, "contains a circular reference", descriptor);
    }
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item === undefined) {
          throw islandPropError(
            `${path}[${index}]`,
            "is undefined inside an array (JSON serializes it as null)",
            descriptor,
          );
        }
        validateIslandPropValue(item, `${path}[${index}]`, descriptor, seen);
      });
      seen.delete(value);
      return;
    }

    // Preact vnodes set `constructor` to undefined; JSX passed as a prop
    // cannot be serialized and re-created on the client.
    if ((value as { constructor?: unknown }).constructor === undefined) {
      throw islandPropError(path, "is a JSX element", descriptor);
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const typeName =
        (value as { constructor?: { name?: string } }).constructor?.name ?? "class instance";
      throw islandPropError(path, `is a ${typeName} instance`, descriptor);
    }

    for (const [key, entry] of Object.entries(value)) {
      validateIslandPropValue(entry, `${path}.${key}`, descriptor, seen);
    }
    seen.delete(value);
    return;
  }

  throw islandPropError(path, `has unsupported type "${typeof value}"`, descriptor);
}

function islandPropError(path: string, reason: string, descriptor: IslandIdentity): Error {
  return new Error(
    `Island "${descriptor.name}" (${descriptor.file}) received a prop that is not ` +
      `JSON-serializable: ${path} ${reason}. Island props are serialized into the HTML ` +
      "and revived in the browser, so they must be JSON-serializable values " +
      "(string, finite number, boolean, null, arrays, and plain objects).",
  );
}
