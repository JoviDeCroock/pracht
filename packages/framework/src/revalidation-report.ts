import type { RouteRevalidate } from "./types.ts";
import { hasWebhookRevalidate } from "./revalidation-policy.ts";

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
