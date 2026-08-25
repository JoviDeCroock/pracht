/**
 * Effect-driven route revalidation after a capability call settles.
 *
 * A successful non-`read` capability call invalidates whatever the active
 * route's loader returned, so the runtime re-fetches it. The listener lives
 * here, apart from `runtime-context.ts`, because only two places can dispatch
 * `CAPABILITY_SETTLED_EVENT` — `<Form capability>` and the generated
 * `callCapability()` — and both call `ensureCapabilityRevalidation()` before
 * they do. An app that registers no capabilities therefore reaches neither
 * this module, `runtime-revalidate.ts`, nor `@pracht/capabilities` from its
 * client bundle.
 */

import { CAPABILITY_SETTLED_EVENT } from "@pracht/capabilities";

import { getMountedRuntimes } from "./runtime-context.ts";
import { revalidateRouteData, shouldRevalidateAfterCapability } from "./runtime-revalidate.ts";

let installed = false;

/**
 * Install the `CAPABILITY_SETTLED_EVENT` listener that refreshes route data.
 *
 * Idempotent, and safe to call before any provider has mounted: the listener
 * resolves the mounted runtimes when the event fires, not when it is added.
 *
 * @internal Called by the capability dispatch paths, not by app code.
 */
export function ensureCapabilityRevalidation(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener(CAPABILITY_SETTLED_EVENT, (event: Event) => {
    if (!shouldRevalidateAfterCapability((event as CustomEvent).detail)) return;
    for (const runtime of getMountedRuntimes()) {
      void revalidateRouteData(runtime).catch(() => {
        // Revalidation is best-effort; the mutation itself already succeeded.
      });
    }
  });
}

/** @internal Reset module state for tests. */
export function _resetForTesting(): void {
  installed = false;
}
