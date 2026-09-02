/**
 * The middleware contract: load the session before the chain, commit after it.
 * The "after" half is the reason these are wrap-around middleware — a loader
 * downstream mutates `context.session` and the cookie still lands on the
 * response that loader produced.
 */
import { describe, expect, it } from "vitest";

import {
  createMemorySessionStore,
  createSessionStorage,
  requireSession,
  sessionMiddleware,
  type SessionRequestContext,
} from "../src/index.ts";
import {
  apiMiddlewareArgs,
  middlewareArgs,
  SECRET,
  setCookies,
  toCookieHeader,
} from "./helpers.ts";

interface AppSession extends Record<string, unknown> {
  userId: string;
  visits: number;
}

type Context = SessionRequestContext<AppSession> & Record<string, unknown>;

function storage() {
  return createSessionStorage<AppSession>({ cookie: { name: "session", secrets: [SECRET] } });
}

describe("sessionMiddleware", () => {
  it("puts the session on context and commits a downstream mutation", async () => {
    const sessions = storage();
    const middleware = sessionMiddleware(sessions);
    const context = {} as Context;

    const response = await middleware(
      middlewareArgs({ request: new Request("https://example.com/dashboard"), context }),
      () => {
        // Stand-in for a loader: it only ever touches `context`.
        context.session.set("userId", "u_1");
        return Promise.resolve(new Response("ok"));
      },
    );

    const cookies = setCookies(response);
    expect(cookies).toHaveLength(1);
    expect((await sessions.getSession(toCookieHeader(cookies[0]))).get("userId")).toBe("u_1");
  });

  it("emits no Set-Cookie when nothing changed", async () => {
    const middleware = sessionMiddleware(storage());
    const response = await middleware(
      middlewareArgs({ request: new Request("https://example.com/") }),
      () => Promise.resolve(new Response("ok")),
    );
    expect(setCookies(response)).toHaveLength(0);
  });

  it("marks the response as varying on Cookie", async () => {
    const middleware = sessionMiddleware(storage());
    const response = await middleware(
      middlewareArgs({ request: new Request("https://example.com/") }),
      () => Promise.resolve(new Response("ok", { headers: { vary: "Accept-Language" } })),
    );
    expect(response.headers.get("vary")).toBe("Accept-Language, Cookie");
  });

  it("leaves a prerendered route's response cacheable", async () => {
    // `Vary: Cookie` on an ISG response makes it uncacheable for a dependency
    // a prerendered document does not have.
    const middleware = sessionMiddleware(storage());
    const response = await middleware(
      middlewareArgs({
        request: new Request("https://example.com/pricing"),
        route: { render: "isg" },
      }),
      () => Promise.resolve(new Response("ok")),
    );
    expect(response.headers.get("vary")).toBeNull();
  });

  it("preserves Set-Cookie headers the handler already set", async () => {
    const sessions = storage();
    const middleware = sessionMiddleware(sessions);
    const context = {} as Context;

    const response = await middleware(
      middlewareArgs({ request: new Request("https://example.com/"), context }),
      () => {
        context.session.set("userId", "u_1");
        return Promise.resolve(
          new Response("ok", { headers: { "set-cookie": "pracht_locale=nl; Path=/" } }),
        );
      },
    );

    const cookies = setCookies(response);
    expect(cookies).toHaveLength(2);
    expect(cookies.some((value) => value.startsWith("pracht_locale=nl"))).toBe(true);
    expect(cookies.some((value) => value.startsWith("session="))).toBe(true);
  });

  it("reconstructs a response whose headers are immutable", async () => {
    const sessions = storage();
    const middleware = sessionMiddleware(sessions);
    const context = {} as Context;

    const response = await middleware(
      middlewareArgs({ request: new Request("https://example.com/"), context }),
      () => {
        context.session.set("userId", "u_1");
        // `Response.redirect()` produces immutable headers.
        return Promise.resolve(Response.redirect("https://example.com/dashboard", 303));
      },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://example.com/dashboard");
    expect(setCookies(response)).toHaveLength(1);
  });

  it("does not attach a cookie to a 304", async () => {
    const sessions = storage();
    const middleware = sessionMiddleware(sessions);
    const context = {} as Context;

    const response = await middleware(
      middlewareArgs({ request: new Request("https://example.com/"), context }),
      () => {
        context.session.set("userId", "u_1");
        return Promise.resolve(new Response(null, { status: 304 }));
      },
    );
    expect(setCookies(response)).toHaveLength(0);
  });

  it("honours a custom context key", async () => {
    const sessions = storage();
    const middleware = sessionMiddleware(sessions, { contextKey: "auth" });
    const context: Record<string, unknown> = {};
    await middleware(
      middlewareArgs({ request: new Request("https://example.com/"), context }),
      () => Promise.resolve(new Response("ok")),
    );
    expect(context.auth).toBeDefined();
    expect(context.session).toBeUndefined();
  });

  it("works with a store, writing the record before the response leaves", async () => {
    const store = createMemorySessionStore();
    const sessions = createSessionStorage<AppSession>({
      cookie: { name: "session", secrets: [SECRET] },
      store,
    });
    const middleware = sessionMiddleware(sessions);
    const context = {} as Context;

    await middleware(
      middlewareArgs({ request: new Request("https://example.com/"), context }),
      () => {
        context.session.set("userId", "u_1");
        return Promise.resolve(new Response("ok"));
      },
    );

    expect(store.size()).toBe(1);
  });
});

describe("requireSession", () => {
  it("redirects an anonymous page request to the login page with a return path", async () => {
    const middleware = requireSession(storage());
    const response = await middleware(
      middlewareArgs({ request: new Request("https://example.com/dashboard?tab=1") }),
      () => Promise.resolve(new Response("should not run")),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login?redirect=%2Fdashboard%3Ftab%3D1");
  });

  it("answers an anonymous API request with 401 rather than a login page", async () => {
    const middleware = requireSession(storage());
    const response = await middleware(
      apiMiddlewareArgs({
        request: new Request("https://example.com/api/items", { method: "POST" }),
      }),
      () => Promise.resolve(new Response("should not run")),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("marks a redirect rejection as varying on Cookie", async () => {
    // Whether this URL answers with the page or with a redirect to /login is
    // decided by the Cookie header. A shared cache that stored the redirect
    // without varying on it would keep serving it to the user who just
    // logged in.
    const middleware = requireSession(storage());
    const response = await middleware(
      middlewareArgs({ request: new Request("https://example.com/dashboard") }),
      () => Promise.resolve(new Response("should not run")),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("vary")).toBe("Cookie");
  });

  it("marks a 401 rejection as varying on Cookie", async () => {
    const middleware = requireSession(storage());
    const response = await middleware(
      apiMiddlewareArgs({ request: new Request("https://example.com/api/items") }),
      () => Promise.resolve(new Response("should not run")),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("vary")).toBe("Cookie");
  });

  it("leaves a rejection on a prerendered route unvaried", async () => {
    const middleware = requireSession(storage());
    const response = await middleware(
      middlewareArgs({
        request: new Request("https://example.com/dashboard"),
        route: { render: "isg" },
      }),
      () => Promise.resolve(new Response("should not run")),
    );
    expect(response.headers.get("vary")).toBeNull();
  });

  it("does not hand an anonymous visitor a rolling empty session", async () => {
    const middleware = requireSession(storage());
    const response = await middleware(
      middlewareArgs({ request: new Request("https://example.com/dashboard") }),
      () => Promise.resolve(new Response("should not run")),
    );
    expect(setCookies(response)).toHaveLength(0);
  });

  it("lets an authenticated request through and still commits downstream writes", async () => {
    const sessions = storage();
    const seed = await sessions.getSession(null);
    seed.set("userId", "u_1");
    const cookie = toCookieHeader(await sessions.commitSession(seed));

    const middleware = requireSession(sessions);
    const context = {} as Context;
    const response = await middleware(
      middlewareArgs({
        request: new Request("https://example.com/dashboard", { headers: { cookie } }),
        context,
      }),
      () => {
        context.session.set("visits", 2);
        return Promise.resolve(new Response("dashboard"));
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("dashboard");
    const committed = await sessions.getSession(toCookieHeader(setCookies(response)[0]));
    expect(committed.get("visits")).toBe(2);
  });

  it("ignores a client-supplied identity header", async () => {
    // The pattern this package replaces trusted `x-user-id` written by an
    // earlier middleware. A client can send that header itself.
    const middleware = requireSession(storage());
    const response = await middleware(
      middlewareArgs({
        request: new Request("https://example.com/dashboard", {
          headers: { "x-user-id": "u_admin" },
        }),
      }),
      () => Promise.resolve(new Response("should not run")),
    );
    expect(response.status).toBe(302);
  });

  it("takes a custom authentication predicate and login path", async () => {
    const sessions = storage();
    const seed = await sessions.getSession(null);
    seed.set("userId", "u_1");
    const cookie = toCookieHeader(await sessions.commitSession(seed));

    const middleware = requireSession(sessions, {
      loginPath: "/sign-in",
      redirectParam: false,
      isAuthenticated: (session) => session.get("userId") === "u_admin",
    });

    const response = await middleware(
      middlewareArgs({
        request: new Request("https://example.com/admin", { headers: { cookie } }),
      }),
      () => Promise.resolve(new Response("should not run")),
    );
    expect(response.headers.get("location")).toBe("/sign-in");
  });

  it("takes a custom unauthorized response for API routes", async () => {
    const middleware = requireSession(storage(), {
      unauthorized: () => new Response("nope", { status: 403 }),
    });
    const response = await middleware(
      apiMiddlewareArgs({ request: new Request("https://example.com/api/items") }),
      () => Promise.resolve(new Response("should not run")),
    );
    expect(response.status).toBe(403);
  });
});
