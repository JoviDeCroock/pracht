import { applyTrailingSlash } from "./base.ts";
import { serverEnv } from "./env-server.ts";
import type { RouteRevalidate, RouteRevalidatePolicy } from "./types.ts";

export const PRACHT_REVALIDATE_ENDPOINT = "/__pracht/revalidate";
export const PRACHT_REVALIDATE_TOKEN_ENV = "PRACHT_REVALIDATE_TOKEN";
export const PRACHT_REVALIDATE_TOKEN_HEADER = "x-pracht-revalidate-token";

/**
 * The configured webhook revalidation token, read through `serverEnv` so it
 * resolves on every runtime pracht targets.
 *
 * Adapters must not reach for `process.env` (or `globalThis.process.env`)
 * themselves. Vite defines `process.env` away in edge SSR builds, and a
 * single-use local alias is inlined by the package bundler before Vite sees
 * it — which silently compiled the Vercel adapter's read down to
 * `return {}[PRACHT_REVALIDATE_TOKEN_ENV]` and made webhook revalidation
 * unauthenticatable in production. `serverEnv` centralises that hazard behind
 * one define-proof accessor that also picks up Cloudflare's request-scoped
 * bindings.
 */
export function resolveRevalidationToken(): string | undefined {
  try {
    const token = serverEnv[PRACHT_REVALIDATE_TOKEN_ENV];
    return typeof token === "string" && token !== "" ? token : undefined;
  } catch {
    // Cloudflare installs its bindings when a request enters the adapter.
    // Before that there is intentionally no ambient environment.
    return undefined;
  }
}

const MAX_REVALIDATION_PATHS = 64;

/**
 * Why a revalidation webhook did not act on a path.
 *
 * The endpoint used to answer with bare path arrays, so a typo, a route that
 * is not ISG, and a route that simply never opted into `webhookRevalidate()`
 * were indistinguishable — an operator wiring a CMS got a `200` and silence.
 */
export type RevalidationSkipReason =
  | "not_a_route"
  | "not_isg"
  | "not_prerendered"
  | "no_webhook_policy";

export type RevalidationOutcome = "revalidated" | "skipped" | "failed";

/**
 * Where a revalidated page is now current: on the server `instance` that
 * received the webhook, in the Cloudflare data center (`colo`) that received
 * it, or everywhere the platform serves it (`global`).
 */
export type RevalidationScope = "instance" | "colo" | "global";

const REVALIDATION_SCOPE_REACH: Record<RevalidationScope, number> = {
  instance: 0,
  colo: 1,
  global: 2,
};

export interface RevalidationDetail {
  path: string;
  outcome: RevalidationOutcome;
  /** Present for `skipped`, and for `failed` when the cause is known. */
  reason?: RevalidationSkipReason | string;
  /** Present for `revalidated` when the adapter declares a scope. */
  scope?: RevalidationScope;
}

export interface RevalidationReportBody {
  /**
   * The narrowest scope among the revalidated paths, or the adapter's scope
   * when none was revalidated.
   */
  scope?: RevalidationScope;
  revalidated: string[];
  skipped: string[];
  failed: string[];
  details: RevalidationDetail[];
}

/**
 * Accumulates a revalidation batch's outcome.
 *
 * Shared by every adapter so the wire shape cannot drift between them.
 * The three legacy arrays are still emitted verbatim — existing webhook
 * consumers keep working — with `details` carrying the per-path reason.
 */
export class RevalidationReport {
  readonly #details: RevalidationDetail[] = [];
  readonly #scope: RevalidationScope | undefined;

  /** `scope` is how far this adapter's revalidation reaches by default. */
  constructor(scope?: RevalidationScope) {
    this.#scope = scope;
  }

  revalidated(path: string, scope: RevalidationScope | undefined = this.#scope): void {
    this.#details.push(
      scope === undefined
        ? { outcome: "revalidated", path }
        : { outcome: "revalidated", path, scope },
    );
  }

  skipped(path: string, reason: RevalidationSkipReason): void {
    this.#details.push({ outcome: "skipped", path, reason });
  }

  failed(path: string, reason?: string): void {
    this.#details.push(
      reason === undefined
        ? { outcome: "failed", path }
        : {
            outcome: "failed",
            path,
            reason,
          },
    );
  }

  toJSON(): RevalidationReportBody {
    const pick = (outcome: RevalidationOutcome): string[] =>
      this.#details.filter((detail) => detail.outcome === outcome).map((detail) => detail.path);

    let narrowest: RevalidationScope | undefined;
    for (const detail of this.#details) {
      if (detail.outcome !== "revalidated" || detail.scope === undefined) continue;
      if (
        narrowest === undefined ||
        REVALIDATION_SCOPE_REACH[detail.scope] < REVALIDATION_SCOPE_REACH[narrowest]
      ) {
        narrowest = detail.scope;
      }
    }
    const scope = narrowest ?? this.#scope;

    return {
      details: this.#details,
      failed: pick("failed"),
      revalidated: pick("revalidated"),
      ...(scope === undefined ? {} : { scope }),
      skipped: pick("skipped"),
    };
  }
}

/**
 * Classify why a webhook cannot refresh a path, or `null` when it can.
 *
 * `entry` is what the adapter can act on — a prerender-manifest entry for Node
 * and Cloudflare, the matched app route for Vercel — and `prerendered` is
 * whether there is a cached copy to refresh (an on-disk HTML file for Node, a
 * manifest entry for Cloudflare; Vercel writes through the platform and passes
 * `true`).
 *
 * `matchedRoute` only refines the *reason*, never the decision. Without it, a
 * manifest-driven adapter reports every unknown path as `not_a_route` — so a
 * real SSR route that simply is not ISG was indistinguishable from a typo,
 * which is the confusion this whole field exists to remove. Pass `null` for
 * "looked and found nothing", or omit it when the caller has no route table.
 */
export function classifyRevalidationSkip(
  entry: { render?: string; revalidate?: RouteRevalidate } | undefined,
  prerendered: boolean,
  matchedRoute?: { render?: string } | null,
): RevalidationSkipReason | null {
  if (!entry) {
    if (matchedRoute == null) return "not_a_route";
    return matchedRoute.render === "isg" ? "not_prerendered" : "not_isg";
  }
  // Strict equality, not `!== undefined && !== "isg"`. `render` is optional on
  // a resolved route and stays `undefined` when neither the route nor its group
  // sets one, so treating `undefined` as "unknown, proceed" made the Vercel
  // webhook act on a non-ISG route that merely declared `webhookRevalidate()` —
  // where it previously skipped. Node and Cloudflare synthesize `"isg"` because
  // their prerender manifests only ever contain ISG entries.
  if (entry.render !== "isg") return "not_isg";
  if (!prerendered) return "not_prerendered";
  if (!hasWebhookRevalidate(entry.revalidate)) return "no_webhook_policy";
  return null;
}

export type RevalidationSingleFlight = <T>(key: string, task: () => Promise<T>) => Promise<T>;

/**
 * Deduplicate concurrent regenerations of the same path. Without this, a
 * stampede of requests against a stale ISG page (or repeated webhook posts)
 * triggers N parallel renders that all race to write the same output.
 * Callers sharing one single-flight instance receive the in-flight promise
 * instead of starting another regeneration.
 */
export function createRevalidationSingleFlight(): RevalidationSingleFlight {
  const inflight = new Map<string, Promise<unknown>>();

  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const existing = inflight.get(key);
    if (existing) return existing as Promise<T>;

    const pending = Promise.resolve()
      .then(task)
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, pending);
    return pending;
  };
}

/**
 * An ISG response is safe to persist in a shared cache only when it doesn't
 * depend on request-specific state (cookies, auth) that the cached copy would
 * replay to every visitor. `Cache-Control: private` / `no-store`, any
 * `Set-Cookie`, and a `Vary` that implies per-request output (cookie,
 * authorization) all signal "don't cache this across users".
 */
export function isCacheableISGResponse(response: Response): boolean {
  const cacheControl = response.headers.get("cache-control")?.toLowerCase() ?? "";
  if (/\b(no-store|private)\b/.test(cacheControl)) return false;

  if (response.headers.get("set-cookie")) return false;

  const vary = response.headers.get("vary")?.toLowerCase() ?? "";
  if (!vary) return true;
  if (vary.includes("*")) return false;
  const varied = vary.split(",").map((s) => s.trim());
  for (const name of varied) {
    if (name === "cookie" || name === "authorization") return false;
  }
  return true;
}

const DANGEROUS_PRERENDER_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "www-authenticate",
]);
const SECRET_SHAPED_PRERENDER_HEADER_RE =
  /^x-.*(?:api[-_]?key|client[-_]?secret|credential|jwt[-_]?secret|password|private[-_]?key|refresh[-_]?token|secret|session[-_]?secret|token|webhook[-_]?secret)(?:$|[-_])/i;

/**
 * Headers that must never ride along with output stored in a shared cache.
 * Prerendered documents — and ISG responses regenerated at runtime — are
 * replayed verbatim to every visitor, so a `Set-Cookie` or credential header
 * produced by one render would be handed to all of them.
 */
export function isDangerousPrerenderHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    DANGEROUS_PRERENDER_HEADER_NAMES.has(normalized) ||
    SECRET_SHAPED_PRERENDER_HEADER_RE.test(normalized)
  );
}

// ---------------------------------------------------------------------------
// ISG snapshots
//
// What an adapter stores for a regenerated ISG page, and how it replays it.
// Every adapter captures and serves through these functions; only where the
// snapshot lives (a file, the Cache API, Vercel's ISR cache) is per adapter.
// ---------------------------------------------------------------------------

/** A regenerated ISG page as an adapter stores it. */
export interface ISGSnapshot {
  html: string;
  /**
   * The render's document headers: transfer headers and `Cache-Control` are
   * dropped, and credential-shaped headers are stripped.
   */
  headers: Record<string, string>;
  /** The render's own `Cache-Control`, kept apart from any storage TTL. */
  cacheControl: string | null;
  /** The `buildId` of the server entry that rendered it, when known. */
  buildId: string | null;
  /** When it was rendered, in milliseconds since the epoch. */
  generatedAt: number;
}

/** Why a render was not captured as a snapshot. */
export interface ISGSnapshotRejection {
  reason: "status" | "uncacheable";
  detail: string;
}

const ISG_SNAPSHOT_FORMAT = 1;

/** Response headers that describe one transfer, not the document. */
const ISG_TRANSFER_HEADERS = new Set([
  "age",
  "cache-control",
  "connection",
  "content-encoding",
  "content-length",
  "date",
  "etag",
  "keep-alive",
  "last-modified",
  "transfer-encoding",
  "x-pracht-isg",
]);

const ISG_CACHE_KEY_BUILD_PREFIX = "/__pracht/isg-build";

/**
 * The headers of a render that may be replayed to every visitor, with
 * credential-shaped ones removed (and logged, naming `pathname`).
 */
export function stripISGSecretHeaders(headers: Headers, pathname: string): Headers {
  const stripped = new Headers(headers);
  const dangerous = [...headers.keys()].filter(isDangerousPrerenderHeader);
  if (dangerous.length === 0) return stripped;
  for (const name of dangerous) stripped.delete(name);
  console.error(
    `Stripped ${dangerous.map((name) => `"${name}"`).join(", ")} from the ISG snapshot for ` +
      `"${pathname}" — snapshots are replayed to every visitor. Move cookies and credential ` +
      "headers to API routes, middleware responses, or an SSR route.",
  );
  return stripped;
}

/**
 * Capture a rendered ISG page as a snapshot, or say why it cannot be one: only
 * a `200` that {@link isCacheableISGResponse} accepts is shared. Reads the
 * body of an accepted response only.
 */
export async function captureISGSnapshot(
  response: Response,
  meta: { buildId?: string | null; pathname: string; now?: number },
): Promise<ISGSnapshot | ISGSnapshotRejection> {
  if (response.status !== 200) {
    return { reason: "status", detail: `the render answered ${response.status}` };
  }
  if (!isCacheableISGResponse(response)) {
    return {
      reason: "uncacheable",
      detail:
        "the render marks itself uncacheable (Cache-Control private/no-store, Set-Cookie, " +
        "or Vary on Cookie/Authorization)",
    };
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of stripISGSecretHeaders(response.headers, meta.pathname)) {
    if (!ISG_TRANSFER_HEADERS.has(name)) headers[name] = value;
  }
  return {
    html: await response.text(),
    headers,
    cacheControl: response.headers.get("cache-control"),
    buildId: meta.buildId ?? null,
    generatedAt: meta.now ?? Date.now(),
  };
}

/** Whether {@link captureISGSnapshot} refused the render. */
export function isISGSnapshotRejection(
  value: ISGSnapshot | ISGSnapshotRejection,
): value is ISGSnapshotRejection {
  return "reason" in value;
}

/**
 * The response a snapshot replays. Its `Cache-Control` is the render's own,
 * or `browserCacheControl` when the render set none. With `stale`, the
 * response says whether it is (`x-pracht-isg: stale | fresh`).
 */
export function serveISGSnapshot(
  snapshot: ISGSnapshot,
  options: { stale?: boolean; browserCacheControl?: string } = {},
): Response {
  const headers = new Headers(snapshot.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/html; charset=utf-8");
  const cacheControl = snapshot.cacheControl ?? options.browserCacheControl;
  if (cacheControl) headers.set("cache-control", cacheControl);
  if (options.stale !== undefined) headers.set("x-pracht-isg", options.stale ? "stale" : "fresh");
  return new Response(snapshot.html, { status: 200, headers });
}

/** A snapshot as one string, so storing it is one atomic write. */
export function encodeISGSnapshot(snapshot: ISGSnapshot): string {
  return JSON.stringify({
    format: ISG_SNAPSHOT_FORMAT,
    html: snapshot.html,
    headers: snapshot.headers,
    cacheControl: snapshot.cacheControl,
    buildId: snapshot.buildId,
    generatedAt: snapshot.generatedAt,
  });
}

/** The snapshot {@link encodeISGSnapshot} wrote, or `null` for anything else. */
export function decodeISGSnapshot(text: string): ISGSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const { html, headers, cacheControl, buildId, generatedAt } = record;
  if (
    record.format !== ISG_SNAPSHOT_FORMAT ||
    typeof html !== "string" ||
    !headers ||
    typeof headers !== "object" ||
    Array.isArray(headers) ||
    !Object.values(headers).every((header) => typeof header === "string") ||
    (cacheControl !== null && typeof cacheControl !== "string") ||
    (buildId !== null && typeof buildId !== "string") ||
    typeof generatedAt !== "number" ||
    !Number.isFinite(generatedAt)
  ) {
    return null;
  }
  return {
    html,
    headers: { ...(headers as Record<string, string>) },
    cacheControl,
    buildId,
    generatedAt,
  };
}

/**
 * The cache key path of an ISG page for one build. The build sits in the
 * path, not the query, because a cache key may ignore query strings. Without
 * a build the key is the bare path, shared by every build.
 */
export function isgCacheKeyPath(pathname: string, buildId: string | null | undefined): string {
  return buildId
    ? `${ISG_CACHE_KEY_BUILD_PREFIX}/${encodeURIComponent(buildId)}${pathname}`
    : pathname;
}

export type RevalidationRequestResult =
  | {
      ok: true;
      paths: string[];
    }
  | {
      ok: false;
      response: Response;
    };

export function normalizeRouteRevalidate(revalidate: RouteRevalidate): RouteRevalidatePolicy[] {
  const policies = Array.isArray(revalidate) ? [...revalidate] : [revalidate];
  if (policies.length === 0) {
    throw new Error("Route revalidate policy arrays must contain at least one policy.");
  }

  const seen = new Set<string>();
  for (const policy of policies) {
    if (!policy || typeof policy !== "object") {
      throw new Error("Route revalidate policies must be objects.");
    }
    if (seen.has(policy.kind)) {
      throw new Error(
        `Route revalidate policies cannot include duplicate "${policy.kind}" entries.`,
      );
    }
    seen.add(policy.kind);

    if (policy.kind === "time") {
      if (!Number.isInteger(policy.seconds) || policy.seconds <= 0) {
        throw new Error("time revalidate policies expect a positive integer number of seconds.");
      }
      continue;
    }

    if (policy.kind === "webhook") {
      continue;
    }

    throw new Error(
      `Unsupported route revalidate policy "${String((policy as { kind?: unknown }).kind)}".`,
    );
  }

  return policies;
}

export function getTimeRevalidateSeconds(revalidate: RouteRevalidate | undefined): number | null {
  if (!revalidate) return null;
  for (const policy of normalizeRouteRevalidate(revalidate)) {
    if (policy.kind === "time") return policy.seconds;
  }
  return null;
}

export function hasWebhookRevalidate(revalidate: RouteRevalidate | undefined): boolean {
  if (!revalidate) return false;
  return normalizeRouteRevalidate(revalidate).some((policy) => policy.kind === "webhook");
}

export async function readRevalidationRequest(
  request: Request,
  token: string | undefined,
): Promise<RevalidationRequestResult> {
  if (request.method !== "POST") {
    return {
      ok: false,
      response: jsonResponse({ error: "Method Not Allowed" }, 405, {
        allow: "POST",
      }),
    };
  }

  if (!isAuthorizedRevalidationRequest(request, token)) {
    return {
      ok: false,
      response: jsonResponse({ error: "Unauthorized" }, 401),
    };
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      ok: false,
      response: jsonResponse({ error: "Expected a JSON body." }, 400),
    };
  }

  if (hasTooManyRevalidationPaths(body)) {
    return {
      ok: false,
      response: jsonResponse(
        { error: `Expected at most ${MAX_REVALIDATION_PATHS} revalidation paths.` },
        400,
      ),
    };
  }

  const paths = parseRevalidationPaths(body);
  if (!paths) {
    return {
      ok: false,
      response: jsonResponse({ error: 'Expected body shape `{ "paths": ["/path"] }`.' }, 400),
    };
  }

  return {
    ok: true,
    paths,
  };
}

export function isAuthorizedRevalidationRequest(
  request: Request,
  token: string | undefined,
): boolean {
  if (typeof token !== "string" || token.length === 0) {
    return false;
  }

  const provided = getRevalidationToken(request);
  if (!provided) return false;
  return constantTimeEqual(provided, token);
}

/**
 * Build the request an ISG render runs on. The rendered HTML lands in a shared
 * cache and is replayed to every later visitor, so the render must not see the
 * triggering visitor's cookies, credentials, or query string — only the path.
 * `base` supplies the origin (a `Request`, `URL`, or absolute URL string).
 */
export function createISGRegenerationRequest(
  pathname: string,
  base?: Request | URL | string,
): Request {
  const baseUrl =
    base === undefined
      ? new URL("http://localhost")
      : new URL(base instanceof Request ? base.url : base);
  // The page's canonical spelling: under `pracht({ trailingSlash })` the
  // other one answers with a redirect, which is not a page to cache.
  const regenerationUrl = new URL(applyTrailingSlash(pathname), baseUrl);

  return new Request(regenerationUrl, {
    method: "GET",
    headers: { accept: "text/html" },
  });
}

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function getRevalidationToken(request: Request): string | null {
  const headerToken = request.headers.get(PRACHT_REVALIDATE_TOKEN_HEADER);
  if (headerToken) return headerToken;

  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function parseRevalidationPaths(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const value = getRevalidationPathsValue(body);
  const paths = Array.isArray(value) ? value : typeof value === "string" ? [value] : null;
  if (!paths || paths.length === 0) return null;

  const unique = new Set<string>();
  for (const path of paths) {
    if (!isValidRevalidationPath(path)) return null;
    unique.add(path);
  }
  return [...unique];
}

function hasTooManyRevalidationPaths(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const value = getRevalidationPathsValue(body);
  return Array.isArray(value) && value.length > MAX_REVALIDATION_PATHS;
}

function getRevalidationPathsValue(body: object): unknown {
  return (body as { paths?: unknown; path?: unknown }).paths ?? (body as { path?: unknown }).path;
}

function isValidRevalidationPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\0") &&
    !value.includes("?") &&
    !value.includes("#") &&
    !value.includes("\\") &&
    !value.split("/").includes("..")
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let i = 0; i < length; i += 1) {
    diff |= (leftBytes[i] ?? 0) ^ (rightBytes[i] ?? 0);
  }

  return diff === 0;
}
