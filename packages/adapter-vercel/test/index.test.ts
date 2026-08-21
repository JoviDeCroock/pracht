import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defineApp,
  resolveApiRoutes,
  route,
  timeRevalidate,
  webhookRevalidate,
} from "@pracht/core";

import {
  createVercelEdgeHandler,
  createVercelNodeListener,
  createVercelServerEntryModule,
} from "../src/index.ts";

describe("createVercelServerEntryModule", () => {
  it("imports an app createContext module when configured", () => {
    const source = createVercelServerEntryModule({
      createContextFrom: "/src/server/context.ts",
      functionName: "app",
      regions: ["iad1"],
    });

    expect(source).toContain(
      'import { createContext as createPrachtContext } from "/src/server/context.ts";',
    );
    expect(source).toContain("createContext: createPrachtContext");
    expect(source).toContain("createVercelEdgeHandler");
    expect(source).toContain("islandsEntryUrl: islandsEntryUrl ?? undefined");
    expect(source).toContain("islandsBootstrapRequired");
    expect(source).toContain('export const vercelFunctionName = "app";');
  });
});

describe("createVercelEdgeHandler under a deploy base", () => {
  it("redirects the bare base before creating application context", async () => {
    vi.stubEnv("BASE_URL", "/app/");
    vi.resetModules();
    const { createVercelEdgeHandler: createBaseHandler } = await import("../src/index.ts");
    const createContext = vi.fn(() => ({}));
    const handler = createBaseHandler({
      app: defineApp({ routes: [] }),
      createContext,
    });

    const response = await handler(new Request("https://example.com/app?ref=campaign"), {});

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/app/?ref=campaign");
    expect(createContext).not.toHaveBeenCalled();
  });
});

describe("createVercelNodeListener", () => {
  it("provides waitUntil and drains registered work", async () => {
    let releaseTask: (() => void) | undefined;
    const backgroundTask = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    let receivedWaitUntil = false;
    let listenerSettled = false;
    const chunks: Uint8Array[] = [];
    const listener = createVercelNodeListener(async (_request, context) => {
      receivedWaitUntil = typeof context.waitUntil === "function";
      context.waitUntil?.(backgroundTask);
      return new Response("ok");
    });

    const invocation = listener(
      {
        headers: { host: "example.com" },
        method: "GET",
        url: "/pricing",
      },
      {
        statusCode: 0,
        setHeader() {},
        write(chunk) {
          chunks.push(chunk);
        },
        end() {},
      },
    ).then(() => {
      listenerSettled = true;
    });

    await vi.waitFor(() => expect(receivedWaitUntil).toBe(true));
    expect(listenerSettled).toBe(false);
    releaseTask?.();
    await invocation;

    expect(listenerSettled).toBe(true);
    expect(new TextDecoder().decode(chunks[0])).toBe("ok");
  });

  function invokeListener(
    handler: (request: Request) => Promise<Response> | Response,
    req: {
      headers: Record<string, string | string[] | undefined>;
      method?: string;
      url?: string;
    },
  ): Promise<{ body: string; headers: Record<string, string | string[]> }> {
    const listener = createVercelNodeListener(async (request) => handler(request));
    const chunks: Uint8Array[] = [];
    const headers: Record<string, string | string[]> = {};

    return listener(req, {
      statusCode: 0,
      setHeader(name, value) {
        headers[name] = value;
      },
      write(chunk) {
        chunks.push(chunk);
      },
      end() {},
    }).then(() => ({
      body: chunks.map((chunk) => new TextDecoder().decode(chunk)).join(""),
      headers,
    }));
  }

  it("renders ISG output on a sanitized request instead of the visitor's", async () => {
    let seen: Request | undefined;
    await invokeListener(
      (request) => {
        seen = request;
        return new Response("ok");
      },
      {
        headers: {
          authorization: "Bearer visitor-token",
          cookie: "session=visitor-session",
          host: "example.com",
          "x-forwarded-proto": "https",
        },
        method: "POST",
        url: "/pricing?utm_source=email",
      },
    );

    // Vercel keys the prerender cache on the path alone, so nothing
    // request-specific may reach the render.
    expect(seen?.url).toBe("https://example.com/pricing");
    expect(seen?.method).toBe("GET");
    expect(seen?.headers.get("cookie")).toBeNull();
    expect(seen?.headers.get("authorization")).toBeNull();
    expect(Object.fromEntries(seen?.headers ?? new Headers())).toEqual({
      accept: "text/html",
    });
  });

  it("strips credential headers before Vercel caches the response", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { body, headers } = await invokeListener(
      () =>
        new Response("<html>ok</html>", {
          headers: {
            "content-type": "text/html",
            "set-cookie": "session=leaked; Path=/",
            "x-api-key": "secret",
          },
        }),
      { headers: { host: "example.com" }, url: "/pricing" },
    );

    expect(body).toBe("<html>ok</html>");
    expect(headers["set-cookie"]).toBeUndefined();
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["content-type"]).toBe("text/html");
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('"set-cookie"'));

    consoleError.mockRestore();
  });

  it("warns when an ISG response marks itself uncacheable", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await invokeListener(
      () => new Response("<html>ok</html>", { headers: { "cache-control": "private" } }),
      { headers: { host: "example.com" }, url: "/pricing" },
    );

    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("uncacheable"));

    consoleWarn.mockRestore();
  });
});

describe("createVercelEdgeHandler webhook revalidation", () => {
  const app = defineApp({
    routes: [
      route("/pricing", "./routes/pricing.tsx", {
        render: "isg",
        revalidate: [timeRevalidate(3600), webhookRevalidate()],
      }),
      route("/time-only", "./routes/time-only.tsx", {
        render: "isg",
        revalidate: timeRevalidate(3600),
      }),
    ],
  });

  function createWebhookRequest(paths: string[], token?: string): Request {
    return new Request("https://app.example/__pracht/revalidate", {
      body: JSON.stringify({ paths }),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      method: "POST",
    });
  }

  const previousToken = process.env.PRACHT_REVALIDATE_TOKEN;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    if (previousToken === undefined) {
      delete process.env.PRACHT_REVALIDATE_TOKEN;
    } else {
      process.env.PRACHT_REVALIDATE_TOKEN = previousToken;
    }
  });

  it("matches and regenerates webhook paths beneath the deploy base", async () => {
    vi.stubEnv("BASE_URL", "/app/");
    vi.resetModules();
    const { createVercelEdgeHandler: createBaseHandler } = await import("../src/index.ts");
    process.env.PRACHT_REVALIDATE_TOKEN = "secret";
    const revalidateFetch = vi.fn(
      async () =>
        new Response("<html>ok</html>", {
          headers: { "x-vercel-cache": "MISS" },
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", revalidateFetch);

    const handler = createBaseHandler({ app });
    const response = await handler(
      new Request("https://app.example/app/__pracht/revalidate", {
        body: JSON.stringify({ paths: ["/pricing"] }),
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        method: "POST",
      }),
      {},
    );

    expect(response.status).toBe(200);
    expect(revalidateFetch).toHaveBeenCalledWith(
      new URL("https://app.example/app/pricing"),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-prerender-revalidate": "secret" }),
      }),
    );
  });

  it("fails closed without a configured token and rejects wrong tokens", async () => {
    const handler = createVercelEdgeHandler({ app });

    delete process.env.PRACHT_REVALIDATE_TOKEN;
    const missing = await handler(createWebhookRequest(["/pricing"], "secret"), {});
    expect(missing.status).toBe(401);

    process.env.PRACHT_REVALIDATE_TOKEN = "secret";
    const wrong = await handler(createWebhookRequest(["/pricing"], "wrong"), {});
    expect(wrong.status).toBe(401);
  });

  it("regenerates opted-in paths through the prerender bypass token", async () => {
    process.env.PRACHT_REVALIDATE_TOKEN = "secret";
    const revalidateFetches: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        revalidateFetches.push({
          url: String(input),
          headers: Object.fromEntries(new Headers(init?.headers)),
        });
        return new Response("<html>ok</html>", {
          headers: { "x-vercel-cache": "MISS" },
          status: 200,
        });
      }),
    );

    const handler = createVercelEdgeHandler({ app });
    const response = await handler(
      createWebhookRequest(["/pricing", "/time-only", "/unknown"], "secret"),
      {},
    );

    expect(response.status).toBe(200);
    // `details` names *why* each path was skipped: the legacy arrays alone made
    // a route without a webhook policy indistinguishable from a typo.
    await expect(response.json()).resolves.toEqual({
      details: [
        { outcome: "revalidated", path: "/pricing" },
        { outcome: "skipped", path: "/time-only", reason: "no_webhook_policy" },
        { outcome: "skipped", path: "/unknown", reason: "not_a_route" },
      ],
      failed: [],
      revalidated: ["/pricing"],
      skipped: ["/time-only", "/unknown"],
    });
    expect(revalidateFetches).toEqual([
      {
        url: "https://app.example/pricing",
        headers: expect.objectContaining({ "x-prerender-revalidate": "secret" }),
      },
    ]);
  });

  it("reports failed regenerations instead of aborting the batch", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.PRACHT_REVALIDATE_TOKEN = "secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        if (String(input).includes("/pricing")) {
          throw new TypeError("network unreachable");
        }
        return new Response("<html>ok</html>", { status: 200 });
      }),
    );

    const handler = createVercelEdgeHandler({ app });
    const response = await handler(createWebhookRequest(["/pricing"], "secret"), {});

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      failed: ["/pricing"],
      revalidated: [],
      skipped: [],
    });
  });

  it("marks cache hits on the bypass request as failed instead of revalidated", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.PRACHT_REVALIDATE_TOKEN = "secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>cached</html>", {
            headers: { "x-vercel-cache": "HIT" },
            status: 200,
          }),
      ),
    );

    const handler = createVercelEdgeHandler({ app });
    const response = await handler(createWebhookRequest(["/pricing"], "secret"), {});

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      failed: ["/pricing"],
      revalidated: [],
      skipped: [],
    });
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("did not match the build-time bypass token"),
    );
  });

  it("treats an absent x-vercel-cache header as a successful regeneration", async () => {
    process.env.PRACHT_REVALIDATE_TOKEN = "secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>ok</html>", { status: 200 })),
    );

    const handler = createVercelEdgeHandler({ app });
    const response = await handler(createWebhookRequest(["/pricing"], "secret"), {});

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      failed: [],
      revalidated: ["/pricing"],
      skipped: [],
    });
  });

  it("marks non-ok upstream regeneration responses as failed", async () => {
    process.env.PRACHT_REVALIDATE_TOKEN = "secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );

    const handler = createVercelEdgeHandler({ app });
    const response = await handler(createWebhookRequest(["/pricing"], "secret"), {});

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      failed: ["/pricing"],
      revalidated: [],
      skipped: [],
    });
  });
});

describe("default cache-control (shared with the Node and Cloudflare adapters)", () => {
  const app = defineApp({
    routes: [route("/dash", "./routes/dash.tsx", { render: "ssr" })],
  });
  const registry = {
    routeModules: { "/src/routes/dash.tsx": async () => ({ default: () => null }) },
  };

  it("stamps SSR documents that set no policy of their own", async () => {
    const handler = createVercelEdgeHandler({ app, registry });
    const response = await handler(new Request("https://app.example/dash"), {});

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("leaves a route's own cache-control untouched", async () => {
    const handler = createVercelEdgeHandler({
      app: defineApp({ routes: [route("/cached", "./routes/cached.tsx", { render: "ssr" })] }),
      registry: {
        routeModules: {
          "/src/routes/cached.tsx": async () => ({
            default: () => null,
            headers: () => ({ "cache-control": "public, max-age=600" }),
          }),
        },
      },
    });
    const response = await handler(new Request("https://app.example/cached"), {});

    expect(response.headers.get("cache-control")).toBe("public, max-age=600");
  });

  // The generated entry wires `nodeListener = createVercelNodeListener(handle)`
  // around the very handler that stamps, so an ISG regeneration re-enters it.
  // Stamping there wrote `private, no-cache` into Vercel's prerender cache —
  // killing the CDN layer for every ISG page — and made `isCacheableISGResponse`
  // false for every render, firing a "render this route as SSR instead" warning
  // the framework itself had caused.
  it("does not stamp ISG prerender responses, which Vercel stores and replays", async () => {
    const isgApp = defineApp({
      routes: [
        route("/pricing", "./routes/pricing.tsx", {
          render: "isg",
          revalidate: timeRevalidate(60),
        }),
      ],
    });
    const handle = createVercelEdgeHandler({
      app: isgApp,
      registry: {
        routeModules: { "/src/routes/pricing.tsx": async () => ({ default: () => null }) },
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const listener = createVercelNodeListener(handle);

    const headers: Record<string, string | string[]> = {};
    await listener(
      {
        headers: { host: "app.example", "x-forwarded-proto": "https" },
        method: "GET",
        url: "/pricing",
      },
      {
        end() {},
        setHeader(key: string, value: string | string[]) {
          headers[key] = value;
        },
        statusCode: 0,
        write() {},
      },
    );

    expect(headers["cache-control"]).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();

    // The same handler still stamps on the ordinary edge path.
    const edge = await handle(new Request("https://app.example/pricing"), {});
    expect(edge.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("does not touch non-GET responses", async () => {
    const handler = createVercelEdgeHandler({
      apiRoutes: resolveApiRoutes(["/src/api/echo.ts"]),
      app: defineApp({ routes: [] }),
      registry: {
        apiModules: { "/src/api/echo.ts": async () => ({ POST: () => Response.json({}) }) },
      },
    });
    const response = await handler(
      new Request("https://app.example/api/echo", {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      {},
    );

    expect(response.status).toBe(200);
    expect(response.headers.has("cache-control")).toBe(false);
  });
});
