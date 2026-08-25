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

const DEFERRED = Symbol.for("pracht.deferred");

interface DeferredBox<T> {
  readonly [DEFERRED]: true;
  /** Lazily started so `defer(() => …)` does not fetch until something reads it. */
  promise(): Promise<T>;
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
 * A deferred value may not redirect or set headers: by the time it settles the
 * response status and headers are already decided. Auth checks belong in
 * middleware or in the awaited part of the loader.
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
    for (const entry of value) if (containsDeferred(entry, seen)) return true;
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
      if (error instanceof Response) throw deferredResponseError();
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
    seen.set(value, next);
    const resolved = await Promise.all(value.map((entry) => resolveValue(entry, seen)));
    next.push(...resolved);
    return next;
  }

  // Anything that is not a plain object (Date, class instance, …) is handed
  // back by reference. Loader data has to be JSON-serializable, so these are
  // already the caller's problem and rebuilding them would lose their
  // prototype.
  if (!isPlainObject(value)) return value;

  const next = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  seen.set(value, next);
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value)).filter(
    ([, descriptor]) => descriptor.enumerable,
  );
  const resolved = await Promise.all(
    entries.map(([, descriptor]) =>
      "value" in descriptor ? resolveValue(descriptor.value, seen) : undefined,
    ),
  );
  for (let i = 0; i < entries.length; i += 1) {
    const [key, descriptor] = entries[i];
    Object.defineProperty(
      next,
      key,
      "value" in descriptor ? { ...descriptor, value: resolved[i] } : descriptor,
    );
  }
  return next;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deferredResponseError(): TypeError {
  return new TypeError(
    "A deferred loader value cannot return or throw a Response. " +
      "Redirects, status, and headers must be decided before deferred work starts.",
  );
}
