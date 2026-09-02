import { redirect } from "@pracht/core";
import type { MiddlewareArgs, MiddlewareFn } from "@pracht/core";

import type { Session, SessionStorage } from "./session.ts";

export interface SessionMiddlewareOptions<
  Data extends Record<string, unknown> = Record<string, unknown>,
> {
  /**
   * Context field the session is placed on. Default: `"session"`. Change it
   * only when the app already owns that name — the docs, the `Register`
   * augmentation, and every example assume `context.session`.
   */
  contextKey?: string;
  /**
   * Called after `next()` when the session changed, to decide whether the
   * response should carry the `Set-Cookie`. The default declines on a `304 Not
   * Modified` and lets everything else through.
   */
  shouldCommit?(response: Response, session: Session<Data>): boolean;
}

export interface RequireSessionOptions<
  Data extends Record<string, unknown> = Record<string, unknown>,
> extends SessionMiddlewareOptions<Data> {
  /**
   * Where to send an unauthenticated visitor. Default: `"/login"`.
   * Root-absolute paths are placed under the configured deploy base by
   * `redirect()`, which also rejects non-http(s) schemes and CRLF.
   */
  loginPath?: string;
  /**
   * Query parameter carrying the path the visitor was trying to reach, so the
   * login handler can send them back. Default: `"redirect"`; pass `false` to
   * redirect to a bare `loginPath`.
   */
  redirectParam?: string | false;
  /**
   * What counts as authenticated. Default: the session has a `userId`.
   * The check runs on the decrypted server-side session, never on a request
   * header — a header is client-suppliable and gates nothing.
   */
  isAuthenticated?(session: Session<Data>): boolean;
  /**
   * Response for an unauthenticated **API** request. Default: `401` with a
   * JSON body. Page requests are redirected instead, including the client
   * router's route-state fetch, which follows the redirect the way a document
   * navigation would.
   */
  unauthorized?(args: MiddlewareArgs): Response;
}

/**
 * Load the session onto `context.session` for every request under it, and put
 * the `Set-Cookie` on the way back out when the session changed.
 *
 * ```ts
 * // src/middleware/session.ts
 * import { sessionMiddleware } from "@pracht/session";
 * import { sessions } from "../server/session.ts";
 *
 * export const middleware = sessionMiddleware(sessions);
 * ```
 *
 * The commit happens *after* `next()` resolves, which is the whole reason this
 * is a wrap-around middleware: a loader or API handler downstream calls
 * `context.session.set(...)` and the cookie still lands on the response that
 * handler produced. Nothing downstream has to remember to commit.
 *
 * This middleware **does not gate** — it is an augmenter. Pair it with
 * {@link requireSession}, or with an explicit check in the loader, on any
 * route that must not serve anonymous visitors.
 */
export function sessionMiddleware<Data extends Record<string, unknown> = Record<string, unknown>>(
  storage: SessionStorage<Data>,
  options: SessionMiddlewareOptions<Data> = {},
): MiddlewareFn {
  const contextKey = options.contextKey ?? "session";
  const shouldCommit = options.shouldCommit ?? defaultShouldCommit;

  return async (args, next) => {
    const session = await storage.getSession(args.request);
    attachSession(args.context, contextKey, session);
    return finalize(storage, session, await next(), args, shouldCommit);
  };
}

/**
 * {@link sessionMiddleware} plus a gate: an unauthenticated page request is
 * redirected to the login page, an unauthenticated API request gets a `401`.
 *
 * ```ts
 * // src/middleware/require-user.ts
 * import { requireSession } from "@pracht/session";
 * import { sessions } from "../server/session.ts";
 *
 * export const middleware = requireSession(sessions, { loginPath: "/login" });
 * ```
 *
 * The gate reads the decrypted server-side session, never a request header.
 * Middleware that copies a user id onto the *incoming* request's headers and
 * trusts it downstream is not a gate at all: the client controls those
 * headers. On Cloudflare Workers it does not even get that far — the incoming
 * `Request` is immutable there and the write throws.
 */
export function requireSession<Data extends Record<string, unknown> = Record<string, unknown>>(
  storage: SessionStorage<Data>,
  options: RequireSessionOptions<Data> = {},
): MiddlewareFn {
  const contextKey = options.contextKey ?? "session";
  const shouldCommit = options.shouldCommit ?? defaultShouldCommit;
  const loginPath = options.loginPath ?? "/login";
  const redirectParam = options.redirectParam === undefined ? "redirect" : options.redirectParam;
  const isAuthenticated =
    options.isAuthenticated ?? ((session: Session<Data>) => "userId" in session.data);
  const unauthorized = options.unauthorized ?? defaultUnauthorized;

  return async (args, next) => {
    const session = await storage.getSession(args.request);
    attachSession(args.context, contextKey, session);

    if (!isAuthenticated(session)) {
      // A rejected request never gets a refreshed cookie: committing here
      // would hand an anonymous visitor a rolling empty session on every
      // blocked navigation, for nothing.
      if (!isPageRoute(args.route)) return unauthorized(args);
      const target =
        redirectParam === false
          ? loginPath
          : `${loginPath}?${redirectParam}=${encodeURIComponent(args.url.pathname + args.url.search)}`;
      return redirect(target, { request: args.request });
    }

    return finalize(storage, session, await next(), args, shouldCommit);
  };
}

async function finalize<Data extends Record<string, unknown>>(
  storage: SessionStorage<Data>,
  session: Session<Data>,
  response: Response,
  args: MiddlewareArgs,
  shouldCommit: (response: Response, session: Session<Data>) => boolean,
): Promise<Response> {
  // A prerendered route's output is stored once and replayed to everyone, so
  // it can depend on no request state at all. Marking it `Vary: Cookie` would
  // only make an ISG response fail the cacheability check for a dependency it
  // does not have. A session write on such a route still commits — and a
  // `Set-Cookie` failing the prerender build is the correct, loud answer to
  // mutating a session in an SSG loader.
  const render = (args.route as { render?: string }).render;
  const varied = render === "ssg" || render === "isg" ? response : withVary(response, "Cookie");

  if (!storage.isDirty(session)) return varied;
  if (!shouldCommit(varied, session)) return varied;
  return storage.commit(session, varied);
}

function attachSession(context: unknown, key: string, session: unknown): void {
  if (context === null || typeof context !== "object") return;
  try {
    (context as Record<string, unknown>)[key] = session;
  } catch {
    // A frozen or sealed context from a custom adapter. Throwing would take
    // every route under this middleware down for a wiring problem the request
    // cannot fix, and `storage.getSession(request)` still works in the loader.
    console.error(
      `[pracht] @pracht/session: could not set context.${key} — the request context is not ` +
        "extensible. Read the session with storage.getSession(request) instead.",
    );
  }
}

function defaultUnauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/**
 * A `304` has no body and tells the client to reuse what it already has;
 * a rolling session cookie there is noise. Everything else, redirects and
 * error responses included, carries the cookie.
 */
function defaultShouldCommit(response: Response): boolean {
  return response.status !== 304;
}

/**
 * Middleware wraps both page and API routes. Only the page shape carries
 * `middlewareFiles`, which is the documented way to narrow the two apart.
 */
function isPageRoute(route: MiddlewareArgs["route"]): boolean {
  return Array.isArray((route as { middlewareFiles?: unknown }).middlewareFiles);
}

/** Append to `Vary` without duplicating entries, respecting an existing `*`. */
function withVary(response: Response, value: string): Response {
  const apply = (headers: Headers): void => {
    const current = headers.get("vary");
    if (!current) {
      headers.set("vary", value);
      return;
    }
    const values = current
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    if (values.includes("*") || values.includes(value.toLowerCase())) return;
    headers.set("vary", `${current}, ${value}`);
  };

  // A protocol switch (WebSocket `101`) carries no body and cannot be
  // reconstructed without dropping the socket handle.
  if (response.status < 200 || (response as { webSocket?: unknown }).webSocket != null) {
    return response;
  }
  try {
    apply(response.headers);
    return response;
  } catch {
    const clone = new Response(response.body, response);
    apply(clone.headers);
    return clone;
  }
}
