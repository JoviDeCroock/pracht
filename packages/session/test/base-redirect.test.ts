/**
 * Under a deploy base, the login round trip has to land back on the page the
 * visitor asked for: `requireSession` writes the return path, the login
 * handler passes it to core's `redirect()`, and `redirect()` adds the base.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { SECRET } from "./helpers.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadUnderBase(base: string) {
  vi.resetModules();
  vi.stubEnv("BASE_URL", base);
  const core = await import("@pracht/core");
  const session = await import("../src/index.ts");
  const { middlewareArgs } = await import("./helpers.ts");
  return { core, session, middlewareArgs };
}

/** The documented login handler's gate (add-auth skill, auth recipe). */
function safeRedirectPath(value: unknown, base: URL, fallback: string): string {
  if (typeof value !== "string" || !value.startsWith("/")) return fallback;
  try {
    const target = new URL(value, base);
    return target.origin === base.origin
      ? `${target.pathname}${target.search}${target.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}

describe("requireSession under a deploy base", () => {
  it("writes a base-free return path that the login handler's redirect() lands on", async () => {
    const { core, session, middlewareArgs } = await loadUnderBase("/my-project/");
    const storage = session.createSessionStorage({
      cookie: { name: "session", secrets: [SECRET] },
    });
    const middleware = session.requireSession(storage);

    const gated = await middleware(
      middlewareArgs({ request: new Request("https://example.com/my-project/dashboard?tab=1") }),
      () => Promise.resolve(new Response("should not run")),
    );

    expect(gated.status).toBe(302);
    expect(gated.headers.get("location")).toBe("/my-project/login?redirect=%2Fdashboard%3Ftab%3D1");

    const loginUrl = new URL(gated.headers.get("location")!, "https://example.com");
    const target = safeRedirectPath(loginUrl.searchParams.get("redirect"), loginUrl, "/");
    const afterLogin = core.redirect(target);
    expect(afterLogin.headers.get("location")).toBe("/my-project/dashboard?tab=1");
  });

  it("never writes a protocol-relative return path", async () => {
    const { session, middlewareArgs } = await loadUnderBase("/my-project/");
    const storage = session.createSessionStorage({
      cookie: { name: "session", secrets: [SECRET] },
    });
    const middleware = session.requireSession(storage);

    const gated = await middleware(
      middlewareArgs({
        request: new Request("https://example.com/my-project//evil.example/path"),
      }),
      () => Promise.resolve(new Response("should not run")),
    );

    const loginUrl = new URL(gated.headers.get("location")!, "https://example.com");
    expect(loginUrl.searchParams.get("redirect")).toBe("/evil.example/path");
  });

  it("keeps the full path when the request is outside the base", async () => {
    const { session, middlewareArgs } = await loadUnderBase("/my-project/");
    const storage = session.createSessionStorage({
      cookie: { name: "session", secrets: [SECRET] },
    });
    const middleware = session.requireSession(storage);

    const gated = await middleware(
      middlewareArgs({ request: new Request("https://example.com/dashboard") }),
      () => Promise.resolve(new Response("should not run")),
    );

    expect(gated.headers.get("location")).toBe("/my-project/login?redirect=%2Fdashboard");
  });
});
