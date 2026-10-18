import { matchIndexedResolvedRoute } from "./route-matching.ts";
import { getServerIslandsRuntime } from "./server-islands-runtime.ts";
import { PRACHT_SERVER_ISLAND_ENDPOINT } from "./server-islands-shared.ts";
import { SAFE_METHODS } from "./runtime-constants.ts";
import {
  normalizeResponseHeaders,
  withDefaultSecurityHeaders,
  withEnhancedCapabilityFormRedirect,
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
  createTrailingSlashRedirectResponse,
  dispatchAgentSurface,
  dispatchApi,
  type HandlePrachtRequestOptions,
  discardLate,
  isClientDisconnect,
  type PrachtRequestContext,
  releaseBudgetWith,
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
 *   2. The server island endpoint (`/__pracht/server-island`) when the app has
 *      server islands, which runs a page route's middleware around one server island — see
 *      `server-islands-server.ts`.
 *   3. API routes — explicit route files win over generated projections.
 *   4. The agent surface — remote MCP, then capability HTTP endpoints.
 *   5. The page router.
 */
export async function handlePrachtRequest<TContext>(
  options: HandlePrachtRequestOptions<TContext>,
): Promise<Response> {
  // A redirect answering pracht's own fetch (an enhanced form, an islands
  // navigation) names its target instead, so the browser loads the target
  // itself: a one-time redirect is never replayed and another origin is never
  // fetched through CORS.
  return normalizeResponseHeaders(
    withEnhancedCapabilityFormRedirect(await handlePrachtRequestPipeline(options), options.request),
  );
}

async function handlePrachtRequestPipeline<TContext>(
  options: HandlePrachtRequestOptions<TContext>,
): Promise<Response> {
  const prepared = await createRequestContext(options);
  if (prepared.response) return prepared.response;
  const ctx = prepared.ctx;
  let response: Response;
  try {
    response = ctx.resolvedApp.enforceLoaderTimeout
      ? await withDeadlineBackstop(dispatchRequest(ctx), ctx)
      : await dispatchRequest(ctx);
  } catch (error) {
    ctx.budget.release();
    throw error;
  }
  // The response exists. Its unread body, `waitUntil` work, and a failed
  // request's leftovers may still keep the request budget running.
  return releaseBudgetWith(ctx.budget, response);
}

/** Longest the error path may take once an enforced budget has run out. */
const DEADLINE_GRACE_MS = 1_000;

/**
 * `defineApp({ enforceLoaderTimeout })` backstop. The middleware chains race
 * the signal and answer with the timeout error, but that error path and the
 * response finalization still await module imports and app hooks (`head()`).
 * If they have not answered within a short grace after the budget runs out,
 * send a plain 500 (499 for a client that left) and discard the late result.
 */
function withDeadlineBackstop<TContext>(
  work: Promise<Response>,
  ctx: PrachtRequestContext<TContext>,
): Promise<Response> {
  const signal = ctx.budget.signal;
  return new Promise<Response>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      timer = setTimeout(
        () => {
          discardLate(work);
          resolve(
            isClientDisconnect(ctx.request, signal)
              ? new Response(null, { status: 499 })
              : withDefaultSecurityHeaders(
                  new Response("Internal Server Error", {
                    status: 500,
                    headers: { "content-type": "text/plain; charset=utf-8" },
                  }),
                ),
          );
        },
        Math.min(ctx.loaderTimeoutMs, DEADLINE_GRACE_MS),
      );
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    const settle = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    work.then(
      (response) => {
        settle();
        resolve(response);
      },
      (error: unknown) => {
        settle();
        reject(error);
      },
    );
  });
}

async function dispatchRequest<TContext>(ctx: PrachtRequestContext<TContext>): Promise<Response> {
  // Only apps with a server islands directory own this path; every other app routes
  // it like any other URL.
  const serverIslands = getServerIslandsRuntime();
  if (ctx.routePathname === PRACHT_SERVER_ISLAND_ENDPOINT && serverIslands) {
    return serverIslands.handleRequest(ctx);
  }

  const apiResponse = await dispatchApi(ctx);
  if (apiResponse) return apiResponse;

  const agentResponse = await dispatchAgentSurface(ctx);
  if (agentResponse) return agentResponse;

  const match = matchIndexedResolvedRoute(ctx.resolvedApp, ctx.routePathname);

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

  // A matched page answers one spelling of its URL under
  // `pracht({ trailingSlash })`; the other is redirected before anything runs.
  const trailingSlashRedirect = ctx.isRouteStateRequest
    ? null
    : createTrailingSlashRedirectResponse(ctx.request);
  if (trailingSlashRedirect) return trailingSlashRedirect;

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
  createTrailingSlashRedirectResponse,
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
  useSearch,
  useShellData,
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
