import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { h } from "preact";
import { afterEach, describe, expect, it } from "vitest";

import { defineApp, route } from "@pracht/core";

import { createNodeRequestHandler, createNodeServerEntryModule } from "../src/index.ts";

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
  servers.clear();
});

const STYLESHEET_LINK = "</assets/home.css>; rel=preload; as=style";

async function listen(options: { earlyHints?: boolean; loader?: () => unknown }) {
  const handler = createNodeRequestHandler({
    app: defineApp({ routes: [route("/", "./routes/home.tsx")] }),
    canonicalOrigin: "http://localhost",
    cssManifest: { "src/routes/home.tsx": ["/assets/home.css"] },
    earlyHints: options.earlyHints,
    registry: {
      routeModules: {
        "./routes/home.tsx": async () => ({
          Component: () => h("main", null, "Home"),
          loader: options.loader ?? (() => ({})),
        }),
      },
    },
  });
  const server = createServer((req, res) => void handler(req, res));
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

interface Exchange {
  informational: { status: number; link: string | string[] | undefined }[];
  status: number;
  link: string | undefined;
}

function get(port: number, onInformation?: () => void): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const informational: Exchange["informational"] = [];
    const req = httpRequest({ hostname: "127.0.0.1", port, path: "/" }, (res) => {
      res.resume();
      res.on("end", () =>
        resolve({
          informational,
          status: res.statusCode ?? 0,
          link: res.headers.link as string | undefined,
        }),
      );
    });
    req.on("information", (info) => {
      informational.push({ status: info.statusCode, link: info.headers.link });
      onInformation?.();
    });
    req.on("error", reject);
    req.end();
  });
}

describe("Node adapter early hints", () => {
  it("sends a 103 with the page's preloads while the loader is still running", async () => {
    let releaseLoader!: () => void;
    const loaderGate = new Promise<void>((resolve) => (releaseLoader = resolve));
    const port = await listen({ earlyHints: true, loader: () => loaderGate.then(() => ({})) });

    // The loader only finishes once the 103 has reached the client.
    const exchange = await get(port, () => releaseLoader());

    expect(exchange.informational).toEqual([{ status: 103, link: STYLESHEET_LINK }]);
    expect(exchange.status).toBe(200);
    expect(exchange.link).toBe(STYLESHEET_LINK);
  });

  it("sends no 103 by default but keeps the Link header", async () => {
    const port = await listen({});

    const exchange = await get(port);

    expect(exchange.informational).toEqual([]);
    expect(exchange.status).toBe(200);
    expect(exchange.link).toBe(STYLESHEET_LINK);
  });

  it("forwards the option from nodeAdapter() into the generated entry", () => {
    expect(createNodeServerEntryModule({ earlyHints: true })).toContain("earlyHints: true,");
    expect(createNodeServerEntryModule()).not.toContain("earlyHints");
  });
});
