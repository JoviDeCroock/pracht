import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { defineApp, route } from "@pracht/core";

import { createNodeRequestHandler } from "../src/index.ts";

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
  servers.clear();
});

type Middleware = (args: unknown, next: () => Promise<Response>) => Promise<Response>;

async function serve(middleware?: Middleware): Promise<string> {
  const handler = createNodeRequestHandler({
    app: defineApp({
      middleware: middleware ? { wrap: "./middleware/wrap.ts" } : {},
      routes: [
        route("/page", "./routes/page.tsx", {
          middleware: middleware ? ["wrap"] : [],
          render: "ssr",
        }),
      ],
    }),
    registry: {
      middlewareModules: middleware ? { "./middleware/wrap.ts": async () => ({ middleware }) } : {},
      routeModules: {
        "./routes/page.tsx": async () => ({ Component: () => "View → 🙂 ".repeat(2000) }),
      },
    },
  });
  const server = createServer((req, res) => void handler(req, res));
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function rawRequest(
  url: string,
  method = "GET",
): Promise<{ status: number; headers: IncomingMessage["headers"]; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ body: Buffer.concat(chunks), headers: res.headers, status: res.statusCode ?? 0 }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("server-rendered documents", () => {
  it("go out with a Content-Length that matches the UTF-8 body", async () => {
    const base = await serve();

    const response = await rawRequest(`${base}/page`);

    expect(response.status).toBe(200);
    expect(response.headers["transfer-encoding"]).toBeUndefined();
    expect(Number(response.headers["content-length"])).toBe(response.body.byteLength);
    expect(response.body.toString("utf-8")).toContain("View → 🙂 View → 🙂");
  });

  it("send a HEAD response's length without its body", async () => {
    const base = await serve();
    const get = await rawRequest(`${base}/page`);

    const head = await rawRequest(`${base}/page`, "HEAD");

    expect(head.status).toBe(200);
    expect(head.body.byteLength).toBe(0);
    expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
  });

  it("send the body middleware replaced the document with", async () => {
    const base = await serve(async (_args, next) => {
      const response = await next();
      const html = await response.text();
      return new Response(html.replace("<body", '<body data-wrapped=""'), response);
    });

    const response = await rawRequest(`${base}/page`);
    const html = response.body.toString("utf-8");

    expect(html).toContain('data-wrapped=""');
    expect(html).toContain("View → 🙂");
  });

  it("send the document when middleware read a clone of it", async () => {
    let seen = "";
    const base = await serve(async (_args, next) => {
      const response = await next();
      seen = await response.clone().text();
      return response;
    });

    const response = await rawRequest(`${base}/page`);

    expect(response.body.toString("utf-8")).toBe(seen);
    expect(Number(response.headers["content-length"])).toBe(response.body.byteLength);
  });

  it("stream the document when middleware locked its body", async () => {
    const base = await serve(async (_args, next) => {
      const response = await next();
      const reader = response.body!.getReader();
      const body = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
      });
      return new Response(body, response);
    });

    const response = await rawRequest(`${base}/page`);

    expect(response.headers["transfer-encoding"]).toBe("chunked");
    expect(response.body.toString("utf-8")).toContain("View → 🙂");
  });
});
