import { withBase } from "./base.ts";
import { parseSafeNavigationUrl } from "./runtime-client-fetch.ts";
import { SAFE_METHODS } from "./runtime-constants.ts";
import { applyHeaders } from "./runtime-headers.ts";
import type { BaseRouteArgs, HeadMetadata, RouteModule, ShellModule } from "./types.ts";

// The chain runner lives in `@pracht/capabilities/server/internal` — the capability
// core — so capability dispatch (including the standalone host) and the
// framework's page/API pipelines execute the exact same chain semantics.
export { runMiddlewareChain } from "@pracht/capabilities/server/internal";

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
 * CR/LF injection. Root-absolute route paths are placed under the configured
 * deploy base; relative, protocol-relative, and absolute URLs are preserved.
 * Pass the current request (or method) when the default status should follow
 * HTTP method safety: safe methods default to 302, unsafe methods default to
 * 303.
 *
 * ```ts
 * export const middleware: MiddlewareFn = async ({ request }, next) => {
 *   if (!hasSession(request)) return redirect("/login", { request });
 *   return next();
 * };
 * ```
 *
 * In a **page loader or API route handler**, `return` and `throw` both work.
 * Throw when the decision is made somewhere the return value cannot escape
 * from — a shared `requireUser()` helper, a nested `await` — so the caller
 * cannot forget to propagate it:
 *
 * ```ts
 * export async function loader({ request, context }: LoaderArgs) {
 *   const user = await requireUser(request, context); // throws redirect("/login")
 *   return { user };
 * }
 * ```
 *
 * Capabilities are the exception: their dispatch answers with the typed
 * `{ ok, data }` envelope on every transport, so a `Response` thrown from a
 * capability `run()` has nowhere to go and surfaces as an `internal_error`.
 * Gate capabilities in their named middleware, which returns a `Response`
 * like any other middleware.
 */
export function redirect(target: string, options: RedirectOptions = {}): Response {
  const location = withBase(target);
  if (typeof options === "number") {
    return buildRedirectResponse(location, {
      baseUrl: REDIRECT_VALIDATION_BASE,
      status: options,
    });
  }

  return buildRedirectResponse(location, {
    baseUrl: options.baseUrl ?? options.request?.url ?? REDIRECT_VALIDATION_BASE,
    method: options.method ?? options.request?.method,
    status: options.status,
  });
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

  return mergeHeadValues(shellHead, routeHead);
}

/**
 * Resolve head metadata while rendering an error boundary. Route heads receive
 * no loader data on this path, so a data-dependent head may fail; keep the
 * shell head in that case while still retaining static route registrations
 * such as fonts.
 */
export async function mergeErrorHeadMetadata(
  shellModule: ShellModule | undefined,
  routeModule: RouteModule | undefined,
  routeArgs: BaseRouteArgs<unknown>,
): Promise<HeadMetadata> {
  let shellHead: HeadMetadata = {};
  if (shellModule?.head) {
    try {
      shellHead = await shellModule.head(routeArgs);
    } catch {
      // Preserve the original route failure when shell metadata cannot be
      // evaluated. Route metadata may still provide useful static entries.
    }
  }
  let routeHead: HeadMetadata = {};
  if (routeModule?.head) {
    try {
      routeHead = await routeModule.head({ ...routeArgs, data: undefined } as any);
    } catch {
      // Preserve the original loader/render failure. Any successfully resolved
      // shell metadata remains available as a fallback.
    }
  }

  return mergeHeadValues(shellHead, routeHead);
}

function mergeHeadValues(shellHead: HeadMetadata, routeHead: HeadMetadata): HeadMetadata {
  return {
    title: routeHead.title ?? shellHead.title,
    lang: routeHead.lang ?? shellHead.lang,
    meta: [...(shellHead.meta ?? []), ...(routeHead.meta ?? [])],
    link: [...(shellHead.link ?? []), ...(routeHead.link ?? [])],
    script: [...(shellHead.script ?? []), ...(routeHead.script ?? [])],
    fontNonce: routeHead.fontNonce ?? shellHead.fontNonce,
    // Duplicate registrations (e.g. shell and route both list the same font)
    // are collapsed by the head renderer, not here, so the merge stays a
    // plain concatenation like the other arrays.
    fonts: [...(shellHead.fonts ?? []), ...(routeHead.fonts ?? [])],
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
