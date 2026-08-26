/**
 * Server-only loader values — `serverOnly()` marks a field the browser never
 * has to receive twice.
 *
 * Loader data is written into the SSR document a second time, as JSON, so the
 * client can hydrate with the values the server rendered from. For a field
 * whose only job was to *become* the markup — compiled Markdown, a rendered
 * email preview, a syntax-highlighted diff — that second copy is the same
 * bytes the reader already downloaded as HTML:
 *
 * ```ts
 * export function loader() {
 *   return { html: serverOnly(compiledHtml), title };
 * }
 *
 * export function Component({ data }: { data: RouteData }) {
 *   return <StaticHtml html={data.html} class="prose" />;
 * }
 * ```
 *
 * A marked value is omitted from the inline hydration state and replaced with
 * a placeholder, so the document carries the content exactly once. It is still
 * present in the route-state responses a client-side navigation fetches: that
 * page's markup is not in the DOM yet, and pracht already makes that request
 * for the route's `head()` — no extra round trip is introduced.
 *
 * Reading one therefore only works where the markup does not have to be
 * re-rendered during hydration. {@link StaticHtml} is that boundary: the
 * subtree it owns is server-rendered and adopted as-is, never hydrated. Any
 * other consumer must go through {@link readServerOnly}, which is server-side
 * code by construction — on the client it throws rather than silently
 * rendering a hole.
 *
 * The marker sits on the value rather than on the loader, so the returned
 * object keeps its shape, the type records exactly which fields are stripped,
 * and a route that calls `serverOnly()` nowhere serializes byte-identically to
 * before.
 */

import { isDeferred } from "./defer.ts";

const SERVER_ONLY: unique symbol = Symbol.for("pracht.server-only");

/**
 * Property that identifies the placeholder left in the inline hydration state
 * where a {@link serverOnly} value was stripped.
 */
export const SERVER_ONLY_PLACEHOLDER_KEY = "__prachtServerOnly";

/** The object a stripped {@link serverOnly} value is replaced with. */
export interface ServerOnlyPlaceholder {
  readonly __prachtServerOnly: true;
}

class ServerOnlyValue<T> {
  readonly value: T;

  constructor(value: T) {
    this.value = value;
  }

  /**
   * Route-state responses carry the real value: a client-side navigation has
   * no server-rendered DOM for the page it is moving to. The inline document
   * state is stripped explicitly instead (see `stripServerOnlyValues`).
   */
  toJSON(): T {
    return this.value;
  }
}

// On the prototype, and keyed by a registry symbol, so the check survives both
// a rebuilt copy of the object and a second copy of this module in the graph.
Object.defineProperty(ServerOnlyValue.prototype, SERVER_ONLY, { value: true });

/**
 * A loader value that has been marked with {@link serverOnly}.
 *
 * The type parameter is preserved so passing a `ServerOnly<T>` where `T` is
 * expected is a compile error — the browser does not receive one, and the
 * type is what says so.
 */
export interface ServerOnly<T> {
  readonly [SERVER_ONLY]: true;
  /** @internal Phantom field; carries `T` so the type is not structurally `any`. */
  readonly __serverOnly?: () => T;
}

/**
 * Mark a loader value as server-only.
 *
 * The value renders on the server and reaches client-side navigations through
 * the route-state response, but is replaced by a placeholder in the SSR
 * document's hydration state.
 */
export function serverOnly<T>(value: T): ServerOnly<T> {
  if (isServerOnly(value)) return value as ServerOnly<T>;
  if (isDeferred(value)) {
    throw new TypeError(
      "serverOnly() cannot wrap a defer() marker. A deferred value is resolved before the " +
        "response is written, so mark the resolved field instead: defer(async () => " +
        "serverOnly(await load())).",
    );
  }
  return new ServerOnlyValue(value) as unknown as ServerOnly<T>;
}

/** Whether `value` was produced by {@link serverOnly}. */
export function isServerOnly(value: unknown): value is ServerOnly<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[SERVER_ONLY] === true
  );
}

/**
 * Whether `value` is the placeholder that replaced a {@link serverOnly} value
 * in the inline hydration state — that is, whether this is the browser looking
 * at a field the server deliberately did not send.
 */
export function isServerOnlyPlaceholder(value: unknown): value is ServerOnlyPlaceholder {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[SERVER_ONLY_PLACEHOLDER_KEY] === true
  );
}

/** @internal Build the placeholder written into the inline hydration state. */
export function serverOnlyPlaceholder(): ServerOnlyPlaceholder {
  return { [SERVER_ONLY_PLACEHOLDER_KEY]: true };
}

/**
 * Read a {@link serverOnly} value.
 *
 * Server-side code — `head()`, `headers()`, an API route sharing the loader —
 * uses this to get at the value. During hydration the browser holds the
 * placeholder instead and this throws, which is the point: the alternative is
 * a component that renders an empty hole only in production.
 *
 * Plain values pass through, so a field can be marked later without touching
 * its readers.
 */
export function readServerOnly<T>(value: ServerOnly<T> | T): T {
  if (isServerOnly(value)) return (value as unknown as ServerOnlyValue<T>).value;
  if (isServerOnlyPlaceholder(value)) {
    throw new TypeError(
      "readServerOnly() was called in the browser on a value the server stripped from the " +
        "hydration state. serverOnly() fields are only readable during the server render and " +
        "after a client-side navigation; render them through <StaticHtml> so the subtree is " +
        "adopted from the document instead of re-rendered.",
    );
  }
  return value as T;
}
