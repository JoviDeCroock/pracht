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

const tempDirs: string[] = [];
const servers = new Set<ReturnType<typeof createServer>>();

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
      routes: [route("/isg", "./routes/isg.tsx", { render: "isg", revalidate: timeRevalidate(1) })],
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

    await waitFor(() => readFileSync(htmlPath, "utf-8").includes("missing"));

    expect(createContextCalls).toEqual(["missing"]);
    expect(readFileSync(htmlPath, "utf-8")).toContain("missing");
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
      await expect(valid.json()).resolves.toEqual({
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
      await expect(response.json()).resolves.toEqual({
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
      await expect(response.json()).resolves.toEqual({
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
});
