import type { MiddlewareArgs, ResolvedRoute } from "@pracht/core";

export const SECRET = "test-secret-at-least-16-chars";
export const OTHER_SECRET = "another-secret-at-least-16";

/** Every `Set-Cookie` on a response, across runtimes that expose them differently. */
export function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?(): string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = response.headers.get("set-cookie");
  return single === null ? [] : [single];
}

/** Turn a `Set-Cookie` value into the `Cookie` header a browser would send back. */
export function toCookieHeader(setCookie: string): string {
  return setCookie.split(";")[0];
}

/** Read one attribute (or test for a valueless flag) on a `Set-Cookie` value. */
export function cookieAttribute(setCookie: string, name: string): string | boolean {
  for (const part of setCookie.split(";").slice(1)) {
    const trimmed = part.trim();
    const equals = trimmed.indexOf("=");
    if (equals === -1) {
      if (trimmed.toLowerCase() === name.toLowerCase()) return true;
      continue;
    }
    if (trimmed.slice(0, equals).toLowerCase() === name.toLowerCase()) {
      return trimmed.slice(equals + 1);
    }
  }
  return false;
}

interface ArgsInput {
  context?: Record<string, unknown>;
  request: Request;
}

/**
 * The args the runtime hands a middleware wrapping a **page** route. Built by
 * hand rather than through `@pracht/test` so this package keeps a single
 * workspace dependency.
 */
export function middlewareArgs(
  input: ArgsInput & { route?: Partial<ResolvedRoute> },
): MiddlewareArgs {
  const url = new URL(input.request.url);
  return baseArgs(input, url, {
    path: url.pathname,
    file: "test://route.tsx",
    middleware: [],
    middlewareFiles: [],
    segments: [],
    ...input.route,
  });
}

/**
 * The same for an **API** route. The match has API metadata only — no
 * `middlewareFiles`, which is how the runtime (and `requireSession`) tells a
 * data request apart from a document one.
 */
export function apiMiddlewareArgs(input: ArgsInput): MiddlewareArgs {
  const url = new URL(input.request.url);
  return baseArgs(input, url, {
    path: url.pathname,
    file: "test://api-route.ts",
    segments: [],
  });
}

function baseArgs(input: ArgsInput, url: URL, route: unknown): MiddlewareArgs {
  return {
    request: input.request,
    params: {},
    pathname: url.pathname,
    context: input.context ?? {},
    signal: new AbortController().signal,
    url,
    route,
  } as unknown as MiddlewareArgs;
}
