import { parseSafeNavigationUrl } from "./runtime-client-fetch.ts";
import { SAFE_METHODS } from "./runtime-constants.ts";
import { applyHeaders, withDefaultSecurityHeaders } from "./runtime-headers.ts";
import { resolveRegistryModule } from "./runtime-manifest.ts";
import type {
  BaseRouteArgs,
  HeadMetadata,
  MiddlewareModule,
  ModuleRegistry,
  ResolvedApiRoute,
  RouteModule,
  ShellModule,
} from "./types.ts";

const DEFAULT_REDIRECT_STATUS_SAFE = 302;
const DEFAULT_REDIRECT_STATUS_UNSAFE = 303;

/**
 * Build a safe redirect response from middleware/loader output. Rejects
 * non-http(s) schemes (no `javascript:`/`data:`/etc.) and CR/LF injection
 * against the `Location` header. When status is omitted, non-GET/HEAD
 * requests default to 303 so the browser does not resend the body to the
 * redirect target; safe methods default to 302.
 *
 * The original `target` string is preserved on success (relative paths
 * stay relative) — we only parse it to validate scheme, not to rewrite
 * it. Both the original input and its resolved URL must be CR/LF-free.
 */
export function buildRedirectResponse(
  target: string,
  options: { baseUrl: string | URL; method?: string; status?: number },
): Response {
  if (/[\r\n]/.test(target)) {
    throw new Error("Refused redirect target containing CR/LF");
  }
  const safeUrl = parseSafeNavigationUrl(target, options.baseUrl);
  if (!safeUrl) {
    throw new Error("Refused unsafe redirect target");
  }

  const method = (options.method ?? "GET").toUpperCase();
  const defaultStatus = SAFE_METHODS.has(method)
    ? DEFAULT_REDIRECT_STATUS_SAFE
    : DEFAULT_REDIRECT_STATUS_UNSAFE;
  const status = options.status ?? defaultStatus;

  return new Response(null, {
    status,
    headers: { location: target },
  });
}

export async function runMiddlewareChain<TContext>(options: {
  context: TContext;
  middlewareFiles: string[];
  params: Record<string, string>;
  registry: ModuleRegistry;
  request: Request;
  route: BaseRouteArgs<TContext>["route"] | ResolvedApiRoute;
  url: URL;
}): Promise<
  { context: TContext; response?: undefined } | { response: Response; context?: undefined }
> {
  let context = options.context;

  // Kick off module resolution for every middleware in parallel. Execution
  // below still runs sequentially — middleware may mutate context and the
  // ordering is part of the public contract — but the imports themselves
  // have no inter-dependency, so waiting for them one-by-one is pure
  // latency for no benefit. On cold starts where middleware ships as its
  // own chunks this can meaningfully reduce TTFB.
  const modulePromises = options.middlewareFiles.map((mwFile) =>
    resolveRegistryModule<MiddlewareModule>(options.registry.middlewareModules, mwFile),
  );
  // Suppress unhandled-rejection warnings for promises that may not be
  // awaited if an earlier middleware short-circuits with a response.
  for (const p of modulePromises) {
    p.catch(() => {});
  }

  for (const modulePromise of modulePromises) {
    const mwModule = await modulePromise;
    if (!mwModule?.middleware) continue;

    const result = await mwModule.middleware({
      request: options.request,
      params: options.params,
      context,
      signal: AbortSignal.timeout(30_000),
      url: options.url,
      route: options.route as BaseRouteArgs<TContext>["route"],
    });

    if (!result) continue;
    if (result instanceof Response) {
      return { response: withDefaultSecurityHeaders(result) };
    }
    if ("redirect" in result) {
      const status = "status" in result ? result.status : undefined;
      return {
        response: withDefaultSecurityHeaders(
          buildRedirectResponse(result.redirect, {
            baseUrl: options.request.url,
            method: options.request.method,
            status,
          }),
        ),
      };
    }
    if ("context" in result) {
      context = { ...context, ...result.context } as TContext;
    }
  }

  return { context };
}

export async function mergeHeadMetadata(
  shellModule: ShellModule | undefined,
  routeModule: RouteModule | undefined,
  routeArgs: BaseRouteArgs<unknown>,
  data: unknown,
): Promise<HeadMetadata> {
  // Shell and route `head` exports are independent — run them concurrently.
  // Merge order (shell first, then route) is preserved below.
  const [shellHead, routeHead] = await Promise.all([
    shellModule?.head ? shellModule.head(routeArgs) : Promise.resolve({} as HeadMetadata),
    routeModule?.head
      ? routeModule.head({ ...routeArgs, data } as any)
      : Promise.resolve({} as HeadMetadata),
  ]);

  return {
    title: routeHead.title ?? shellHead.title,
    lang: routeHead.lang ?? shellHead.lang,
    meta: [...(shellHead.meta ?? []), ...(routeHead.meta ?? [])],
    link: [...(shellHead.link ?? []), ...(routeHead.link ?? [])],
  };
}

export async function mergeDocumentHeaders(
  shellModule: ShellModule | undefined,
  routeModule: RouteModule | undefined,
  routeArgs: BaseRouteArgs<unknown>,
  data: unknown,
): Promise<Headers> {
  const headers = new Headers();
  // Shell and route `headers` exports are independent — run concurrently.
  // Apply order (shell first, then route) still gives route precedence.
  const [shellHeaders, routeHeaders] = await Promise.all([
    shellModule?.headers ? shellModule.headers(routeArgs) : Promise.resolve(undefined),
    routeModule?.headers
      ? routeModule.headers({ ...routeArgs, data } as any)
      : Promise.resolve(undefined),
  ]);
  if (shellHeaders) {
    applyHeaders(headers, shellHeaders);
  }
  if (routeHeaders) {
    applyHeaders(headers, routeHeaders);
  }

  return headers;
}
