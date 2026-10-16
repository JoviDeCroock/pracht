import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function serve(policy: "ignore" | "never" | "always", base = "/") {
  vi.resetModules();
  vi.stubGlobal("__PRACHT_TRAILING_SLASH__", policy);
  vi.stubEnv("BASE_URL", base);
  const [core, adapter] = await Promise.all([
    import("../../framework/src/index.ts"),
    import("../src/node-handler.ts"),
  ]);
  const staticDir = mkdtempSync(join(tmpdir(), "pracht-trailing-slash-"));
  tempDirs.push(staticDir);
  for (const page of ["about", "isg"]) {
    mkdirSync(join(staticDir, page), { recursive: true });
    writeFileSync(join(staticDir, page, "index.html"), `<main>${page} (static)</main>`, "utf-8");
  }
  writeFileSync(join(staticDir, "index.html"), "<main>home (static)</main>", "utf-8");
  mkdirSync(join(staticDir, "files"), { recursive: true });
  writeFileSync(join(staticDir, "files", "LICENSE"), "MIT", "utf-8");

  const isgRevalidate = core.timeRevalidate(3600);
  const handler = adapter.createNodeRequestHandler({
    app: core.defineApp({
      routes: [
        core.route("/", "./routes/page.tsx", { render: "ssg" }),
        core.route("/about", "./routes/page.tsx", { render: "ssg" }),
        core.route("/isg", "./routes/page.tsx", { render: "isg", revalidate: isgRevalidate }),
        core.route("/ssr", "./routes/page.tsx", { render: "ssr" }),
      ],
    }),
    canonicalOrigin: "https://example.test",
    compression: false,
    isgManifest: { "/isg": { revalidate: isgRevalidate } },
    registry: {
      routeModules: { "./routes/page.tsx": async () => ({ Component: () => "rendered" }) },
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
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, { redirect: "manual", ...init });
}

describe('Node adapter under trailingSlash: "always"', () => {
  it("redirects prerendered, ISG, and SSR pages to the slash form", async () => {
    const get = await serve("always");
    for (const path of ["/about", "/isg", "/ssr"]) {
      const response = await get(`${path}?q=1`);
      expect(response.status, path).toBe(308);
      expect(response.headers.get("location"), path).toBe(`${path}/?q=1`);
    }
    expect(await (await get("/about/")).text()).toBe("<main>about (static)</main>");
    const isg = await get("/isg/");
    expect(isg.status).toBe(200);
    // The ISG manifest is keyed by route path: the slash form is still ISG.
    expect(isg.headers.get("x-pracht-isg")).toBe("fresh");
    expect((await get("/ssr/")).status).toBe(200);
    expect((await get("/")).status).toBe(200);
  });

  it("serves files as named and leaves route-state fetches alone", async () => {
    const get = await serve("always");
    const file = await get("/files/LICENSE");
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("MIT");
    const state = await get("/ssr", { headers: { "x-pracht-route-state-request": "1" } });
    expect(state.status).toBe(200);
  });

  it("keeps the deploy base in the location", async () => {
    const get = await serve("always", "/app/");
    const response = await get("/app/about");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/app/about/");
    expect((await get("/app/about/")).status).toBe(200);
    const bare = await get("/app");
    expect(bare.headers.get("location")).toBe("/app/");
  });
});

describe('Node adapter under trailingSlash: "never"', () => {
  it("redirects the slash form of every page", async () => {
    const get = await serve("never");
    for (const path of ["/about", "/isg", "/ssr"]) {
      const response = await get(`${path}/`);
      expect(response.status, path).toBe(308);
      expect(response.headers.get("location"), path).toBe(path);
    }
    expect((await get("/about")).status).toBe(200);
    expect((await get("/")).status).toBe(200);
  });
});

describe("Node adapter by default", () => {
  it("serves both spellings and finds the ISG entry for either", async () => {
    const get = await serve("ignore");
    expect((await get("/about")).status).toBe(200);
    expect((await get("/about/")).status).toBe(200);
    const isg = await get("/isg/");
    expect(isg.status).toBe(200);
    expect(isg.headers.get("x-pracht-isg")).toBe("fresh");
  });
});
