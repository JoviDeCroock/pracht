import { matchResolvedRoute } from "./route-matching.ts";
import { markHydrating, onHydrationComplete } from "./hydration.ts";
import type { ClientRouteRenderer } from "./router-renderer.ts";
import { resolveBrowserRouteTarget } from "./router-browser.ts";
import { fetchPrachtRouteState, parseSafeNavigationUrl } from "./runtime-client-fetch.ts";
import { NOT_FOUND_ROUTE_ID } from "./runtime-constants.ts";
import type { SerializedRouteError } from "./runtime-errors.ts";
import type { PrachtHydrationState } from "./runtime-context.ts";
import type { ResolvedPrachtApp } from "./types.ts";

export interface InitialRouteBootstrapOptions {
  app: ResolvedPrachtApp;
  initialState: PrachtHydrationState;
  renderer: ClientRouteRenderer;
}

/** Hydrate the server state, or complete a pending SPA bootstrap fetch. */
export async function bootstrapInitialRoute(options: InitialRouteBootstrapOptions): Promise<void> {
  const { app, initialState, renderer } = options;
  const initialTarget = resolveBrowserRouteTarget(initialState.url);
  const initialRequestUrl = initialTarget?.requestUrl ?? initialState.url;
  const initialBrowserUrl = initialTarget?.browserUrl ?? initialState.url;
  const initialPathname = initialTarget?.pathname ?? initialState.url;
  const hydrationBrowserTarget = resolveBrowserRouteTarget(
    window.location.pathname + window.location.search + window.location.hash,
  );

  // The not-found page is served at an unmatched URL, so its reserved
  // hydration-state id is the only way to recover the route for hydration.
  const initialMatch =
    matchResolvedRoute(app, initialPathname) ??
    (initialState.routeId === NOT_FOUND_ROUTE_ID && app.notFound
      ? { route: app.notFound, params: {}, pathname: initialPathname }
      : undefined);
  if (!initialMatch) return;

  const isPendingSpa = initialMatch.route.render === "spa" && initialState.pending;
  const initialShellPromise = isPendingSpa ? renderer.startShellImport(initialMatch) : null;
  let state: { data: unknown; error?: SerializedRouteError | null } = {
    data: initialState.data,
    error: initialState.error ?? null,
  };

  if (isPendingSpa) {
    // This query form matches the route-state preload emitted during SSR.
    const dataPromise = fetchPrachtRouteState(initialRequestUrl, { useDataParam: true });
    const pendingState = await renderer.resolveSpaPendingState(
      initialMatch,
      initialRequestUrl,
      initialShellPromise,
    );
    if (pendingState) {
      renderer.mountRouteState(pendingState, "hydrate");
    }

    try {
      const result = await dataPromise;
      if (result.type === "redirect") {
        const safeRedirect = parseSafeNavigationUrl(result.location, window.location.href);
        if (!safeRedirect) {
          console.error(`[pracht] refused to navigate to unsafe URL: ${result.location}`);
          return;
        }
        window.location.href = safeRedirect.toString();
        return;
      }

      state =
        result.type === "error"
          ? { data: undefined, error: result.error }
          : { data: result.data, error: null };
    } catch {
      window.location.href = initialBrowserUrl;
      return;
    }

    const resolvedState = await renderer.resolveRouteState(
      initialMatch,
      state,
      initialRequestUrl,
      undefined,
      initialShellPromise,
    );
    if (resolvedState) {
      renderer.applyRouteState(resolvedState);
    }
    return;
  }

  const routeState = await renderer.resolveRouteState(
    initialMatch,
    state,
    initialRequestUrl,
    undefined,
    initialShellPromise,
  );
  if (!routeState) return;

  if (initialMatch.route.render === "spa") {
    renderer.mountRouteState(routeState, "render");
  } else {
    markHydrating();
    renderer.mountRouteState(routeState, "hydrate");
    onHydrationComplete(() => {
      if (!hydrationBrowserTarget) return;
      renderer.syncHydratedUrl(routeState, hydrationBrowserTarget.search);
    });
  }
}
