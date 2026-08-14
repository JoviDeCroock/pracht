import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defineApp,
  resolveApiRoutes,
  route,
  timeRevalidate,
  webhookRevalidate,
} from "@pracht/core";

import { createNodeRequestHandler, createNodeServerEntryModule } from "../src/index.ts";
import { isClientDisconnectError } from "../src/node-request.ts";

const tempDirs: string[] = [];
const servers = new Set<ReturnType<typeof createServer>>();
const onUnhandledCleanups: Array<() => void> = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pracht-adapter-node-"));
  tempDirs.push(dir);
  return dir;
}

function requestRaw(options: RequestOptions): Promise<IncomingMessage> {
  return new Promise((resolveRequest, reject) => {
    const req = httpRequest(options, (res) => {
      res.resume();
      res.on("end", () => resolveRequest(res));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  vi.restoreAllMocks();

  while (onUnhandledCleanups.length > 0) {
    onUnhandledCleanups.pop()?.();
  }

  for (const server of servers) {
    server.close();
    await once(server, "close");
  }
  servers.clear();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("createNodeServerEntryModule", () => {
  it("can import an app createContext module and configure the body limit", () => {
    const source = createNodeServerEntryModule({
      createContextFrom: "/src/server/context.ts",
      maxBodySize: 10 * 1024 * 1024,
    });

    expect(source).toContain(
      'import { createContext as createPrachtContext } from "/src/server/context.ts";',
    );
    expect(source).toContain("createContext: createPrachtContext");
    expect(source).toContain("maxBodySize: 10485760");
    expect(source).toContain("islandsEntryUrl: islandsEntryUrl ?? undefined");
    expect(source).toContain("islandsBootstrapRequired");
  });

  it("imports and awaits a configureServer module before listen()", () => {
    const source = createNodeServerEntryModule({
      configureServerFrom: "/src/server/websockets.ts",
    });

    expect(source).toContain(
      'import { configureServer as configurePrachtServer } from "/src/server/websockets.ts";',
    );
    const configureIndex = source.indexOf("await configurePrachtServer(server)");
    const listenIndex = source.indexOf("server.listen(");
    expect(configureIndex).toBeGreaterThan(-1);
    expect(listenIndex).toBeGreaterThan(configureIndex);
  });

  it("stubs configureServer out when the option is not set", () => {
    const source = createNodeServerEntryModule();
    expect(source).toContain("const configurePrachtServer = undefined;");
  });

  it("passes the compression toggle through to the generated handler", () => {
    expect(createNodeServerEntryModule()).toContain("compression: undefined");
    expect(createNodeServerEntryModule({ compression: false })).toContain("compression: false");
  });
});

describe("createNodeRequestHandler", () => {
  it("warns for deployed Node handlers without a canonical origin", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const staticDir = makeTempDir();

    const handler = createNodeRequestHandler({
      app: defineApp({ routes: [] }),
      staticDir,
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handler(req, res);
    });
    servers.add(server);

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }

    await fetch(`http://127.0.0.1:${address.port}/missing`);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("canonicalOrigin"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("host-header poisoning"));
  });

  it("rejects request bodies above the configured limit", async () => {
    const app = defineApp({
      routes: [route("/upload", "./routes/upload.tsx", { render: "ssr" })],
    });
    const handler = createNodeRequestHandler({
      app,
      maxBodySize: 4,
      registry: {
        routeModules: {
          "./routes/upload.tsx": async () => ({
            Component: () => "ok",
          }),
        },
      },
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handler(req, res);
    });
    servers.add(server);

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/upload`, {
      body: "too-large",
      method: "POST",
    });

    expect(response.status).toBe(413);
    await expect(response.text()).resolves.toBe("Payload Too Large");
  });

  it("preserves multiple Set-Cookie headers from framework responses", async () => {
    const app = defineApp({
      routes: [],
    });
    const handler = createNodeRequestHandler({
      apiRoutes: resolveApiRoutes(["/src/api/cookies.ts"]),
      app,
      registry: {
        apiModules: {
          "/src/api/cookies.ts": async () => ({
            GET: async () => {
              const headers = new Headers();
              headers.append("set-cookie", "session=abc; Path=/; HttpOnly");
              headers.append("set-cookie", "csrf=def; Path=/; SameSite=Lax");
              return new Response("ok", { headers });
            },
          }),
        },
      },
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handler(req, res);
    });
    servers.add(server);

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }

    const response = await requestRaw({
      hostname: "127.0.0.1",
      path: "/api/cookies",
      port: address.port,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toEqual([
      "session=abc; Path=/; HttpOnly",
      "csrf=def; Path=/; SameSite=Lax",
    ]);
  });

  it("reuses createContext during stale ISG regeneration with a clean request", async () => {
    const staticDir = makeTempDir();
    const htmlDir = join(staticDir, "isg");
    const htmlPath = join(htmlDir, "index.html");
    mkdirSync(htmlDir, { recursive: true });
    writeFileSync(htmlPath, "<html><body>stale</body></html>", "utf-8");

    const staleAt = new Date(Date.now() - 10_000);
    utimesSync(htmlPath, staleAt, staleAt);

    const createContextCalls: string[] = [];
    const app = defineApp({
      routes: [
        route("/isg", "./routes/isg.tsx", {
          render: "isg",
          revalidate: timeRevalidate(1),
          hydration: "islands",
        }),
      ],
    });

    const handler = createNodeRequestHandler({
      app,
      createContext: ({ request }) => {
        const tenant = request.headers.get("x-tenant");
        createContextCalls.push(tenant ?? "missing");
        return { tenant };
      },
      isgManifest: {
        "/isg": {
          revalidate: timeRevalidate(1),
        },
      },
      islandsBootstrapRequired: true,
      islandsEntryUrl: "/assets/islands-agent.js",
      registry: {
        routeModules: {
          "./routes/isg.tsx": async () => ({
            Component: ({ data }) => `<main>${(data as { tenant: string }).tenant}</main>`,
            loader: async ({ context }) => ({
              tenant: (context as { tenant?: string }).tenant ?? "missing",
            }),
          }),
        },
      },
      staticDir,
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handler(req, res);
    });
    servers.add(server);

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/isg`, {
      headers: { "x-tenant": "acme" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-pracht-isg")).toBe("stale");
    await expect(response.text()).resolves.toContain("stale");

    await waitFor(
      () =>
        readFileSync(htmlPath, "utf-8").includes("missing") &&
        readFileSync(htmlPath, "utf-8").includes("/assets/islands-agent.js"),
    );

    expect(createContextCalls).toEqual(["missing"]);
    expect(readFileSync(htmlPath, "utf-8")).toContain("missing");
    expect(readFileSync(htmlPath, "utf-8")).toContain("/assets/islands-agent.js");
  });

  it("authenticates webhook ISG revalidation and regenerates opted-in paths", async () => {
    const staticDir = makeTempDir();
    const htmlDir = join(staticDir, "pricing");
    const htmlPath = join(htmlDir, "index.html");
    mkdirSync(htmlDir, { recursive: true });
    writeFileSync(htmlPath, "<html><body>old</body></html>", "utf-8");

    const previousToken = process.env.PRACHT_REVALIDATE_TOKEN;
    delete process.env.PRACHT_REVALIDATE_TOKEN;

    const app = defineApp({
      routes: [
        route("/pricing", "./routes/pricing.tsx", {
          render: "isg",
          revalidate: [timeRevalidate(3600), webhookRevalidate()],
        }),
      ],
    });
    const handler = createNodeRequestHandler({
      app,
      createContext: ({ request }) => ({
        cookie: request.headers.get("cookie") ?? "missing",
      }),
      isgManifest: {
        "/pricing": {
          revalidate: [timeRevalidate(3600), webhookRevalidate()],
        },
      },
      registry: {
        routeModules: {
          "./routes/pricing.tsx": async () => ({
            Component: ({ data }) => `<main>${(data as { cookie: string }).cookie}</main>`,
            loader: async ({ context }) => ({
              cookie: (context as { cookie?: string }).cookie ?? "missing",
            }),
          }),
        },
      },
      staticDir,
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handler(req, res);
    });
    servers.add(server);

    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected TCP server address");
      }

      const endpoint = `http://127.0.0.1:${address.port}/__pracht/revalidate`;
      const body = JSON.stringify({ paths: ["/pricing"] });

      const missingToken = await fetch(endpoint, {
        body,
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        method: "POST",
      });
      expect(missingToken.status).toBe(401);

      process.env.PRACHT_REVALIDATE_TOKEN = "secret";
      const badToken = await fetch(endpoint, {
        body,
        headers: { authorization: "Bearer wrong", "content-type": "application/json" },
        method: "POST",
      });
      expect(badToken.status).toBe(401);

      const valid = await fetch(endpoint, {
        body,
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          cookie: "session=should-not-leak",
        },
        method: "POST",
      });
      expect(valid.status).toBe(200);
      await expect(valid.json()).resolves.toMatchObject({
        failed: [],
        revalidated: ["/pricing"],
        skipped: [],
      });
      expect(readFileSync(htmlPath, "utf-8")).toContain("missing");
      expect(readFileSync(htmlPath, "utf-8")).not.toContain("should-not-leak");
    } finally {
      if (previousToken === undefined) {
        delete process.env.PRACHT_REVALIDATE_TOKEN;
      } else {
        process.env.PRACHT_REVALIDATE_TOKEN = previousToken;
      }
    }
  });

  it("reports failed webhook regenerations and keeps the stale HTML on disk", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const staticDir = makeTempDir();
    const htmlDir = join(staticDir, "broken");
    const htmlPath = join(htmlDir, "index.html");
    mkdirSync(htmlDir, { recursive: true });
    writeFileSync(htmlPath, "<html><body>stale-but-safe</body></html>", "utf-8");

    const previousToken = process.env.PRACHT_REVALIDATE_TOKEN;
    process.env.PRACHT_REVALIDATE_TOKEN = "secret";

    const app = defineApp({
      routes: [
        route("/broken", "./routes/broken.tsx", {
          render: "isg",
          revalidate: webhookRevalidate(),
        }),
      ],
    });
    const handler = createNodeRequestHandler({
      app,
      isgManifest: {
        "/broken": { revalidate: webhookRevalidate() },
      },
      registry: {
        routeModules: {
          "./routes/broken.tsx": async () => ({
            Component: () => "<main>never</main>",
            loader: async () => {
              throw new Error("upstream CMS exploded");
            },
          }),
        },
      },
      staticDir,
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handler(req, res);
    });
    servers.add(server);

    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected TCP server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/__pracht/revalidate`, {
        body: JSON.stringify({ paths: ["/broken", "/not-isg"] }),
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        failed: ["/broken"],
        revalidated: [],
        skipped: ["/not-isg"],
      });
      expect(readFileSync(htmlPath, "utf-8")).toContain("stale-but-safe");
    } finally {
      if (previousToken === undefined) {
        delete process.env.PRACHT_REVALIDATE_TOKEN;
      } else {
        process.env.PRACHT_REVALIDATE_TOKEN = previousToken;
      }
    }
  });

  it("isolates malformed manifest metadata to one webhook path", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const staticDir = makeTempDir();
    const htmlDir = join(staticDir, "pricing");
    const htmlPath = join(htmlDir, "index.html");
    mkdirSync(htmlDir, { recursive: true });
    writeFileSync(htmlPath, "<html><body>old</body></html>", "utf-8");

    const previousToken = process.env.PRACHT_REVALIDATE_TOKEN;
    process.env.PRACHT_REVALIDATE_TOKEN = "secret";

    const app = defineApp({
      routes: [
        route("/pricing", "./routes/pricing.tsx", {
          render: "isg",
          revalidate: webhookRevalidate(),
        }),
      ],
    });
    const handler = createNodeRequestHandler({
      app,
      isgManifest: {
        "/malformed": { revalidate: { kind: "cms" } as never },
        "/pricing": { revalidate: webhookRevalidate() },
      },
      registry: {
        routeModules: {
          "./routes/pricing.tsx": async () => ({
            Component: () => "<main>fresh</main>",
          }),
        },
      },
      staticDir,
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handler(req, res);
    });
    servers.add(server);

    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected TCP server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/__pracht/revalidate`, {
        body: JSON.stringify({ paths: ["/malformed", "/pricing"] }),
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        failed: ["/malformed"],
        revalidated: ["/pricing"],
        skipped: [],
      });
      expect(readFileSync(htmlPath, "utf-8")).toContain("fresh");
    } finally {
      if (previousToken === undefined) {
        delete process.env.PRACHT_REVALIDATE_TOKEN;
      } else {
        process.env.PRACHT_REVALIDATE_TOKEN = previousToken;
      }
    }
  });

  describe("markdown negotiation and the static fast path", () => {
    async function serveStaticApp({
      headersManifest = {},
      markdown = true,
      markdownManifest,
    }: {
      headersManifest?: Record<string, Record<string, string>>;
      markdown?: boolean;
      markdownManifest?: Record<string, true>;
    } = {}) {
      const staticDir = makeTempDir();
      const htmlDir = join(staticDir, "docs");
      mkdirSync(htmlDir, { recursive: true });
      writeFileSync(join(htmlDir, "index.html"), "<html><body>prerendered</body></html>", "utf-8");

      let rendered = 0;
      const app = defineApp({
        routes: [route("/docs", "./routes/docs.tsx", { render: "ssg" })],
      });
      const handler = createNodeRequestHandler({
        app,
        headersManifest,
        markdownManifest,
        registry: {
          routeModules: {
            "./routes/docs.tsx": async () => ({
              Component: () => {
                rendered += 1;
                return "<main>rendered</main>";
              },
              ...(markdown ? { markdown: "# Docs\n" } : {}),
            }),
          },
        },
        staticDir,
      });

      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        void handler(req, res);
      });
      servers.add(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected TCP server address");
      }

      return {
        get rendered() {
          return rendered;
        },
        url: `http://127.0.0.1:${address.port}/docs`,
      };
    }

    it("keeps serving the prerendered document when the route cannot answer with markdown", async () => {
      const { rendered, url } = await serveStaticApp({
        markdownManifest: { "/docs": true },
      });

      // A browser-shaped Accept that merely mentions markdown at a lower
      // quality must not knock the request off the static file.
      const response = await fetch(url, {
        headers: { accept: "text/html,text/markdown;q=0.1" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("prerendered");
      expect(response.headers.get("etag")).not.toBeNull();
      expect(rendered).toBe(0);
    });

    it("keeps serving non-markdown routes even when their own headers vary on Accept", async () => {
      const { rendered, url } = await serveStaticApp({
        headersManifest: { "/docs": { vary: "Accept" } },
        markdown: false,
        markdownManifest: {},
      });

      const response = await fetch(url, { headers: { accept: "text/markdown" } });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("prerendered");
      expect(rendered).toBe(0);
    });

    it("falls through for legacy/custom entries without markdown metadata", async () => {
      const { url } = await serveStaticApp();

      const response = await fetch(url, { headers: { accept: "text/markdown" } });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/markdown");
      expect(await response.text()).toBe("# Docs\n");
    });

    it("falls through when the exact route is in the markdown manifest", async () => {
      const { url } = await serveStaticApp({ markdownManifest: { "/docs": true } });

      const response = await fetch(url, { headers: { accept: "text/markdown" } });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/markdown");
      expect(await response.text()).toBe("# Docs\n");
    });

    it("falls through when the request path normalizes to a markdown route", async () => {
      const { url } = await serveStaticApp({ markdownManifest: { "/docs": true } });

      const response = await fetch(`${url}//`, { headers: { accept: "text/markdown" } });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/markdown");
      expect(await response.text()).toBe("# Docs\n");
    });
  });

  describe("isClientDisconnectError", () => {
    it("recognizes disconnects through a cause chain", () => {
      const inner = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      expect(isClientDisconnectError(new Error("wrapped", { cause: inner }))).toBe(true);
      expect(isClientDisconnectError(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(
        false,
      );
      expect(isClientDisconnectError(undefined)).toBe(false);
    });

    it("survives a cyclic cause chain", () => {
      // A self- or mutually-referential `cause` is legal. Recursing on it would
      // throw RangeError from inside the handler's own catch block, turning the
      // crash this guard prevents back into an unhandled rejection.
      const first = new Error("first");
      const second = new Error("second");
      (first as { cause?: unknown }).cause = second;
      (second as { cause?: unknown }).cause = first;

      expect(isClientDisconnectError(first)).toBe(false);

      const selfReferential = new Error("self");
      (selfReferential as { cause?: unknown }).cause = selfReferential;
      expect(isClientDisconnectError(selfReferential)).toBe(false);
    });
  });

  describe("client disconnects", () => {
    async function serveApp(options: {
      largeStaticFile?: boolean;
      throwFromLoader?: boolean;
    }): Promise<{ base: string; unhandled: unknown[] }> {
      const staticDir = makeTempDir();
      mkdirSync(join(staticDir, "assets"), { recursive: true });
      writeFileSync(
        join(staticDir, "assets", "big.js"),
        "x".repeat(options.largeStaticFile === false ? 16 : 8 * 1024 * 1024),
        "utf-8",
      );

      const app = defineApp({
        routes: [route("/slow", "./routes/slow.tsx", { render: "ssr" })],
      });
      const handler = createNodeRequestHandler({
        app,
        registry: {
          routeModules: {
            "./routes/slow.tsx": async () => ({
              Component: () => "<main>slow</main>",
              ...(options.throwFromLoader
                ? {
                    loader: () => {
                      throw new Error("loader exploded");
                    },
                  }
                : {}),
            }),
          },
        },
        staticDir,
      });

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      onUnhandledCleanups.push(() => process.off("unhandledRejection", onUnhandled));

      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        void handler(req, res);
      });
      servers.add(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected TCP server address");
      }

      return { base: `http://127.0.0.1:${address.port}`, unhandled };
    }

    it("survives a client aborting a streamed static asset", async () => {
      const { base, unhandled } = await serveApp({});

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const controller = new AbortController();
        const pending = fetch(`${base}/assets/big.js`, { signal: controller.signal }).catch(
          () => undefined,
        );
        controller.abort();
        await pending;
      }

      // Give any rejection a chance to surface before asserting.
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 100));

      expect(unhandled).toEqual([]);
      const response = await fetch(`${base}/assets/big.js`);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    });

    // A response body that fails is a *server* failure however it is spelled.
    // The disconnect-shaped codes matter most: undici reports a proxied
    // backend's TCP reset as `TypeError: terminated` with
    // `cause.code === "ECONNRESET"`, so classifying on the code alone would
    // file a backend outage as a client disconnect and lose it entirely.
    it.each([
      [
        "a plain transport code",
        Object.assign(new Error("upstream died"), { code: "UND_ERR_SOCKET" }),
      ],
      ["a disconnect code", Object.assign(new Error("reset"), { code: "ECONNRESET" })],
      [
        "a disconnect code in the cause chain",
        Object.assign(new TypeError("terminated"), {
          cause: Object.assign(new Error("socket"), { code: "ECONNRESET" }),
        }),
      ],
    ])("answers 500 and logs when the response body fails with %s", async (_label, failure) => {
      const errors: unknown[] = [];
      vi.spyOn(console, "error").mockImplementation((...args) => {
        errors.push(args.join(" "));
      });

      const handler = createNodeRequestHandler({
        app: defineApp({ routes: [] }),
        apiRoutes: resolveApiRoutes(["/src/api/stream.ts"]),
        registry: {
          apiModules: {
            "/src/api/stream.ts": async () => ({
              GET: async () =>
                new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.error(failure);
                    },
                  }),
                  { headers: { "content-type": "text/plain" } },
                ),
            }),
          },
        },
      });

      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        void handler(req, res);
      });
      servers.add(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected TCP server address");
      }

      // Nothing was written yet, so a real status is still possible — the
      // client must not just see the connection drop.
      const response = await fetch(`http://127.0.0.1:${address.port}/api/stream`, {
        headers: { "accept-encoding": "br" },
      });
      expect(response.status).toBe(500);
      expect(response.statusText).toBe("Internal Server Error");
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.text()).resolves.toBe("Internal Server Error");

      await waitFor(() => errors.some((entry) => String(entry).includes("Unhandled error")));
    });

    it("answers 500 rather than hanging on a server-side ECONNRESET", async () => {
      // A pooled database or cache client resetting inside `createContext`
      // throws `Error { code: "ECONNRESET" }`. Treating the code alone as a
      // client disconnect would return without ending the response, leaving
      // the request to hang until `server.requestTimeout`.
      vi.spyOn(console, "error").mockImplementation(() => {});

      const handler = createNodeRequestHandler({
        app: defineApp({ routes: [] }),
        createContext: () => {
          throw Object.assign(new Error("pool reset"), { code: "ECONNRESET" });
        },
      });

      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        void handler(req, res);
      });
      servers.add(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected TCP server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/anything`);
      expect(response.status).toBe(500);
      await response.text();
    });

    it("answers 500 instead of rejecting when the framework throws", async () => {
      const { base, unhandled } = await serveApp({
        largeStaticFile: false,
        throwFromLoader: true,
      });

      const response = await fetch(`${base}/slow`);
      // The framework sanitizes loader errors into a 500 document itself; the
      // point of this test is that the handler never rejects.
      expect(response.status).toBeGreaterThanOrEqual(500);
      await response.text();

      await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
      expect(unhandled).toEqual([]);
    });
  });
});

describe("default cache-control (shared with the Cloudflare and Vercel adapters)", () => {
  async function serve(
    handlerOptions: Parameters<typeof createNodeRequestHandler>[0],
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const handler = createNodeRequestHandler(handlerOptions);
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handler(req, res);
    });
    servers.add(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");
    return fetch(`http://127.0.0.1:${address.port}${path}`, init);
  }

  const app = defineApp({
    routes: [route("/dash", "./routes/dash.tsx", { render: "ssr" })],
  });
  const registry = {
    routeModules: {
      "/src/routes/dash.tsx": async () => ({ default: () => null }),
    },
  };

  // A reverse proxy or CDN in front of Node may heuristically cache a 200 that
  // carries no Cache-Control, and Cookie is not part of its key. Cloudflare
  // guarded this; Node and Vercel did not, so the protection disappeared when
  // an app changed adapters.
  it("stamps SSR documents that set no policy of their own", async () => {
    const response = await serve({ app, canonicalOrigin: "https://app.test", registry }, "/dash");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("leaves a route's own cache-control untouched", async () => {
    const response = await serve(
      {
        app: defineApp({ routes: [route("/cached", "./routes/cached.tsx", { render: "ssr" })] }),
        canonicalOrigin: "https://app.test",
        registry: {
          routeModules: {
            "/src/routes/cached.tsx": async () => ({
              default: () => null,
              headers: () => ({ "cache-control": "public, max-age=600" }),
            }),
          },
        },
      },
      "/cached",
    );

    expect(response.headers.get("cache-control")).toBe("public, max-age=600");
  });

  it("does not touch non-GET responses", async () => {
    const response = await serve(
      {
        apiRoutes: resolveApiRoutes(["/src/api/echo.ts"]),
        app: defineApp({ routes: [] }),
        canonicalOrigin: "https://app.test",
        registry: {
          apiModules: { "/src/api/echo.ts": async () => ({ POST: () => Response.json({}) }) },
        },
      },
      "/api/echo",
      { body: "{}", headers: { "content-type": "application/json" }, method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.has("cache-control")).toBe(false);
  });
});
