/**
 * The wire format for route (loader) data — the one place it is defined.
 *
 * Loader data reaches the browser through the hydration-state script, the
 * route-state (`_data`) response, static-export route-state files, and
 * streamed `defer()` chunks. All of them carry the output of
 * {@link encodeRouteData} inside ordinary JSON and hand the parsed value to
 * {@link decodeRouteData}.
 *
 * The encoding is JSON with tagged arrays. A value JSON already represents
 * exactly — a finite number other than `-0`, a string, a boolean, `null`, a
 * plain object, an array — encodes as itself, so JSON-only data costs no
 * payload bytes. Anything else becomes an array whose first element is a
 * string starting with U+0000:
 *
 * | Value                      | Encoded                                |
 * | -------------------------- | -------------------------------------- |
 * | `undefined`                | `["\0U"]`                              |
 * | `NaN`, `±Infinity`, `-0`   | `["\0#", "NaN"]`                       |
 * | `123n`                     | `["\0B", "123"]`                       |
 * | `Date`                     | `["\0D", epochMs]` (`""` if invalid)   |
 * | `RegExp`                   | `["\0R", source, flags]`               |
 * | `URL`                      | `["\0L", href]`                        |
 * | `Map`                      | `["\0M", key, value, key, value, …]`   |
 * | `Set`                      | `["\0S", value, …]`                    |
 * | first of a shared object   | `["\0=", id, encoded]`                 |
 * | later occurrences          | `["\0@", id]`                          |
 * | a string starting with \0  | `["\0$", string]`                      |
 *
 * `JSON.stringify` always writes U+0000 as the escape `\u0000`, so a payload
 * without that six-character sequence holds no tag and the client skips the
 * decode walk entirely ({@link mayContainEncodedRouteData}). Escaping user
 * strings that start with U+0000 keeps the format unambiguous without
 * reserving any object shape or property name.
 *
 * Decoding never evaluates code: it walks parsed JSON and calls constructors.
 * Embedding the JSON in an inline `<script>` stays the caller's job (see
 * `escapeScriptText()`).
 */

const TAG = "\u0000";
const DEFERRED = Symbol.for("pracht.deferred");

type Slot = { parent: Record<PropertyKey, unknown>; key: PropertyKey; id?: number };
/** A path segment: an object key, an array index, or preformatted text. */
type PathSegment = string | number | [string];

/**
 * Encode loader data into a JSON-safe value.
 *
 * Throws a `TypeError` naming the offending path when the data holds a value
 * the format cannot represent (a function, a symbol, a class instance, an
 * unresolved `defer()` marker, …). `owner` names the route in that message.
 */
export function encodeRouteData(value: unknown, owner?: string): unknown {
  const root: unknown[] = [];
  const slots = new Map<object, Slot>();
  const path: PathSegment[] = [];
  let nextId = 0;

  const fail = (reason: string): never => {
    throw new TypeError(
      `${owner ? `Loader data for ${owner}` : "Loader data"} cannot be sent to the browser: ` +
        `${formatPath(path)} ${reason}. Route data may contain JSON values plus undefined, ` +
        "NaN, Infinity, -0, BigInt, Date, RegExp, URL, Map, and Set (shared and circular " +
        "references are kept). Convert the value to one of those before returning it.",
    );
  };

  const child = (
    v: unknown,
    parent: Record<PropertyKey, unknown>,
    key: PropertyKey,
    at: PathSegment,
  ) => {
    path.push(at);
    encode(v, parent, key);
    path.pop();
  };

  const encode = (v: unknown, parent: Record<PropertyKey, unknown>, key: PropertyKey): void => {
    switch (typeof v) {
      case "string":
        parent[key] = v[0] === TAG ? [`${TAG}$`, v] : v;
        return;
      case "boolean":
        parent[key] = v;
        return;
      case "number":
        parent[key] =
          Number.isFinite(v) && !Object.is(v, -0)
            ? v
            : [`${TAG}#`, Object.is(v, -0) ? "-0" : String(v)];
        return;
      case "bigint":
        parent[key] = [`${TAG}B`, v.toString()];
        return;
      case "undefined":
        parent[key] = [`${TAG}U`];
        return;
      case "object":
        break;
      default:
        return fail(`is a ${typeof v}`);
    }
    if (v === null) {
      parent[key] = null;
      return;
    }

    if ((v as Record<PropertyKey, unknown>)[DEFERRED] === true) {
      return fail(
        "is a deferred value that was not resolved. Return defer() from an enumerable data " +
          "property, not from a getter or inside a Map or Set",
      );
    }
    const slot = slots.get(v);
    if (slot) {
      // Seen before: wrap the first occurrence (already in place, even while
      // it is still being filled for a cycle) and point back at it.
      if (slot.id === undefined) {
        slot.id = nextId++;
        slot.parent[slot.key] = [`${TAG}=`, slot.id, slot.parent[slot.key]];
      }
      parent[key] = [`${TAG}@`, slot.id];
      return;
    }
    slots.set(v, { parent, key });

    if (Array.isArray(v)) {
      const out: unknown[] = [];
      parent[key] = out;
      for (let i = 0; i < v.length; i++) child(v[i], out as never, i, i);
    } else if (v instanceof Date) {
      const time = v.getTime();
      parent[key] = [`${TAG}D`, Number.isNaN(time) ? "" : time];
    } else if (v instanceof RegExp) {
      parent[key] = [`${TAG}R`, v.source, v.flags];
    } else if (typeof URL === "function" && v instanceof URL) {
      parent[key] = [`${TAG}L`, v.href];
    } else if (v instanceof Map) {
      const out: unknown[] = [`${TAG}M`];
      parent[key] = out;
      let index = 0;
      for (const [entryKey, entryValue] of v) {
        child(entryKey, out as never, out.length, [`.keys()[${index}]`]);
        child(entryValue, out as never, out.length, [`.get(${describeKey(entryKey)})`]);
        index++;
      }
    } else if (v instanceof Set) {
      const out: unknown[] = [`${TAG}S`];
      parent[key] = out;
      let index = 0;
      for (const entry of v) child(entry, out as never, out.length, [`.values()[${index++}]`]);
    } else if (typeof (v as { toJSON?: unknown }).toJSON === "function") {
      // An explicit JSON representation wins, as it does for JSON.stringify.
      // The value arrives as that representation, not as the original type.
      encode((v as { toJSON(): unknown }).toJSON(), parent, key);
    } else {
      if (typeof (v as { then?: unknown }).then === "function") {
        return fail("is a promise. Await it, or wrap it in defer() to stream it");
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        const name = (v as { constructor?: { name?: unknown } }).constructor?.name;
        return fail(
          typeof name === "string" && name !== ""
            ? `is a ${name} instance with no toJSON() method`
            : "is an object with a custom prototype and no toJSON() method",
        );
      }
      // A null-prototype copy, so an own `__proto__` key stays a plain key.
      const out = Object.create(null) as Record<string, unknown>;
      parent[key] = out;
      for (const k of Object.keys(v)) child((v as Record<string, unknown>)[k], out, k, k);
    }
  };

  // A loader-less route's `undefined` stays absent from the envelope, as before.
  if (value === undefined) return undefined;
  encode(value, root as never, 0);
  return root[0];
}

/**
 * Whether serialized route data might hold tagged values. `false` proves the
 * parsed value is already the data, so callers can skip {@link decodeRouteData}.
 */
export function mayContainEncodedRouteData(json: string): boolean {
  return json.includes("\\u0000");
}

/**
 * Rebuild route data from the parsed output of {@link encodeRouteData}.
 *
 * Plain objects and arrays are revived in place, so the input must be a
 * freshly parsed value that nothing else holds. Every hydrating page ships
 * this function, which is why it trades readability for bytes.
 */
export function decodeRouteData<T = unknown>(value: unknown): T {
  const refs: unknown[] = [];

  const revive = (v: any, id?: number): any => {
    if (typeof v != "object" || v === null) return v;
    const tag = Array.isArray(v) && typeof v[0] == "string" && v[0][0] == TAG ? v[0][1] : "";
    if (tag == "@") return refs[v[1]];
    if (tag == "=") return revive(v[2], v[1]);
    const out = tag ? CONSTRUCT[tag](v[1], v[2]) : v;
    // Register before filling, so a cycle back to this value resolves. An
    // unshared value registers under the harmless "undefined" key.
    refs[id!] = out;
    if (tag == "M") for (let i = 1; i < v.length; i += 2) out.set(revive(v[i]), revive(v[i + 1]));
    else if (tag == "S") for (let i = 1; i < v.length; i++) out.add(revive(v[i]));
    // Keys come from Object.keys, so an own `__proto__` key is assigned as a
    // data property rather than through the prototype setter.
    else if (!tag) for (const key of Object.keys(v)) v[key] = revive(v[key]);
    return out;
  };

  return revive(value) as T;
}

/** Leaf and empty-container constructors by tag; Map and Set fill afterwards. */
const CONSTRUCT: Record<string, (arg: any, extra: any) => any> = {
  $: (arg) => arg,
  U: () => undefined,
  "#": (arg) => +arg,
  B: (arg) => BigInt(arg),
  D: (arg) => new Date(arg),
  R: (arg, flags) => new RegExp(arg, flags),
  L: (arg) => new URL(arg),
  M: () => new Map(),
  S: () => new Set(),
};

function formatPath(path: readonly PathSegment[]): string {
  let text = "data";
  for (const segment of path) {
    if (typeof segment === "number") text += `[${segment}]`;
    else if (Array.isArray(segment)) text += segment[0];
    else
      text += /^[A-Za-z_$][\w$]*$/.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`;
  }
  return text;
}

function describeKey(key: unknown): string {
  if (typeof key === "string") return JSON.stringify(key);
  if (typeof key === "number" || typeof key === "boolean" || key == null) return String(key);
  if (typeof key === "bigint") return `${key}n`;
  return "…";
}
