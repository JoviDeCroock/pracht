import { parseSafeNavigationUrl } from "./runtime-client-fetch.ts";
import { SAFE_METHODS } from "./runtime-constants.ts";
import { applyHeaders } from "./runtime-headers.ts";
import { resolveRegistryModule } from "./runtime-manifest.ts";
import type {
  BaseRouteArgs,
  HeadMetadata,
  MiddlewareArgs,
  MiddlewareModule,
  ModuleRegistry,
  ResolvedApiRoute,
  RouteModule,
  ShellModule,
} from "./types.ts";

const DEFAULT_REDIRECT_STATUS_SAFE = 302;
const DEFAULT_REDIRECT_STATUS_UNSAFE = 303;
const REDIRECT_VALIDATION_BASE = "https://invalid.pracht.local/";

export type RedirectOptions =
  | number
  | {
      baseUrl?: string | URL;
      method?: string;
      request?: Request;
      status?: number;
    };

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

/**
 * Convenience helper for middleware (and loaders/handlers) to short-circuit
 * with a redirect Response. Validates the target's scheme and rejects
 * CR/LF injection. Pass the current request (or method) when the default
 * status should follow HTTP method safety: safe methods default to 302,
 * unsafe methods default to 303.
 *
 * ```ts
 * export const middleware: MiddlewareFn = async ({ request }, next) => {
 *   if (!hasSession(request)) return redirect("/login", { request });
 *   return next();
 * };
 * ```
 */
export function redirect(target: string, options: RedirectOptions = {}): Response {
  if (typeof options === "number") {
    return buildRedirectResponse(target, {
      baseUrl: REDIRECT_VALIDATION_BASE,
      status: options,
    });
  }

  return buildRedirectResponse(target, {
    baseUrl: options.baseUrl ?? options.request?.url ?? REDIRECT_VALIDATION_BASE,
    method: options.method ?? options.request?.method,
    status: options.status,
  });
}

/**
 * Run the middleware chain wrap-around-style. Each middleware receives
 * `next` and may call it at most once. Calling `next()` invokes the rest
 * of the chain (downstream middleware then `terminal`) and resolves to
 * the final `Response`. A middleware that returns without calling `next()`
 * short-circuits with whatever Response it returned.
 *
 * Module imports are kicked off concurrently up front; execution stays
 * sequential because middleware may mutate `args.context` and ordering
 * is part of the public contract.
 */
export async function runMiddlewareChain<TContext>(options: {
  context: TContext;
  middlewareFiles: string[];
  params: Record<string, string>;
  registry: ModuleRegistry;
  request: Request;
  route: BaseRouteArgs<TContext>["route"] | ResolvedApiRoute;
  signal: AbortSignal;
  url: URL;
  terminal: () => Promise<Response>;
}): Promise<Response> {
  const { middlewareFiles, terminal } = options;

  if (middlewareFiles.length === 0) {
    return terminal();
  }

  // Kick off module resolution for every middleware in parallel. Execution
  // below still runs sequentially — middleware may mutate context and the
  // ordering is part of the public contract — but the imports themselves
  // have no inter-dependency, so waiting for them one-by-one is pure
  // latency for no benefit. On cold starts where middleware ships as its
  // own chunks this can meaningfully reduce TTFB.
  const modulePromises = middlewareFiles.map((mwFile) =>
    resolveRegistryModule<MiddlewareModule>(options.registry.middlewareModules, mwFile),
  );
  // Suppress unhandled-rejection warnings for promises that may not be
  // awaited if an earlier middleware short-circuits without calling next().
  for (const p of modulePromises) {
    p.catch(() => {});
  }

  const dispatch = async (i: number): Promise<Response> => {
    if (i >= middlewareFiles.length) {
      return terminal();
    }
    const mwModule = await modulePromises[i];
    if (!mwModule?.middleware) {
      return dispatch(i + 1);
    }

    let calledNext = false;
    const next = (): Promise<Response> => {
      if (calledNext) {
        throw new Error(`Middleware "${middlewareFiles[i]}" called next() multiple times`);
      }
      calledNext = true;
      return dispatch(i + 1);
    };

    const args: MiddlewareArgs<TContext> = {
      request: options.request,
      params: options.params,
      context: options.context,
      signal: options.signal,
      url: options.url,
      route: options.route as BaseRouteArgs<TContext>["route"],
    };

    const response = await mwModule.middleware(args, next);
    if (!(response instanceof Response)) {
      throw new Error(
        `Middleware "${middlewareFiles[i]}" did not return a Response. ` +
          "Middleware must return the result of next() or a short-circuit Response.",
      );
    }
    return response;
  };

  return dispatch(0);
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
    script: [...(shellHead.script ?? []), ...(routeHead.script ?? [])],
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
