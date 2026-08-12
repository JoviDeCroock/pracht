import type { RouteRevalidate, RouteRevalidatePolicy } from "./types.ts";

export {
  createISGRegenerationRequest,
  isAuthorizedRevalidationRequest,
  jsonResponse,
  PRACHT_REVALIDATE_ENDPOINT,
  PRACHT_REVALIDATE_TOKEN_ENV,
  PRACHT_REVALIDATE_TOKEN_HEADER,
  readRevalidationRequest,
  resolveRevalidationToken,
} from "./revalidation-request.ts";
export type {
  ParsedRevalidationRequest,
  RevalidationRequestResult,
} from "./revalidation-request.ts";

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

export interface RevalidationDetail {
  path: string;
  outcome: RevalidationOutcome;
  /** Present for `skipped`, and for `failed` when the cause is known. */
  reason?: RevalidationSkipReason | string;
}

export interface RevalidationReportBody {
  revalidated: string[];
  skipped: string[];
  failed: string[];
  details: RevalidationDetail[];
}

/**
 * Accumulates a revalidation batch's outcome.
 *
 * Shared by all three adapters so the wire shape cannot drift between them.
 * The three legacy arrays are still emitted verbatim — existing webhook
 * consumers keep working — with `details` carrying the per-path reason.
 */
export class RevalidationReport {
  readonly #details: RevalidationDetail[] = [];

  revalidated(path: string): void {
    this.#details.push({ outcome: "revalidated", path });
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

    return {
      details: this.#details,
      failed: pick("failed"),
      revalidated: pick("revalidated"),
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
