/**
 * Strip {@link serverOnly} values out of the inline hydration state.
 *
 * Kept out of `server-only.ts` on purpose: `<StaticHtml>` needs the marker
 * predicates, and reaching them must not drag this walker into every client
 * bundle that renders one.
 */

import { isArrayIndexKey, isPlainObject } from "./loader-values.ts";
import { isServerOnly, serverOnlyPlaceholder } from "./server-only.ts";

/**
 * Replace every {@link serverOnly} marker in a loader result with the
 * placeholder the browser sees.
 *
 * Returns the input unchanged when it holds no marker, so a route that uses
 * none serializes byte-identically to before. Rebuilds rather than mutates:
 * this runs after the render, and the same `data` object is still the one the
 * rendered tree closed over.
 *
 * Walks the shapes `resolveDeferredData()` walks — arrays and plain objects,
 * data properties only. A marker returned from a getter is not found (reading
 * it would be an observable access on every route), and its `toJSON()` then
 * writes the value into the document as if it had never been marked. Return
 * `serverOnly()` from an enumerable data property.
 */
export function stripServerOnlyValues<T>(data: T): T {
  if (!containsServerOnly(data)) return data;
  return stripValue(data, new Map()) as T;
}

function containsServerOnly(value: unknown, seen = new Set<object>()): boolean {
  if (isServerOnly(value)) return true;
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (isArrayIndexKey(key) && "value" in descriptor) {
        if (containsServerOnly(descriptor.value, seen)) return true;
      }
    }
    return false;
  }
  if (!isPlainObject(value)) return false;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.enumerable && "value" in descriptor) {
      if (containsServerOnly(descriptor.value, seen)) return true;
    }
  }
  return false;
}

function stripValue(value: unknown, seen: Map<object, unknown>): unknown {
  if (isServerOnly(value)) return serverOnlyPlaceholder();
  if (typeof value !== "object" || value === null) return value;

  const cached = seen.get(value);
  if (cached !== undefined) return cached;

  if (Array.isArray(value)) {
    const next: unknown[] = [];
    Object.setPrototypeOf(next, Object.getPrototypeOf(value));
    seen.set(value, next);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === "length") continue;
      const descriptor = descriptors[key as keyof typeof descriptors];
      Object.defineProperty(
        next,
        key,
        isArrayIndexKey(key) && "value" in descriptor
          ? { ...descriptor, value: stripValue(descriptor.value, seen) }
          : descriptor,
      );
    }
    Object.defineProperty(next, "length", descriptors.length);
    return next;
  }

  // Anything that is not a plain object (Date, class instance, …) is handed
  // back by reference, exactly as the deferred walker does: loader data has to
  // be JSON-serializable, so these are already the caller's problem and
  // rebuilding them would lose their prototype.
  if (!isPlainObject(value)) return value;

  const next = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  seen.set(value, next);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as keyof typeof descriptors];
    Object.defineProperty(
      next,
      key,
      descriptor.enumerable && "value" in descriptor
        ? { ...descriptor, value: stripValue(descriptor.value, seen) }
        : descriptor,
    );
  }
  return next;
}
