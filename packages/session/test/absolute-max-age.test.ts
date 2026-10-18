/**
 * `absoluteMaxAge`: a hard cap on a session's lifetime. Without it a rolling
 * session lives as long as it keeps being used inside the idle window, so a
 * stolen cookie can be kept alive forever.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMemorySessionStore, createSessionStorage, sessionMiddleware } from "../src/index.ts";
import { cookieAttribute, middlewareArgs, SECRET, setCookies, toCookieHeader } from "./helpers.ts";

interface AppSession extends Record<string, unknown> {
  userId: string;
}

afterEach(() => {
  vi.useRealTimers();
});

function at(time: string): void {
  vi.setSystemTime(new Date(`2026-01-01T${time}Z`));
}

/** Use the session every 50s, inside the 60s idle window, until `until`. */
async function keepAlive(
  sessions: ReturnType<typeof createSessionStorage<AppSession>>,
  cookie: string,
  times: string[],
): Promise<string> {
  const middleware = sessionMiddleware(sessions);
  for (const time of times) {
    at(time);
    const response = await middleware(
      middlewareArgs({ request: new Request("https://example.com/", { headers: { cookie } }) }),
      () => Promise.resolve(new Response("ok")),
    );
    const refreshed = setCookies(response);
    if (refreshed.length > 0) cookie = toCookieHeader(refreshed[0]);
  }
  return cookie;
}

describe("absoluteMaxAge", () => {
  it("ends a rolling session at the cap however often it is used", async () => {
    vi.useFakeTimers();
    at("00:00:00");
    const sessions = createSessionStorage<AppSession>({
      cookie: { name: "session", secrets: [SECRET], maxAge: 60 },
      rolling: true,
      absoluteMaxAge: 120,
    });
    const seed = await sessions.getSession(null);
    seed.set("userId", "u_1");
    let cookie = toCookieHeader(await sessions.commitSession(seed));

    cookie = await keepAlive(sessions, cookie, ["00:00:50", "00:01:40"]);
    at("00:01:59");
    expect((await sessions.getSession(cookie)).get("userId")).toBe("u_1");
    at("00:02:00");
    expect((await sessions.getSession(cookie)).get("userId")).toBeUndefined();
  });

  it("without it, rolling keeps the session alive indefinitely", async () => {
    vi.useFakeTimers();
    at("00:00:00");
    const sessions = createSessionStorage<AppSession>({
      cookie: { name: "session", secrets: [SECRET], maxAge: 60 },
      rolling: true,
    });
    const seed = await sessions.getSession(null);
    seed.set("userId", "u_1");
    let cookie = toCookieHeader(await sessions.commitSession(seed));

    cookie = await keepAlive(sessions, cookie, ["00:00:50", "00:01:40", "00:02:30"]);
    at("00:03:00");
    expect((await sessions.getSession(cookie)).get("userId")).toBe("u_1");
  });

  it("caps the cookie Max-Age at the time left", async () => {
    vi.useFakeTimers();
    at("00:00:00");
    const sessions = createSessionStorage<AppSession>({
      cookie: { name: "session", secrets: [SECRET], maxAge: 3600 },
      absoluteMaxAge: 600,
    });
    const seed = await sessions.getSession(null);
    seed.set("userId", "u_1");
    const first = await sessions.commitSession(seed);
    expect(cookieAttribute(first, "Max-Age")).toBe("600");

    at("00:04:00");
    const session = await sessions.getSession(toCookieHeader(first));
    session.set("userId", "u_2");
    expect(cookieAttribute(await sessions.commitSession(session), "Max-Age")).toBe("360");
  });

  it("restarts the cap on regenerate()", async () => {
    vi.useFakeTimers();
    at("00:00:00");
    const sessions = createSessionStorage<AppSession>({
      cookie: { name: "session", secrets: [SECRET], maxAge: 3600 },
      absoluteMaxAge: 600,
      store: createMemorySessionStore(),
    });
    const anonymous = await sessions.getSession(null);
    anonymous.set("userId", "pending");
    const before = toCookieHeader(await sessions.commitSession(anonymous));

    at("00:09:00");
    const login = await sessions.getSession(before);
    await login.regenerate();
    login.set("userId", "u_1");
    const after = toCookieHeader(await sessions.commitSession(login));

    at("00:15:00");
    expect((await sessions.getSession(after)).get("userId")).toBe("u_1");
    at("00:19:00");
    expect((await sessions.getSession(after)).get("userId")).toBeUndefined();
  });

  it("counts a cookie sealed before it was configured from its last commit", async () => {
    vi.useFakeTimers();
    at("00:00:00");
    const before = createSessionStorage<AppSession>({
      cookie: { name: "session", secrets: [SECRET], maxAge: 3600 },
    });
    const seed = await before.getSession(null);
    seed.set("userId", "u_1");
    const legacy = toCookieHeader(await before.commitSession(seed));

    const after = createSessionStorage<AppSession>({
      cookie: { name: "session", secrets: [SECRET], maxAge: 3600 },
      rolling: true,
      absoluteMaxAge: 120,
    });
    // Still inside the cap counted from the legacy cookie's commit.
    await keepAlive(after, legacy, ["00:00:10"]);
    at("00:01:59");
    expect((await after.getSession(legacy)).get("userId")).toBe("u_1");
    // Replaying the original cookie cannot restart the cap.
    const refreshed = await keepAlive(after, legacy, ["00:01:59"]);
    at("00:02:00");
    expect((await after.getSession(legacy)).get("userId")).toBeUndefined();
    expect((await after.getSession(refreshed)).get("userId")).toBeUndefined();
  });

  it("ends the session when the cap runs out during the request", async () => {
    vi.useFakeTimers();
    at("00:00:00");
    const sessions = createSessionStorage<AppSession>({
      cookie: { name: "session", secrets: [SECRET], maxAge: 3600 },
      absoluteMaxAge: 60,
      store: createMemorySessionStore(),
    });
    const seed = await sessions.getSession(null);
    seed.set("userId", "u_1");
    const cookie = toCookieHeader(await sessions.commitSession(seed));

    at("00:00:59");
    const session = await sessions.getSession(cookie);
    expect(session.get("userId")).toBe("u_1");
    at("00:01:00");
    session.set("userId", "u_2");
    const header = await sessions.commitSession(session);
    expect(cookieAttribute(header, "Max-Age")).toBe("0");
    expect((await sessions.getSession(cookie)).get("userId")).toBeUndefined();
  });

  it("rejects a non-positive or fractional cap", () => {
    for (const absoluteMaxAge of [0, -1, 1.5]) {
      expect(() =>
        createSessionStorage({ cookie: { name: "session", secrets: [SECRET] }, absoluteMaxAge }),
      ).toThrow(/absoluteMaxAge/);
    }
  });
});
