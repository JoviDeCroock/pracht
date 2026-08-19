import { deserializeRouteError } from "./runtime-errors.ts";
import { fetchPrachtRouteState, navigateToClientLocation } from "./runtime-client-fetch.ts";
import type { PrachtRuntimeValue } from "./runtime-context.ts";
import { applyFontHeadFragments } from "./runtime-fonts.ts";

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

  // The provider stamps setData() with the route state that started this
  // request, so a result that settles after navigation cannot overwrite the
  // new route's data. Font state lives outside that provider in document.head;
  // apply the same ownership check before mutating it.
  if (result.fontHead && runtimeOwnsCurrentLocation(runtime)) {
    applyFontHeadFragments(result.fontHead);
  }
  runtime?.setData(result.data);
  return result.data;
}

function runtimeOwnsCurrentLocation(runtime: PrachtRuntimeValue | undefined): boolean {
  if (!runtime) return true;
  if (runtime.isCurrent) return runtime.isCurrent();
  try {
    const runtimeUrl = new URL(runtime.url, window.location.href);
    return (
      runtimeUrl.pathname + runtimeUrl.search === window.location.pathname + window.location.search
    );
  } catch {
    return false;
  }
}

/**
 * Detail shape of the CAPABILITY_SETTLED_EVENT window event. `effect` and
 * `revalidate` may be absent when an older or non-Pracht dispatcher doesn't
 * know them; current generated clients and `<Form capability>` provide the
 * effect class.
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
