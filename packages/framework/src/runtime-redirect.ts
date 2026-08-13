import { parseSafeNavigationUrl } from "./runtime-client-fetch.ts";
import { SAFE_METHODS } from "./runtime-constants.ts";

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
  if (!safeUrl) throw new Error("Refused unsafe redirect target");

  const method = (options.method ?? "GET").toUpperCase();
  const defaultStatus = SAFE_METHODS.has(method)
    ? DEFAULT_REDIRECT_STATUS_SAFE
    : DEFAULT_REDIRECT_STATUS_UNSAFE;

  return new Response(null, {
    status: options.status ?? defaultStatus,
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
