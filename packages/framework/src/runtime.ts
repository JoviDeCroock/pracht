import { matchAppRoute } from "./app.ts";
import { SAFE_METHODS } from "./runtime-constants.ts";
import {
  normalizeResponseHeaders,
  withDefaultSecurityHeaders,
  withRouteResponseHeaders,
} from "./runtime-headers.ts";
import {
  createNotFoundMatch,
  renderPage,
  routeStateMethodNotAllowedResponse,
  routeStateNotFoundResponse,
} from "./runtime-page.ts";
import {
  createRequestContext,
  dispatchAgentSurface,
  dispatchApi,
  type HandlePrachtRequestOptions,
} from "./runtime-request.ts";

export type { HandlePrachtRequestOptions };

/**
 * Serve one request.
 *
 * This is the orchestrator; the stages live next door so each is callable on
 * its own — `runtime-request.ts` owns the request context, the API dispatch,
 * and the agent surface, and `runtime-page.ts` owns the page render. The order
 * they run in is the contract, and it is the whole of this function:
 *
 *   1. Normalize the request (base path, canonical URL, agent surface), or
 *      answer it outright when the URL never belonged to this app.
 *   2. API routes — explicit route files win over generated projections.
 *   3. The agent surface — remote MCP, then capability HTTP endpoints.
 *   4. The page router.
 */
export async function handlePrachtRequest<TContext>(
  options: HandlePrachtRequestOptions<TContext>,
): Promise<Response> {
  return normalizeResponseHeaders(await handlePrachtRequestPipeline(options));
}

async function handlePrachtRequestPipeline<TContext>(
  options: HandlePrachtRequestOptions<TContext>,
): Promise<Response> {
  const prepared = await createRequestContext(options);
  if (prepared.response) return prepared.response;
  const ctx = prepared.ctx;

  const apiResponse = await dispatchApi(ctx);
  if (apiResponse) return apiResponse;

  const agentResponse = await dispatchAgentSurface(ctx);
  if (agentResponse) return agentResponse;

  const match = matchAppRoute(ctx.resolvedApp, ctx.routePathname);

  if (!match) {
    if (ctx.isRouteStateRequest) {
      return routeStateNotFoundResponse(ctx.exposeDiagnostics);
    }

    // Nothing matched. When the app declares a `notFound` page, render it
    // with a 404 status — it lives outside the route table, so unlike a
    // catch-all route it only ever runs *after* matching (and, in every
    // first-party adapter, after static-asset serving) has failed.
    const notFoundMatch = createNotFoundMatch(ctx.resolvedApp, ctx.routePathname);
    if (notFoundMatch && SAFE_METHODS.has(ctx.request.method)) {
      return renderPage(ctx, notFoundMatch, { isNotFoundPage: true, status: 404 });
    }

    return withDefaultSecurityHeaders(
      new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  }

  if (!SAFE_METHODS.has(ctx.request.method)) {
    if (ctx.isRouteStateRequest) {
      return routeStateMethodNotAllowedResponse(match, ctx.exposeDiagnostics);
    }

    return withRouteResponseHeaders(
      new Response("Method not allowed", {
        status: 405,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
      { isRouteStateRequest: ctx.isRouteStateRequest },
    );
  }

  return renderPage(ctx, match, { isNotFoundPage: false, status: 200 });
}

// Public runtime surface — re-exported so `./runtime.ts` remains the
// single import entry for the framework's runtime API.
export {
  createBaseRedirectResponse,
  isFirstPartyFetch,
  type PrachtRequestContext,
} from "./runtime-request.ts";
export {
  applyDefaultSecurityHeaders,
  isProtocolSwitchResponse,
  normalizeResponseHeaders,
  preventHeuristicCaching,
} from "./runtime-headers.ts";
export { formatServerTimingHeader, type PrachtPhaseTimings } from "./runtime-timing.ts";
export {
  deserializeRouteError,
  type PrachtRuntimeDiagnosticPhase,
  type PrachtRuntimeDiagnostics,
  type RouteErrorContext,
  type SerializedRouteError,
} from "./runtime-errors.ts";
export {
  Form,
  Link,
  PrachtRuntimeProvider,
  readHydrationState,
  startApp,
  useBlocker,
  useLocation,
  useNavigation,
  useParams,
  useRevalidate,
  useRouteData,
  useSearchParams,
  type FormProps,
  type LinkHrefGuidance,
  type LinkProps,
  type Location,
  type Navigation,
  type NavigationLocation,
  type Blocker,
  type BlockerArgs,
  type BlockerHistoryAction,
  type BlockerState,
  type RegisterBlockerOptions,
  type ShouldBlockNavigation,
  type PrachtHydrationState,
  type ReadonlyURLSearchParams,
  type StartAppOptions,
} from "./runtime-hooks.ts";
export {
  fetchPrachtRouteState,
  parseSafeNavigationUrl,
  type RouteStateResult,
} from "./runtime-client-fetch.ts";
