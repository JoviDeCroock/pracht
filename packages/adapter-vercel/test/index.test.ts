import { afterEach, describe, expect, it, vi } from "vitest";

import { defineApp, route, timeRevalidate, webhookRevalidate } from "@pracht/core";

import { createVercelEdgeHandler, createVercelServerEntryModule } from "../src/index.ts";

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
    expect(source).toContain('export const vercelFunctionName = "app";');
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
    if (previousToken === undefined) {
      delete process.env.PRACHT_REVALIDATE_TOKEN;
    } else {
      process.env.PRACHT_REVALIDATE_TOKEN = previousToken;
    }
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
    await expect(response.json()).resolves.toEqual({
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
    await expect(response.json()).resolves.toEqual({
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
    await expect(response.json()).resolves.toEqual({
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
    await expect(response.json()).resolves.toEqual({
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
    await expect(response.json()).resolves.toEqual({
      failed: ["/pricing"],
      revalidated: [],
      skipped: [],
    });
  });
});
