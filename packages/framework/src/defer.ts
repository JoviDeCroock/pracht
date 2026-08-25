/**
 * Deferred loader values — `defer()` marks a slow field, `use()` reads it.
 *
 * A loader returns its object as usual and wraps the values that should not
 * hold up the response:
 *
 * ```ts
 * export async function loader({ params }: LoaderArgs) {
 *   const reviews = defer(getReviews(params.id));
 *   return {
 *     product: await getProduct(params.id), // overlaps with reviews
 *     reviews,
 *   };
 * }
 * ```
 *
 * The marker sits on the slow value rather than wrapping the whole return, so
 * the object keeps its shape, the type records exactly which fields defer, and
 * a route that calls `defer()` nowhere serializes byte-identically to before.
 *
 * Today every path resolves deferred values before the response is written —
 * `resolveDeferredData()` is called once, at the single loader call site in
 * `runtime.ts`. The authoring API is the finished one: when the streaming
 * renderer lands, `render: "ssr"` starts flushing the shell before these
 * settle and no route source has to change. `use()` already accepts a settled
 * value, a `Deferred`, or a bare promise for exactly that reason.
 *
 * Note that `ssg` and `isg` write files and therefore always resolve
 * everything — a static file cannot stream, and shipping fallback markup as
 * permanent output would be a correctness bug.
 */

import { isPrachtHttpError } from "./runtime-errors.ts";

const DEFERRED = Symbol.for("pracht.deferred");

interface DeferredBox<T> {
  readonly [DEFERRED]: true;
  /** Lazily started so `defer(() => …)` does not fetch until something reads it. */
  promise(): Promise<T>;
  /** Reject markers that escaped the resolver instead of silently emitting `{}`. */
  toJSON(): never;
}

/**
 * A loader value that has been marked with {@link defer}.
 *
 * The type parameter is preserved so passing a `Deferred<T>` where `T` is
 * expected is a compile error — reading it goes through {@link use}.
 */
export interface Deferred<T> {
  readonly [DEFERRED]: true;
  /** @internal Phantom field; carries `T` so the type is not structurally `any`. */
  readonly __deferred?: () => T;
}

/**
 * Mark a loader value as deferred.
 *
 * Accepts a promise, or a function returning one when the work should not
 * start until the value is read. Rejections surface where the value is read,
 * not from the loader.
 *
 * A deferred value may not redirect, throw a PrachtHttpError, or set headers:
 * by the time it settles the response status and headers are already decided.
 * Auth checks belong in middleware or in the awaited part of the loader.
 */
export function defer<T>(source: Promise<T> | (() => Promise<T>)): Deferred<T> {
  if (typeof source !== "function" && !isThenable(source)) {
    throw new TypeError(
      "defer() expects a promise or a function returning one. " +
        "Pass the un-awaited call — defer(getReviews(id)), not defer(await getReviews(id)).",
    );
  }

  let started: Promise<T> | undefined;
  if (typeof source !== "function") {
    started = Promise.resolve(source);
    // A loader can keep awaiting blocking data after it creates this marker.
    // Observe eager rejections immediately so Node does not treat them as
    // unhandled before the runtime reaches resolveDeferredData(). The original
    // promise remains rejected and still surfaces when the value is read.
    void started.catch(() => {});
  }
  const box: DeferredBox<T> = {
    [DEFERRED]: true,
    promise() {
      if (!started) {
        started = (async () => (source as () => Promise<T>)())();
      }
      return started;
    },
    toJSON() {
      throw deferredSerializationError();
    },
  };
  return box as unknown as Deferred<T>;
}

/** Whether `value` was produced by {@link defer}. */
export function isDeferred(value: unknown): value is Deferred<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as DeferredBox<unknown>)[DEFERRED] === true
  );
}

/**
 * Read a deferred value from inside a component.
 *
 * Suspends — throws the pending promise — until the value settles, so the
 * nearest `<Suspense>` boundary shows its fallback. A value that has already
 * settled (every path today, and `ssg`/`isg` always) is returned directly,
 * which is what lets one component work whether or not the route streams.
 *
 * A boundary is required and never inferred. On Preact 10 a boundary that
 * suspends must also resolve to exactly one DOM element — not `null`, not a
 * multi-child fragment — or hydration mismatches.
 */
type UsedValue<T> =
  T extends Deferred<infer TValue> ? TValue : T extends Promise<infer TValue> ? TValue : T;

export function use<T>(value: T): UsedValue<T> {
  if (isDeferred(value)) {
    return readSettled((value as unknown as DeferredBox<UsedValue<T>>).promise()) as UsedValue<T>;
  }
  if (isThenable(value)) return readSettled(value as Promise<UsedValue<T>>) as UsedValue<T>;
  return value as UsedValue<T>;
}

/**
 * Resolve every {@link Deferred} in a loader result.
 *
 * Returns the input unchanged when it holds no deferred value, so the common
 * case allocates nothing. Deferred values found at any depth are awaited
 * concurrently — one slow field does not serialize behind another.
 */
export async function resolveDeferredData<T>(data: T): Promise<T> {
  if (!containsDeferred(data)) return data;
  return (await resolveValue(data, new Map())) as T;
}

type SettledState<T> =
  | { status: "pending" }
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

const settled = new WeakMap<Promise<unknown>, SettledState<unknown>>();

/**
 * Throw-until-settled, the shape `preact-suspense` and
 * `preact-render-to-string` both already understand.
 */
function readSettled<T>(promise: Promise<T>): T {
  let state = settled.get(promise) as SettledState<T> | undefined;
  if (!state) {
    state = { status: "pending" };
    settled.set(promise, state);
    promise.then(
      (value) => settled.set(promise, { status: "fulfilled", value }),
      (reason) => settled.set(promise, { status: "rejected", reason }),
    );
  }
  if (state.status === "fulfilled") return state.value;
  if (state.status === "rejected") throw state.reason;
  throw promise;
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Whether `value` holds a `Deferred` anywhere.
 *
 * Walks the same shapes `resolveValue` rebuilds, so the two cannot disagree
 * about what counts as traversable. Cycles are bounded by `seen`.
 */
function containsDeferred(value: unknown, seen = new Set<object>()): boolean {
  if (isDeferred(value)) return true;
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      // Array iteration reads accessor-backed indices, which would add an
      // observable access even when the route does not defer anything. Inspect
      // only the data descriptors JSON serialization can consume directly.
      if (isArrayIndexKey(key) && "value" in descriptor) {
        if (containsDeferred(descriptor.value, seen)) return true;
      }
    }
    return false;
  }
  if (!isPlainObject(value)) return false;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    // Do not invoke accessors just to look for a marker. Loader objects may
    // expose JSON-serializable getters, and reading them here would add an
    // observable access even when the route does not defer anything.
    if (descriptor.enumerable && "value" in descriptor) {
      if (containsDeferred(descriptor.value, seen)) return true;
    }
  }
  return false;
}

async function resolveValue(value: unknown, seen: Map<object, unknown>): Promise<unknown> {
  if (isDeferred(value)) {
    let resolved: unknown;
    try {
      resolved = await (value as unknown as DeferredBox<unknown>).promise();
    } catch (error: unknown) {
      if (error instanceof Response || isPrachtHttpError(error)) {
        throw deferredResponseError();
      }
      throw error;
    }
    if (resolved instanceof Response) throw deferredResponseError();
    return await resolveValue(resolved, seen);
  }
  if (typeof value !== "object" || value === null) return value;

  const cached = seen.get(value);
  if (cached !== undefined) return cached;

  if (Array.isArray(value)) {
    const next: unknown[] = [];
    Object.setPrototypeOf(next, Object.getPrototypeOf(value));
    seen.set(value, next);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries = Reflect.ownKeys(descriptors)
      .filter((key) => key !== "length")
      .map((key) => [key, descriptors[key as keyof typeof descriptors]] as const);
    const resolved = await Promise.all(
      entries.map(([key, descriptor]) =>
        isArrayIndexKey(key) && "value" in descriptor
          ? resolveValue(descriptor.value, seen)
          : undefined,
      ),
    );
    for (let i = 0; i < entries.length; i += 1) {
      const [key, descriptor] = entries[i];
      Object.defineProperty(
        next,
        key,
        isArrayIndexKey(key) && "value" in descriptor
          ? { ...descriptor, value: resolved[i] }
          : descriptor,
      );
    }
    Object.defineProperty(next, "length", descriptors.length);
    return next;
  }

  // Anything that is not a plain object (Date, class instance, …) is handed
  // back by reference. Loader data has to be JSON-serializable, so these are
  // already the caller's problem and rebuilding them would lose their
  // prototype.
  if (!isPlainObject(value)) return value;

  const next = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  seen.set(value, next);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Reflect.ownKeys(descriptors).map(
    (key) => [key, descriptors[key as keyof typeof descriptors]] as const,
  );
  const resolved = await Promise.all(
    entries.map(([, descriptor]) =>
      descriptor.enumerable && "value" in descriptor
        ? resolveValue(descriptor.value, seen)
        : undefined,
    ),
  );
  for (let i = 0; i < entries.length; i += 1) {
    const [key, descriptor] = entries[i];
    Object.defineProperty(
      next,
      key,
      descriptor.enumerable && "value" in descriptor
        ? { ...descriptor, value: resolved[i] }
        : descriptor,
    );
  }
  return next;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isArrayIndexKey(key: PropertyKey): key is string {
  if (typeof key !== "string" || key === "") return false;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key;
}

function deferredResponseError(): TypeError {
  return new TypeError(
    "A deferred loader value cannot return or throw a Response or throw a PrachtHttpError. " +
      "Redirects, status, and headers must be decided before deferred work starts.",
  );
}

function deferredSerializationError(): TypeError {
  return new TypeError(
    "A deferred loader value reached serialization without being resolved. " +
      "Return defer() from an enumerable data property, not from a getter.",
  );
}

/* -------------------------------------------------------------------------- *
 * Wire format
 *
 * A streamed document cannot serialize a value that has not settled, so each
 * unresolved `Deferred` is written into the hydration state as a sentinel and
 * its value follows later on its own channel. Both the HTML stream and (later)
 * the route-state response use the same sentinel and the same client registry,
 * so the two transports cannot drift.
 * -------------------------------------------------------------------------- */

/** Marks a deferred hole in serialized loader data. */
export const DEFER_SENTINEL_KEY = "$pracht:defer";

interface DeferSentinel {
  [DEFER_SENTINEL_KEY]: string;
}

export interface SerializedDeferred {
  /** Loader data with each unresolved `Deferred` replaced by a sentinel. */
  data: unknown;
  /** The deferred values, keyed by the id written into the sentinel. */
  pending: { id: string; promise: Promise<unknown> }[];
}

function isDeferSentinel(value: unknown): value is DeferSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DeferSentinel)[DEFER_SENTINEL_KEY] === "string"
  );
}

/**
 * Replace every `Deferred` with a sentinel, collecting the promises.
 *
 * Ids are the value's path in the loader result (`reviews`, `a.b.0.c`), which
 * keeps them stable and debuggable — a stuck boundary names the field it came
 * from rather than an opaque counter.
 */
export function serializeDeferred(data: unknown): SerializedDeferred {
  const pending: { id: string; promise: Promise<unknown> }[] = [];

  const walk = (value: unknown, path: string, seen: Set<object>): unknown => {
    if (isDeferred(value)) {
      pending.push({ id: path, promise: (value as unknown as DeferredBox<unknown>).promise() });
      return { [DEFER_SENTINEL_KEY]: path };
    }
    if (typeof value !== "object" || value === null) return value;
    if (seen.has(value)) return value;
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((entry, i) => walk(entry, path ? `${path}.${i}` : String(i), seen));
    }
    if (!isPlainObject(value)) return value;

    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = walk(entry, path ? `${path}.${key}` : key, seen);
    }
    return next;
  };

  return { data: walk(data, "", new Set()), pending };
}

/**
 * The inline shim written before any deferred chunk.
 *
 * The client runtime is a module script and therefore deferred until the
 * document has parsed, so every `r`/`e` call in the stream lands before the
 * real registry exists. The shim queues them for it to drain.
 */
export const DEFER_RUNTIME_SHIM =
  "window.__PRACHT_DEFER__=window.__PRACHT_DEFER__||{q:[]," +
  "r:function(i,v){this.q.push([i,v,0])},e:function(i,v){this.q.push([i,v,1])}};";

interface DeferRegistry {
  q?: [string, unknown, 0 | 1][];
  r(id: string, value: unknown): void;
  e(id: string, error: unknown): void;
}

const clientDeferred = new Map<
  string,
  { promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }
>();

function getClientEntry(id: string) {
  let entry = clientDeferred.get(id);
  if (!entry) {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Nothing may observe this rejection before `use()` reads it, and an
    // unobserved rejection is an unhandled-rejection warning in the browser.
    promise.catch(() => {});
    entry = { promise, resolve, reject };
    clientDeferred.set(id, entry);
  }
  return entry;
}

/**
 * Install the real registry and drain whatever the shim queued.
 *
 * Idempotent: repeated calls (client navigation, HMR) reuse the same map so a
 * chunk that arrived before hydration is never lost.
 */
export function installDeferRegistry(): void {
  if (typeof window === "undefined") return;
  const existing = (window as unknown as { __PRACHT_DEFER__?: DeferRegistry }).__PRACHT_DEFER__;
  const queued = existing?.q ?? [];

  const registry: DeferRegistry = {
    r(id, value) {
      getClientEntry(id).resolve(value);
    },
    e(id, error) {
      const err = new Error(
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error),
      );
      getClientEntry(id).reject(err);
    },
  };
  (window as unknown as { __PRACHT_DEFER__: DeferRegistry }).__PRACHT_DEFER__ = registry;

  for (const [id, value, kind] of queued) {
    if (kind === 1) registry.e(id, value);
    else registry.r(id, value);
  }
}

/**
 * Replace sentinels in hydrated loader data with `Deferred` values.
 *
 * Returns the input by reference when it holds no sentinel, so a route that
 * defers nothing pays nothing.
 */
export function rehydrateDeferredData<T>(data: T): T {
  if (!containsSentinel(data)) return data;
  installDeferRegistry();

  const walk = (value: unknown, seen: Set<object>): unknown => {
    if (isDeferSentinel(value)) {
      const id = value[DEFER_SENTINEL_KEY];
      const entry = getClientEntry(id);
      return defer(() => entry.promise);
    }
    if (typeof value !== "object" || value === null) return value;
    if (seen.has(value)) return value;
    seen.add(value);
    if (Array.isArray(value)) return value.map((entry) => walk(entry, seen));
    if (!isPlainObject(value)) return value;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) next[key] = walk(entry, seen);
    return next;
  };

  return walk(data, new Set()) as T;
}

function containsSentinel(value: unknown, seen = new Set<object>()): boolean {
  if (isDeferSentinel(value)) return true;
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) if (containsSentinel(entry, seen)) return true;
    return false;
  }
  if (!isPlainObject(value)) return false;
  for (const entry of Object.values(value)) if (containsSentinel(entry, seen)) return true;
  return false;
}
