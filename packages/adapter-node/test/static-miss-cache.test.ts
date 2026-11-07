import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineApp, route } from "@pracht/core";

import { createNodeRequestHandler } from "../src/index.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) cleanups.pop()!();
});

async function serve(): Promise<{ base: string; staticDir: string }> {
  const root = mkdtempSync(join(tmpdir(), "pracht-adapter-node-static-miss-"));
  const staticDir = join(root, "client");
  mkdirSync(staticDir, { recursive: true });
  const handler = createNodeRequestHandler({
    app: defineApp({ routes: [route("/:page", "./routes/page.tsx", { render: "ssr" })] }),
    registry: {
      routeModules: { "./routes/page.tsx": async () => ({ Component: () => "rendered" }) },
    },
    staticDir,
  });
  const server = createServer((req, res) => void handler(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
    rmSync(root, { force: true, recursive: true });
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, staticDir };
}

describe("static lookups for rendered paths", () => {
  it("find a file added after a path missed, once the miss window passes", async () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { base, staticDir } = await serve();

    expect(await (await fetch(`${base}/late.txt`)).text()).toContain("rendered");
    writeFileSync(join(staticDir, "late.txt"), "from disk");
    // Inside the window the miss is remembered and the route renders.
    now += 500;
    expect(await (await fetch(`${base}/late.txt`)).text()).toContain("rendered");

    now += 501;
    const response = await fetch(`${base}/late.txt`);

    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("from disk");
  });

  it("keep serving a file that already exists on every request", async () => {
    const { base, staticDir } = await serve();
    writeFileSync(join(staticDir, "robots.txt"), "User-agent: *");

    for (let i = 0; i < 3; i += 1) {
      expect(await (await fetch(`${base}/robots.txt`)).text()).toBe("User-agent: *");
    }
  });
});
