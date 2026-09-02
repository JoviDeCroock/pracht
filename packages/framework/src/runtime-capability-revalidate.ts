/**
 * Effect-driven route revalidation after a capability call settles.
 *
 * A successful non-`read` capability call invalidates whatever the active
 * route's loader returned, so the runtime re-fetches it. The listener lives
 * here, apart from `runtime-context.ts`, because only two places can dispatch
 * `CAPABILITY_SETTLED_EVENT` — `<Form capability>` and the generated
 * `callCapability()` — and both call `ensureCapabilityRevalidation()` before
 * they do. `<Form capability>` reaches it through a dynamic `import()`, so this
 * module and `runtime-revalidate.ts` land in a lazy chunk that a page only
 * fetches once a capability submission is actually under way: rendering a plain
 * `<Form action=…>` costs nothing. The generated `callCapability()` imports it
 * eagerly — that module only exists in apps that registered capabilities.
 *
 * `<Form>` still imports the wire-protocol constants from
 * `@pracht/capabilities` — header names and the capability URL formula are
 * needed to render the form element itself. That is a handful of string
 * constants out of a side-effect-free module, not the capability runtime.
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
