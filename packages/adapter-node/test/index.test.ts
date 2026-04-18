import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import { defineApp, route, timeRevalidate } from "@pracht/core";

import { createNodeRequestHandler } from "../src/index.ts";

const tempDirs: string[] = [];
const servers = new Set<ReturnType<typeof createServer>>();

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pracht-adapter-node-"));
  tempDirs.push(dir);
  return dir;
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

describe("createNodeRequestHandler", () => {
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
});
