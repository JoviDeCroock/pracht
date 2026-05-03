import { describe, expect, it } from "vitest";

import { shouldBypassDevSSR } from "../src/plugin-dev-ssr.ts";

const routeMatchers = {
  app: {} as any,
  apiRoutes: [] as any[],
  matchApiRoute: () => undefined,
  matchAppRoute: (_app: unknown, pathname: string) =>
    new Set(["/blog/release-1.2.3", "/blog/openapi.json", "/@alice"]).has(pathname)
      ? ({ pathname } as const)
      : undefined,
};

describe("shouldBypassDevSSR", () => {
  it("keeps dotted document routes inside framework handling", () => {
    expect(
      shouldBypassDevSSR(
        "/blog/release-1.2.3",
        {
          headers: { accept: "text/html,application/xhtml+xml" },
          method: "GET",
        },
        routeMatchers,
      ),
    ).toBe(false);

    expect(
      shouldBypassDevSSR(
        "/blog/openapi.json",
        {
          headers: { accept: "text/html,application/xhtml+xml" },
          method: "GET",
        },
        routeMatchers,
      ),
    ).toBe(false);

    expect(
      shouldBypassDevSSR(
        "/@alice",
        {
          headers: { accept: "text/html,application/xhtml+xml" },
          method: "GET",
        },
        routeMatchers,
      ),
    ).toBe(false);
  });

  it("keeps route-state requests inside framework handling even for dotted slugs", () => {
    expect(
      shouldBypassDevSSR("/api/health", {
        headers: { accept: "application/json" },
        method: "GET",
      }),
    ).toBe(false);

    expect(
      shouldBypassDevSSR(
        "/blog/openapi.json?_data=1",
        {
          headers: { accept: "*/*" },
          method: "GET",
        },
        routeMatchers,
      ),
    ).toBe(false);

    expect(
      shouldBypassDevSSR(
        "/blog/release-1.2.3",
        {
          headers: {
            accept: "application/json",
            "x-pracht-route-state-request": "1",
          },
          method: "GET",
        },
        routeMatchers,
      ),
    ).toBe(false);
  });

  it("bypasses reserved vite internals and explicit asset fetches", () => {
    expect(
      shouldBypassDevSSR("/@vite/client", {
        headers: { accept: "*/*" },
        method: "GET",
      }),
    ).toBe(true);

    expect(
      shouldBypassDevSSR("/@id/preact", {
        headers: { accept: "*/*" },
        method: "GET",
      }),
    ).toBe(true);

    expect(
      shouldBypassDevSSR("/assets/app.js", {
        headers: { accept: "*/*", "sec-fetch-dest": "script" },
        method: "GET",
      }),
    ).toBe(true);

    expect(
      shouldBypassDevSSR("/logo.svg", {
        headers: { accept: "image/avif,image/webp,*/*", "sec-fetch-dest": "image" },
        method: "GET",
      }),
    ).toBe(true);
  });

  it("still treats unmatched HTML navigations as document requests", () => {
    expect(
      shouldBypassDevSSR("/unknown/file.json", {
        headers: { accept: "text/html,application/xhtml+xml" },
        method: "GET",
      }),
    ).toBe(false);

    expect(
      shouldBypassDevSSR("/", {
        headers: { accept: "*/*" },
        method: "GET",
      }),
    ).toBe(false);
  });
});
