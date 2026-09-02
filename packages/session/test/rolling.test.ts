/**
 * The expiry model.
 *
 * By default the lifetime is absolute from the last *write*: a request that
 * only reads emits no `Set-Cookie`, so an idle-but-browsing user is logged out
 * when `maxAge` elapses since their last change. `rolling: true` re-commits on
 * every request, turning `maxAge` into an idle timeout instead.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMemorySessionStore, createSessionStorage, sessionMiddleware } from "../src/index.ts";
import { middlewareArgs, SECRET, setCookies, toCookieHeader } from "./helpers.ts";

interface AppSession extends Record<string, unknown> {
  userId: string;
}

function storage(rolling: boolean) {
  return createSessionStorage<AppSession>({
    cookie: { name: "session", secrets: [SECRET], maxAge: 60 },
    rolling,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("absolute expiry (default)", () => {
  it("does not re-commit a session that was only read", async () => {
    const sessions = storage(false);
    const seed = await sessions.getSession(null);
    seed.set("userId", "u_1");
    const cookie = toCookieHeader(await sessions.commitSession(seed));

    const middleware = sessionMiddleware(sessions);
    const response = await middleware(
      middlewareArgs({ request: new Request("https://example.com/", { headers: { cookie } }) }),
      () => Promise.resolve(new Response("ok")),
    );
    expect(setCookies(response)).toHaveLength(0);
  });

  it("expires `maxAge` after the last write, however active the user is", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const sessions = storage(false);
    const seed = await sessions.getSession(null);
    seed.set("userId", "u_1");
    const cookie = toCookieHeader(await sessions.commitSession(seed));

    const middleware = sessionMiddleware(sessions);
    // Read-only traffic every 30s. None of it refreshes the cookie.
    for (const at of ["00:00:30", "00:00:59"]) {
      vi.setSystemTime(new Date(`2026-01-01T${at}Z`));
      const response = await middleware(
        middlewareArgs({ request: new Request("https://example.com/", { headers: { cookie } }) }),
        () => Promise.resolve(new Response("ok")),
      );
      expect(setCookies(response)).toHaveLength(0);
    }

    vi.setSystemTime(new Date("2026-01-01T00:01:01Z"));
    expect((await sessions.getSession(cookie)).get("userId")).toBeUndefined();
  });
});

describe("rolling: true", () => {
  it("re-commits an existing session on a read-only request", async () => {
    const sessions = storage(true);
    const seed = await sessions.getSession(null);
    seed.set("userId", "u_1");
    const cookie = toCookieHeader(await sessions.commitSession(seed));

    const middleware = sessionMiddleware(sessions);
    const response = await middleware(
      middlewareArgs({ request: new Request("https://example.com/", { headers: { cookie } }) }),
      () => Promise.resolve(new Response("ok")),
    );
    expect(setCookies(response)).toHaveLength(1);
  });

  it("turns maxAge into an idle timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const sessions = storage(true);
    const seed = await sessions.getSession(null);
    seed.set("userId", "u_1");
    let cookie = toCookieHeader(await sessions.commitSession(seed));

    const middleware = sessionMiddleware(sessions);
    // Keep browsing past the original absolute deadline.
    for (const at of ["00:00:30", "00:01:00", "00:01:30"]) {
      vi.setSystemTime(new Date(`2026-01-01T${at}Z`));
      const response = await middleware(
        middlewareArgs({ request: new Request("https://example.com/", { headers: { cookie } }) }),
        () => Promise.resolve(new Response("ok")),
      );
      cookie = toCookieHeader(setCookies(response)[0]);
    }

    vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
    expect((await sessions.getSession(cookie)).get("userId")).toBe("u_1");

    // Then go idle for longer than maxAge.
    vi.setSystemTime(new Date("2026-01-01T00:02:40Z"));
    expect((await sessions.getSession(cookie)).get("userId")).toBeUndefined();
  });

  it("still gives an anonymous visitor no cookie at all", async () => {
    // The cost of rolling must not be "every crawler gets a session".
    const sessions = storage(true);
    const middleware = sessionMiddleware(sessions);
    const response = await middleware(
      middlewareArgs({ request: new Request("https://example.com/") }),
      () => Promise.resolve(new Response("ok")),
    );
    expect(setCookies(response)).toHaveLength(0);
  });

  it("does not resurrect a destroyed session", async () => {
    const sessions = storage(true);
    const seed = await sessions.getSession(null);
    seed.set("userId", "u_1");
    const cookie = toCookieHeader(await sessions.commitSession(seed));

    const session = await sessions.getSession(cookie);
    const expired = await sessions.destroySession(session);
    expect(expired).toContain("Max-Age=0");
    expect(sessions.isDirty(session)).toBe(false);
  });

  it("writes to the store on every request", async () => {
    const store = createMemorySessionStore();
    const writes: string[] = [];
    const sessions = createSessionStorage<AppSession>({
      cookie: { name: "session", secrets: [SECRET], maxAge: 60 },
      rolling: true,
      store: {
        get: (id) => store.get(id),
        set: (id, data, expiresAt) => {
          writes.push(id);
          return store.set(id, data, expiresAt);
        },
        delete: (id) => store.delete(id),
      },
    });

    const seed = await sessions.getSession(null);
    seed.set("userId", "u_1");
    const cookie = toCookieHeader(await sessions.commitSession(seed));
    expect(writes).toHaveLength(1);

    const middleware = sessionMiddleware(sessions);
    await middleware(
      middlewareArgs({ request: new Request("https://example.com/", { headers: { cookie } }) }),
      () => Promise.resolve(new Response("ok")),
    );
    // The documented cost of `rolling` with a store: one write per request.
    expect(writes).toHaveLength(2);
  });
});
