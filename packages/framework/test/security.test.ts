import { describe, expect, it, vi } from "vitest";

import {
  buildPathFromSegments,
  defineApp,
  handlePrachtRequest,
  resolveApiRoutes,
  resolveApp,
  route,
} from "../src/index.ts";
import { applyHeaders, assertSafeHeaderValue } from "../src/runtime-headers.ts";
import { buildRedirectResponse } from "../src/runtime-middleware.ts";
import { shouldExposeServerErrors } from "../src/runtime-errors.ts";

describe("buildRedirectResponse", () => {
  const baseUrl = "http://localhost/page";

  it("rejects javascript: redirect targets", () => {
    expect(() => buildRedirectResponse("javascript:alert(1)", { baseUrl, method: "GET" })).toThrow(
      /unsafe redirect/i,
    );
  });

  it("rejects data: redirect targets", () => {
    expect(() =>
      buildRedirectResponse("data:text/html,<script>alert(1)</script>", {
        baseUrl,
        method: "GET",
      }),
    ).toThrow(/unsafe redirect/i);
  });

  it("rejects CR/LF in the redirect target", () => {
    expect(() =>
      buildRedirectResponse("/safe\r\nSet-Cookie: admin=1", { baseUrl, method: "GET" }),
    ).toThrow(/CR\/LF/);
  });

  it("preserves the original relative form in Location", () => {
    const response = buildRedirectResponse("/login?next=/home", {
      baseUrl,
      method: "GET",
    });
    expect(response.headers.get("location")).toBe("/login?next=/home");
  });

  it("defaults to 303 for non-safe methods", () => {
    const response = buildRedirectResponse("/login", { baseUrl, method: "POST" });
    expect(response.status).toBe(303);
  });

  it("defaults to 302 for GET", () => {
    const response = buildRedirectResponse("/login", { baseUrl, method: "GET" });
    expect(response.status).toBe(302);
  });

  it("honors explicit status override", () => {
    const response = buildRedirectResponse("/login", {
      baseUrl,
      method: "POST",
      status: 307,
    });
    expect(response.status).toBe(307);
  });
});

describe("middleware redirect integration", () => {
  it("rejects javascript: returned from middleware", async () => {
    const app = defineApp({
      middleware: { auth: "./middleware/auth.ts" },
      routes: [route("/dashboard", "./routes/dashboard.tsx", { middleware: ["auth"] })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        middlewareModules: {
          "./middleware/auth.ts": async () => ({
            middleware: async () => ({ redirect: "javascript:alert(1)" }),
          }),
        },
        routeModules: {
          "./routes/dashboard.tsx": async () => ({ Component: () => null }),
        },
      },
      request: new Request("http://localhost/dashboard"),
    });

    // Framework responds with 500 (route error) rather than honoring the
    // unsafe scheme.
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("applyHeaders / assertSafeHeaderValue", () => {
  it("rejects values with CR or LF", () => {
    expect(() => assertSafeHeaderValue("x-foo", "safe\r\nInjected: 1")).toThrow(/CR or LF/);
    expect(() => assertSafeHeaderValue("x-foo", "safe\nInjected: 1")).toThrow(/CR or LF/);
  });

  it("applyHeaders rejects CRLF-bearing values", () => {
    const headers = new Headers();
    expect(() => applyHeaders(headers, { "x-foo": "line1\r\nline2" })).toThrow(/CR or LF/);
  });

  it("applyHeaders accepts normal values", () => {
    const headers = new Headers();
    applyHeaders(headers, { "x-foo": "bar" });
    expect(headers.get("x-foo")).toBe("bar");
  });
});

describe("buildPathFromSegments catch-all encoding", () => {
  const app = defineApp({
    routes: [route("/docs/*", "./routes/docs.tsx")],
  });
  const resolved = resolveApp(app);
  const catchAllRoute = resolved.routes.find((r) => r.path === "/docs/*")!;

  it("encodes traversal sequences in catch-all params", () => {
    const result = buildPathFromSegments(catchAllRoute.segments, {
      "*": "../../etc/passwd",
    });
    // Each `..` and separator becomes percent-encoded, so path.join cannot
    // resolve the result back up the tree.
    expect(result).not.toContain("..");
    expect(result).toContain("%2E%2E");
  });

  it("encodes backslashes and NUL bytes in catch-all", () => {
    const result = buildPathFromSegments(catchAllRoute.segments, {
      "*": "foo\\..\\bar\0",
    });
    expect(result).not.toMatch(/\\/);
    expect(result).not.toContain("\u0000");
  });

  it("preserves forward slashes between catch-all components", () => {
    const result = buildPathFromSegments(catchAllRoute.segments, {
      "*": "guides/deep/topic",
    });
    expect(result).toBe("/docs/guides/deep/topic");
  });
});

describe("_data=1 route-state bypass is gated by Sec-Fetch-Site", () => {
  const app = defineApp({
    routes: [route("/", "./routes/home.tsx")],
  });
  const registry = {
    routeModules: {
      "./routes/home.tsx": async () => ({
        Component: () => null,
        loader: async () => ({ secret: "top-secret" }),
      }),
    },
  };

  it("serves HTML (not JSON) when _data=1 comes from a cross-site navigation", async () => {
    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/?_data=1", {
        headers: { "sec-fetch-site": "cross-site" },
      }),
    });

    expect(response.headers.get("content-type") ?? "").toContain("text/html");
  });

  it("honors _data=1 when Sec-Fetch-Site is same-origin", async () => {
    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/?_data=1", {
        headers: { "sec-fetch-site": "same-origin" },
      }),
    });

    expect(response.headers.get("content-type") ?? "").toContain("application/json");
  });

  it("honors _data=1 when Origin matches and Sec-Fetch-Site is absent", async () => {
    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/?_data=1", {
        headers: { origin: "http://localhost" },
      }),
    });

    expect(response.headers.get("content-type") ?? "").toContain("application/json");
  });

  it("always honors the explicit route-state header", async () => {
    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
  });
});

describe("API CSRF / same-origin enforcement", () => {
  const app = defineApp({
    routes: [route("/", "./routes/home.tsx")],
  });
  const apiRoutes = resolveApiRoutes(["/src/api/delete.ts"]);
  const registry = {
    apiModules: {
      "/src/api/delete.ts": async () => ({
        POST: async () => new Response("deleted", { status: 200 }),
      }),
    },
  };

  it("blocks a POST with Sec-Fetch-Site: cross-site", async () => {
    const response = await handlePrachtRequest({
      app,
      apiRoutes,
      registry,
      request: new Request("http://localhost/api/delete", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      }),
    });

    expect(response.status).toBe(403);
  });

  it("blocks a POST whose Origin mismatches the request URL", async () => {
    const response = await handlePrachtRequest({
      app,
      apiRoutes,
      registry,
      request: new Request("http://localhost/api/delete", {
        method: "POST",
        headers: { origin: "https://evil.example" },
      }),
    });

    expect(response.status).toBe(403);
  });

  it("allows a POST with same-origin Sec-Fetch-Site", async () => {
    const response = await handlePrachtRequest({
      app,
      apiRoutes,
      registry,
      request: new Request("http://localhost/api/delete", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      }),
    });

    expect(response.status).toBe(200);
  });

  it("allows a POST with matching Origin header", async () => {
    const response = await handlePrachtRequest({
      app,
      apiRoutes,
      registry,
      request: new Request("http://localhost/api/delete", {
        method: "POST",
        headers: { origin: "http://localhost" },
      }),
    });

    expect(response.status).toBe(200);
  });

  it("allows a POST from non-browser callers (no Origin / Sec-Fetch-Site / Referer)", async () => {
    const response = await handlePrachtRequest({
      app,
      apiRoutes,
      registry,
      request: new Request("http://localhost/api/delete", { method: "POST" }),
    });

    expect(response.status).toBe(200);
  });

  it("can be opted out via api.requireSameOrigin: false", async () => {
    const openApp = defineApp({
      api: { requireSameOrigin: false },
      routes: [route("/", "./routes/home.tsx")],
    });

    const response = await handlePrachtRequest({
      app: openApp,
      apiRoutes,
      registry,
      request: new Request("http://localhost/api/delete", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      }),
    });

    expect(response.status).toBe(200);
  });
});

describe("shouldExposeServerErrors in production", () => {
  it("returns false when NODE_ENV=production even if debugErrors is true", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(shouldExposeServerErrors({ debugErrors: true })).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      if (originalEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalEnv;
      warn.mockRestore();
    }
  });

  it("honors debugErrors outside production", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      expect(shouldExposeServerErrors({ debugErrors: true })).toBe(true);
    } finally {
      if (originalEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalEnv;
    }
  });
});
