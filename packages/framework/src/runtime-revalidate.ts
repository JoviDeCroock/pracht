import { SERVER_ISLAND_REFRESH_EVENT } from "./server-islands-shared.ts";
import { deserializeRouteError } from "./runtime-errors.ts";
import { fetchPrachtRouteState, navigateToClientLocation } from "./runtime-client-fetch.ts";
import type { PrachtRuntimeValue } from "./runtime-context.ts";
import { applyFontHeadFragments } from "./runtime-fonts.ts";
import { commitShellData } from "./runtime-shell-data.ts";

/** Shell loader support; see `runtime-client-fetch.ts`. */
declare const __PRACHT_SHELL_LOADERS__: boolean | undefined;

const SHELL_LOADERS_ENABLED =
  typeof __PRACHT_SHELL_LOADERS__ === "undefined" || __PRACHT_SHELL_LOADERS__ !== false;

/**
 * Build-time flag: the app has a server islands directory. Server islands on full-hydration
 * pages refetch when route data is refreshed in place; apps without server islands
 * fold this to `false` and ship none of it.
 */
declare const __PRACHT_SERVER_ISLANDS__: boolean | undefined;

/**
 * Re-fetch the active route's loader data, and its shell's, and commit it.
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
    // No location on an opaque redirect: reload so the browser follows the
    // 3xx as a document navigation instead of re-fetching the same URL.
    if (!result.location) {
      window.location.reload();
      return undefined;
    }
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
  // No shell is claimed on this request, so the shell loader ran too.
  if (SHELL_LOADERS_ENABLED && result.shell && runtimeOwnsCurrentLocation(runtime)) {
    commitShellData(result.shell.data);
  }
  if (typeof __PRACHT_SERVER_ISLANDS__ !== "undefined" && __PRACHT_SERVER_ISLANDS__) {
    window.dispatchEvent(new Event(SERVER_ISLAND_REFRESH_EVENT));
  }
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
