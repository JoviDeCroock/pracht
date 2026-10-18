import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineApp, route, timeRevalidate } from "@pracht/core";

import { createNodeRequestHandler } from "../src/index.ts";
import { createISGSnapshotWriteGuard } from "../src/node-isg.ts";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

// Root ignores directory permissions, so the write would succeed.
const unwritableDirsWork = process.getuid?.() !== 0;

async function startReadOnlyIsgServer(options: { snapshot: boolean }) {
  const staticDir = mkdtempSync(join(tmpdir(), "pracht-isg-readonly-"));
  const htmlDir = join(staticDir, "p");
  mkdirSync(htmlDir, { recursive: true });
  if (options.snapshot) {
    const htmlPath = join(htmlDir, "index.html");
    writeFileSync(htmlPath, "<html><body>build</body></html>", "utf-8");
    const staleAt = new Date(Date.now() - 120_000);
    utimesSync(htmlPath, staleAt, staleAt);
  }
  // A read-only root filesystem: the snapshot can be read but not replaced.
  chmodSync(htmlDir, 0o555);
  cleanups.push(() => {
    chmodSync(htmlDir, 0o755);
    rmSync(staticDir, { force: true, recursive: true });
  });

  const renders = { count: 0 };
  const revalidate = timeRevalidate(60);
  const handler = createNodeRequestHandler({
    app: defineApp({ routes: [route("/p", "./routes/p.tsx", { render: "isg", revalidate })] }),
    canonicalOrigin: "http://localhost",
    compression: false,
    isgManifest: { "/p": { revalidate } },
    registry: {
      routeModules: {
        "./routes/p.tsx": async () => ({
          Component: () => "<main>regenerated</main>",
          loader: async () => {
            renders.count++;
            return {};
          },
        }),
      },
    },
    staticDir,
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return { base: `http://127.0.0.1:${address.port}`, handler, htmlDir, renders };
}

describe("createISGSnapshotWriteGuard", () => {
  it("pauses regeneration for the given window and resumes after it or a success", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let now = 1_000;
    const guard = createISGSnapshotWriteGuard(() => now);

    guard.failed("/static/a/index.html", new Error("EROFS"), 60_000);
    expect(guard.canRegenerate("/static/a/index.html")).toBe(false);
    expect(guard.canRegenerate("/static/b/index.html")).toBe(true);
    now += 60_000;
    expect(guard.canRegenerate("/static/a/index.html")).toBe(true);

    guard.failed("/static/a/index.html", new Error("EROFS"), 60_000);
    guard.succeeded("/static/a/index.html");
    expect(guard.canRegenerate("/static/a/index.html")).toBe(true);
  });
});

describe.runIf(unwritableDirsWork)("ISG on a read-only filesystem", () => {
  it("re-renders a stale page once per revalidate window and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { base, handler, htmlDir, renders } = await startReadOnlyIsgServer({ snapshot: true });

    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${base}/p`);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-pracht-isg")).toBe("stale");
      await expect(response.text()).resolves.toContain("build");
      await handler.drain();
    }

    expect(renders.count).toBe(1);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("EACCES");
    expect(String(warn.mock.calls[0]?.[0])).toContain(htmlDir);
  });

  it("answers a cold render instead of failing when its snapshot cannot be saved", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { base, renders } = await startReadOnlyIsgServer({ snapshot: false });

    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/p`);
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain("regenerated");
    }

    expect(renders.count).toBe(2);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("EACCES");
  });
});
