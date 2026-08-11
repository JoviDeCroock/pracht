import { afterEach, describe, expect, it } from "vitest";

import {
  createRevalidationSingleFlight,
  getTimeRevalidateSeconds,
  hasWebhookRevalidate,
  isAuthorizedRevalidationRequest,
  isCacheableISGResponse,
  normalizeRouteRevalidate,
  classifyRevalidationSkip,
  readRevalidationRequest,
  resolveRevalidationToken,
  timeRevalidate,
  webhookRevalidate,
} from "@pracht/core";
import { setServerEnv } from "@pracht/core/env/server";

describe("revalidation policies", () => {
  it("supports combining time and webhook revalidation", () => {
    const policy = [timeRevalidate(60), webhookRevalidate()] as const;

    expect(normalizeRouteRevalidate(policy)).toEqual([
      { kind: "time", seconds: 60 },
      { kind: "webhook" },
    ]);
    expect(getTimeRevalidateSeconds(policy)).toBe(60);
    expect(hasWebhookRevalidate(policy)).toBe(true);
  });

  it("rejects invalid literal policy objects", () => {
    expect(() => normalizeRouteRevalidate({ kind: "time", seconds: 0 } as never)).toThrow(
      "positive integer",
    );
    expect(() =>
      normalizeRouteRevalidate([{ kind: "webhook" }, { kind: "webhook" }] as never),
    ).toThrow('duplicate "webhook"');
    expect(() => normalizeRouteRevalidate({ kind: "cms" } as never)).toThrow(
      'Unsupported route revalidate policy "cms"',
    );
  });
});

describe("revalidation endpoint auth", () => {
  it("accepts a valid bearer token", () => {
    const request = new Request("https://app.example/__pracht/revalidate", {
      headers: { authorization: "Bearer secret" },
      method: "POST",
    });

    expect(isAuthorizedRevalidationRequest(request, "secret")).toBe(true);
  });

  it("rejects bad and missing server tokens", () => {
    const request = new Request("https://app.example/__pracht/revalidate", {
      headers: { authorization: "Bearer wrong" },
      method: "POST",
    });

    expect(isAuthorizedRevalidationRequest(request, "secret")).toBe(false);
    expect(isAuthorizedRevalidationRequest(request, undefined)).toBe(false);
    expect(isAuthorizedRevalidationRequest(request, "")).toBe(false);
  });

  it("parses paths only after authorization", async () => {
    const unauthorized = await readRevalidationRequest(
      new Request("https://app.example/__pracht/revalidate", {
        body: JSON.stringify({ paths: ["/pricing"] }),
        headers: { authorization: "Bearer wrong" },
        method: "POST",
      }),
      "secret",
    );

    expect(unauthorized.ok).toBe(false);
    if (!unauthorized.ok) expect(unauthorized.response.status).toBe(401);

    const authorized = await readRevalidationRequest(
      new Request("https://app.example/__pracht/revalidate", {
        body: JSON.stringify({ paths: ["/pricing", "/pricing"] }),
        headers: { authorization: "Bearer secret" },
        method: "POST",
      }),
      "secret",
    );

    expect(authorized).toEqual({ ok: true, paths: ["/pricing"] });
  });

  it("rejects batches over 64 paths before deduplicating them", async () => {
    const atLimit = await readRevalidationRequest(
      new Request("https://app.example/__pracht/revalidate", {
        body: JSON.stringify({ paths: Array.from({ length: 64 }, () => "/pricing") }),
        headers: { authorization: "Bearer secret" },
        method: "POST",
      }),
      "secret",
    );
    expect(atLimit).toEqual({ ok: true, paths: ["/pricing"] });

    const overLimit = await readRevalidationRequest(
      new Request("https://app.example/__pracht/revalidate", {
        body: JSON.stringify({ paths: Array.from({ length: 65 }, () => "/pricing") }),
        headers: { authorization: "Bearer secret" },
        method: "POST",
      }),
      "secret",
    );
    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) {
      expect(overLimit.response.status).toBe(400);
      await expect(overLimit.response.json()).resolves.toEqual({
        error: "Expected at most 64 revalidation paths.",
      });
    }
  });

  it("rejects traversal segments and backslashes in paths", async () => {
    const invalidPaths = [
      "/../secret",
      "/pricing/../admin",
      "/pricing/..",
      "/..",
      "/pricing\\admin",
      "\\pricing",
      "/pricing\\..\\admin",
    ];

    for (const path of invalidPaths) {
      const parsed = await readRevalidationRequest(
        new Request("https://app.example/__pracht/revalidate", {
          body: JSON.stringify({ paths: [path] }),
          headers: { authorization: "Bearer secret" },
          method: "POST",
        }),
        "secret",
      );

      expect(parsed.ok, `expected ${JSON.stringify(path)} to be rejected`).toBe(false);
      if (!parsed.ok) expect(parsed.response.status).toBe(400);
    }

    // Dots that are not a bare `..` segment stay valid.
    const parsed = await readRevalidationRequest(
      new Request("https://app.example/__pracht/revalidate", {
        body: JSON.stringify({ paths: ["/docs/v1..2/notes.txt"] }),
        headers: { authorization: "Bearer secret" },
        method: "POST",
      }),
      "secret",
    );
    expect(parsed).toEqual({ ok: true, paths: ["/docs/v1..2/notes.txt"] });
  });
});

describe("createRevalidationSingleFlight", () => {
  it("collapses concurrent tasks for the same key into one execution", async () => {
    const singleFlight = createRevalidationSingleFlight();
    let executions = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const task = async () => {
      executions += 1;
      await gate;
      return executions;
    };

    const first = singleFlight("/pricing", task);
    const second = singleFlight("/pricing", task);
    const other = singleFlight("/other", async () => {
      executions += 1;
      return executions;
    });

    release();
    await expect(Promise.all([first, second, other])).resolves.toBeDefined();
    expect(executions).toBe(2);
    await expect(first).resolves.toBe(await second);
  });

  it("allows a new run after the previous one settles, including rejections", async () => {
    const singleFlight = createRevalidationSingleFlight();
    let executions = 0;

    await expect(
      singleFlight("/pricing", async () => {
        executions += 1;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(
      singleFlight("/pricing", async () => {
        executions += 1;
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(executions).toBe(2);
  });
});

describe("isCacheableISGResponse", () => {
  it("accepts plain shared-cacheable HTML responses", () => {
    expect(
      isCacheableISGResponse(
        new Response("<html></html>", {
          headers: { "content-type": "text/html", vary: "accept-encoding" },
        }),
      ),
    ).toBe(true);
  });

  it("rejects responses that depend on per-request state", () => {
    expect(
      isCacheableISGResponse(new Response("x", { headers: { "cache-control": "no-store" } })),
    ).toBe(false);
    expect(
      isCacheableISGResponse(
        new Response("x", { headers: { "cache-control": "private, max-age=60" } }),
      ),
    ).toBe(false);
    expect(
      isCacheableISGResponse(new Response("x", { headers: { "set-cookie": "session=abc" } })),
    ).toBe(false);
    expect(isCacheableISGResponse(new Response("x", { headers: { vary: "Cookie" } }))).toBe(false);
    expect(
      isCacheableISGResponse(new Response("x", { headers: { vary: "Accept, Authorization" } })),
    ).toBe(false);
    expect(isCacheableISGResponse(new Response("x", { headers: { vary: "*" } }))).toBe(false);
  });
});

describe("resolveRevalidationToken", () => {
  const previous = process.env.PRACHT_REVALIDATE_TOKEN;

  afterEach(() => {
    setServerEnv(undefined);
    if (previous === undefined) delete process.env.PRACHT_REVALIDATE_TOKEN;
    else process.env.PRACHT_REVALIDATE_TOKEN = previous;
  });

  it("reads the ambient process environment on Node-style runtimes", () => {
    process.env.PRACHT_REVALIDATE_TOKEN = "from-process";
    expect(resolveRevalidationToken()).toBe("from-process");
  });

  it("prefers installed platform bindings over the ambient environment", () => {
    process.env.PRACHT_REVALIDATE_TOKEN = "from-process";
    setServerEnv({ PRACHT_REVALIDATE_TOKEN: "from-binding" });
    expect(resolveRevalidationToken()).toBe("from-binding");
  });

  it("treats a missing, empty, or non-string token as unconfigured", () => {
    delete process.env.PRACHT_REVALIDATE_TOKEN;
    expect(resolveRevalidationToken()).toBeUndefined();

    setServerEnv({ PRACHT_REVALIDATE_TOKEN: "" });
    expect(resolveRevalidationToken()).toBeUndefined();

    setServerEnv({ PRACHT_REVALIDATE_TOKEN: 42 });
    expect(resolveRevalidationToken()).toBeUndefined();
  });

  it("fails closed instead of throwing when no environment is available yet", () => {
    // Mirrors Cloudflare before the first request installs its bindings.
    setServerEnv(undefined);
    const runtime = globalThis as Record<string, unknown>;
    const realProcess = runtime.process;
    try {
      delete runtime.process;
      expect(resolveRevalidationToken()).toBeUndefined();
    } finally {
      runtime.process = realProcess;
    }
  });
});

describe("classifyRevalidationSkip", () => {
  const webhookEntry = { render: "isg", revalidate: [timeRevalidate(60), webhookRevalidate()] };

  it("acts only when there is a prerendered entry with a webhook policy", () => {
    expect(classifyRevalidationSkip(webhookEntry, true)).toBeNull();
    expect(classifyRevalidationSkip({ render: "isg", revalidate: timeRevalidate(60) }, true)).toBe(
      "no_webhook_policy",
    );
    expect(classifyRevalidationSkip(webhookEntry, false)).toBe("not_prerendered");
  });

  // Manifest-driven adapters (Node, Cloudflare) see no entry for a route that
  // is not ISG. Without the matched route they reported every such path as
  // `not_a_route`, so a real SSR route looked exactly like a typo.
  it("distinguishes a real non-ISG route from a path that does not exist", () => {
    expect(classifyRevalidationSkip(undefined, false, { render: "ssr" })).toBe("not_isg");
    expect(classifyRevalidationSkip(undefined, false, null)).toBe("not_a_route");
    expect(classifyRevalidationSkip(undefined, false)).toBe("not_a_route");
  });

  it("reports an ISG route with no cached copy as not_prerendered", () => {
    // A dynamic ISG path getStaticPaths() never enumerated.
    expect(classifyRevalidationSkip(undefined, false, { render: "isg" })).toBe("not_prerendered");
  });
});
