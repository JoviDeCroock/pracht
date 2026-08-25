/**
 * Dev-only: refresh route data after a route or shell module Fast Refreshes.
 *
 * Fast Refresh patches the component in place, which is exactly what it should
 * do — and exactly why the page is now wrong when the edit touched server-only
 * code. A route module's `loader`, `head`, `headers`, and `getStaticPaths` are
 * stripped out of the browser copy, so an edit to any of them changes what the
 * server would send while the open document keeps the data it was rendered
 * with. Before Fast Refresh reached route modules this was invisible: every
 * route edit reloaded the document, which fetched the new data as a side
 * effect.
 *
 * Re-fetching route state gives back loader data and font state without giving
 * up what Fast Refresh bought. Modules that own document `headers()` reload
 * instead because a fetch cannot update the active document's response
 * headers. Other `head()` output is deliberately not re-applied: head metadata
 * is server-rendered and does not follow the client router, and dev matching
 * production matters more than a fresh `<title>` here.
 *
 * The listener is installed by the generated client entry (the only module in
 * the graph with an `import.meta.hot` of its own), and the whole path is dead
 * code in a production build.
 */

import { getMountedRuntimes } from "./runtime-context.ts";
import { revalidateRouteData } from "./runtime-revalidate.ts";

/** Custom Vite HMR event the dev server sends after a route/shell update. */
export const DEV_ROUTE_DATA_STALE_EVENT = "pracht:route-data-stale";

/**
 * Re-fetch the active route's loader data for every mounted runtime.
 *
 * @internal Called by the generated client entry's HMR listener.
 */
export function refreshDevRouteData(): void {
  let reloadRequested = false;
  for (const runtime of getMountedRuntimes()) {
    void revalidateRouteData(runtime).catch(() => {
      // A route that is no longer current cannot own the visible error. For an
      // active route, reload so a loader failure, not-found response, or error
      // boundary is rendered exactly as it was before route Fast Refresh.
      if (runtime.isCurrent?.() === false || reloadRequested) return;
      reloadRequested = true;
      window.location.reload();
    });
  }
}
