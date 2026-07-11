import { deserializeRouteError } from "./runtime-errors.ts";
import { fetchPrachtRouteState, navigateToClientLocation } from "./runtime-client-fetch.ts";
import type { PrachtRuntimeValue } from "./runtime-context.ts";

/**
 * Re-fetch the active route's loader data and commit it to the runtime.
 * Shared by `useRevalidate()`, `<Form capability>` submissions, and the
 * capability-settled listener in the runtime provider, so every mutation
 * path refreshes the page the same way.
 */
export async function revalidateRouteData(
  runtime: PrachtRuntimeValue | undefined,
): Promise<unknown> {
  if (typeof window === "undefined") {
    return undefined;
  }

  const path = runtime?.url || window.location.pathname + window.location.search;
  const result = await fetchPrachtRouteState(path, { cache: "reload" });

  if (result.type === "redirect") {
    await navigateToClientLocation(result.location);
    return undefined;
  }

  if (result.type === "error") {
    throw deserializeRouteError(result.error);
  }

  runtime?.setData(result.data);
  return result.data;
}

/**
 * Detail shape of the CAPABILITY_SETTLED_EVENT window event. `effect` and
 * `revalidate` are absent when the dispatcher doesn't know them (e.g.
 * `<Form capability>` doesn't know the effect class; form posts are
 * mutations by nature so it revalidates unless the envelope failed).
 */
export interface CapabilitySettledDetail {
  name: string;
  ok: boolean;
  effect?: string | null;
  revalidate?: boolean;
}

/** A settled capability call refreshes route data unless it was a read, failed, or opted out. */
export function shouldRevalidateAfterCapability(detail: unknown): boolean {
  if (!detail || typeof detail !== "object") return false;
  const settled = detail as CapabilitySettledDetail;
  return settled.ok === true && settled.effect !== "read" && settled.revalidate !== false;
}
