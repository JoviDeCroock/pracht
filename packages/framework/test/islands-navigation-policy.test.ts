import { h } from "preact";
import { describe, expect, it, vi } from "vitest";

// `pracht({ client: { islandsNavigation: true } })` sets this define in both
// bundles. Hoisted above the imports: the runtime reads it once, at load.
vi.hoisted(() => {
  (globalThis as { __PRACHT_ISLANDS_NAVIGATION__?: boolean }).__PRACHT_ISLANDS_NAVIGATION__ = true;
});

import { defineApp, handlePrachtRequest, redirect, route } from "../src/index.ts";
import { policyFingerprint } from "../src/islands-shared.ts";
import type { MiddlewareFn } from "../src/types.ts";

const STRICT = "script-src 'self'";

async function render(middleware?: MiddlewareFn) {
  const app = defineApp({
    middleware: middleware ? { rewrite: "./middleware/rewrite.ts" } : {},
    routes: [
      route("/", "./routes/page.tsx", {
        hydration: "islands",
        middleware: middleware ? ["rewrite"] : [],
      }),
    ],
  });
  const response = await handlePrachtRequest({
    app,
    registry: {
      routeModules: {
        "./routes/page.tsx": async () => ({
          Component: () => h("h1", null, "Page"),
          headers: () => ({ "content-security-policy": STRICT }),
        }),
      },
      middlewareModules: middleware
        ? { "./middleware/rewrite.ts": async () => ({ middleware }) }
        : undefined,
    },
    request: new Request("http://localhost/"),
    islandsEntryUrl: "/assets/islands-client.js",
  });
  const html = await response.text();
  const json = /<script[^>]*id="pracht-nav">([^<]*)<\/script>/.exec(html)?.[1];
  return { response, html, data: json ? (JSON.parse(json) as { p?: string }) : undefined };
}

describe("islands navigation policy", () => {
  it("states the policy of the headers the document is sent with", async () => {
    const { response, data } = await render();
    expect(response.headers.get("content-security-policy")).toBe(STRICT);
    expect(data?.p).toBe(policyFingerprint(response.headers));
  });

  it("states the policy middleware changed after the render", async () => {
    const strict = await render();
    const loosened = await render(async (_args, next) => {
      const response = await next();
      response.headers.set("content-security-policy", "script-src * 'unsafe-inline'");
      return response;
    });
    expect(loosened.response.headers.get("content-security-policy")).toBe(
      "script-src * 'unsafe-inline'",
    );
    expect(loosened.data?.p).toBe(policyFingerprint(loosened.response.headers));
    expect(loosened.data?.p).not.toBe(strict.data?.p);
    expect(loosened.html).toContain("<h1>Page</h1>");
  });

  it("follows middleware that re-wraps the response", async () => {
    const { response, data } = await render(async (_args, next) => {
      const original = await next();
      const headers = new Headers(original.headers);
      headers.set("permissions-policy", "camera=*");
      return new Response(original.body, { status: original.status, headers });
    });
    expect(data?.p).toBe(policyFingerprint(response.headers));
  });

  it("drops navigation data when middleware adds a nonce", async () => {
    const { html } = await render(async (_args, next) => {
      const response = await next();
      response.headers.set("content-security-policy", "script-src 'nonce-abc'");
      return response;
    });
    expect(html).not.toContain('id="pracht-nav"');
    expect(html).toContain("<h1>Page</h1>");
  });
});

describe("islands navigation redirects", () => {
  async function fetchPage(path: string, headers: Record<string, string>) {
    const app = defineApp({
      routes: [
        route("/login", "./routes/login.tsx", { hydration: "islands" }),
        route("/", "./routes/page.tsx", { hydration: "islands" }),
      ],
    });
    return handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/login.tsx": async () => ({
            loader: () => redirect("https://sso.example/authorize?state=1"),
            Component: () => null,
          }),
          "./routes/page.tsx": async () => ({ Component: () => h("h1", null, "Page") }),
        },
      },
      request: new Request(`http://localhost${path}`, { headers }),
      islandsEntryUrl: "/assets/islands-client.js",
    });
  }

  it("names a page redirect's target to the islands bootstrap instead of redirecting", async () => {
    const response = await fetchPage("/login", { "x-pracht-capability-form": "1" });
    expect(response.status).toBe(204);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-pracht-capability-redirect")).toBe(
      "https://sso.example/authorize?state=1",
    );
  });

  it("redirects a browser's own request as usual", async () => {
    const response = await fetchPage("/login", {});
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://sso.example/authorize?state=1");
  });
});
