import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defineApp } from "@pracht/core";

import { createWebRequest, writeWebResponse } from "../src/bridge.ts";
import { createNodeRequestHandler } from "../src/index.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<number> {
  const server = createServer((req, res) => void handler(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return (server.address() as AddressInfo).port;
}

/** A raw HTTP exchange, so headers fetch would normalise (Host) stay as sent. */
function rawRequest(port: number, lines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.on("data", (chunk: Buffer) => (data += chunk.toString("latin1")));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.end(`${lines.join("\r\n")}\r\n\r\n`);
  });
}

describe("createWebRequest", () => {
  it("answers a declared oversized body with 413 before reading it", async () => {
    let reached = false;
    const port = await listen(async (req, res) => {
      const request = await createWebRequest(req, res, { maxBodySize: 4 });
      if (request instanceof Response) return writeWebResponse(res, request);
      reached = true;
      res.end();
    });

    const response = await fetch(`http://127.0.0.1:${port}/`, { body: "12345", method: "POST" });

    expect(response.status).toBe(413);
    expect(await response.text()).toBe("Payload Too Large");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("connection")).toBe("close");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(reached).toBe(false);
  });

  it("answers a chunked body that outgrows the limit with 413", async () => {
    const port = await listen(async (req, res) => {
      const request = await createWebRequest(req, res, { maxBodySize: 4 });
      if (request instanceof Response) return writeWebResponse(res, request);
      res.end("read");
    });

    const status = await new Promise<number>((resolve, reject) => {
      const client = httpRequest(
        { host: "127.0.0.1", method: "POST", path: "/", port },
        (response) => resolve(response.statusCode ?? 0),
      );
      client.on("error", reject);
      client.write("123");
      client.end("456");
    });

    expect(status).toBe(413);
  });

  it("answers a Host that does not form a URL with 400", async () => {
    const port = await listen(async (req, res) => {
      const request = await createWebRequest(req, res);
      if (request instanceof Response) return writeWebResponse(res, request);
      res.end(request.url);
    });

    const raw = await rawRequest(port, ["GET / HTTP/1.1", "Host: bad host:x", "Connection: close"]);

    expect(raw.startsWith("HTTP/1.1 400")).toBe(true);
    expect(raw.toLowerCase()).toContain("x-content-type-options: nosniff");
  });

  it("restores a base an upstream middleware stripped", async () => {
    const port = await listen(async (req, res) => {
      const request = await createWebRequest(req, res, { base: "/docs/" });
      if (request instanceof Response) return writeWebResponse(res, request);
      res.end(request.url);
    });

    const response = await fetch(`http://127.0.0.1:${port}/guide?x=1`);

    expect(await response.text()).toBe(`http://127.0.0.1:${port}/docs/guide?x=1`);
  });

  it("ignores forwarded headers unless trusted", async () => {
    const urls: string[] = [];
    const port = await listen(async (req, res) => {
      const trusted = req.url === "/trusted";
      const request = await createWebRequest(req, res, { trustProxy: trusted });
      if (request instanceof Response) return writeWebResponse(res, request);
      urls.push(request.url);
      res.end();
    });
    const headers = { "x-forwarded-host": "proxy.example", "x-forwarded-proto": "https" };

    await fetch(`http://127.0.0.1:${port}/plain`, { headers });
    await fetch(`http://127.0.0.1:${port}/trusted`, { headers });

    expect(urls).toEqual([`http://127.0.0.1:${port}/plain`, "https://proxy.example/trusted"]);
  });
});

describe("writeWebResponse", () => {
  it("keeps every Set-Cookie and streams a body larger than the socket buffer", async () => {
    const chunk = new Uint8Array(256 * 1024).fill(97);
    const port = await listen((_req, res) => {
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent++ === 32) controller.close();
          else controller.enqueue(chunk);
        },
      });
      return writeWebResponse(res, new Response(body, { headers }));
    });

    const response = await fetch(`http://127.0.0.1:${port}/`);

    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect((await response.arrayBuffer()).byteLength).toBe(32 * chunk.byteLength);
  });

  it("cancels the body when the client disconnects", async () => {
    let resolveCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => (resolveCancelled = resolve));
    let written: Promise<void> | undefined;
    const port = await listen((_req, res) => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(64 * 1024));
          return new Promise((resolve) => setTimeout(resolve, 5));
        },
        cancel() {
          resolveCancelled();
        },
      });
      written = writeWebResponse(res, new Response(body));
      return written;
    });

    await new Promise<void>((resolve) => {
      const client = httpRequest({ host: "127.0.0.1", path: "/", port }, (response) => {
        response.once("data", () => {
          client.destroy();
          resolve();
        });
      });
      client.on("error", () => {});
      client.end();
    });

    await cancelled;
    await expect(written).resolves.toBeUndefined();
  });
});

describe("Node adapter static paths", () => {
  function startHandler(files: Record<string, string>, headersManifest = {}) {
    const staticDir = mkdtempSync(join(tmpdir(), "pracht-adapter-node-paths-"));
    cleanups.push(() => rmSync(staticDir, { force: true, recursive: true }));
    for (const [name, contents] of Object.entries(files)) {
      mkdirSync(join(staticDir, name, ".."), { recursive: true });
      writeFileSync(join(staticDir, name), contents);
    }
    return listen(
      createNodeRequestHandler({
        app: defineApp({ routes: [] }),
        canonicalOrigin: "http://localhost",
        headersManifest,
        staticDir,
      }),
    );
  }

  it("serves an encoded prerendered page for either escape case, with its headers", async () => {
    const port = await startHandler(
      { "posts/caf%C3%A9/index.html": "<p>café</p>" },
      { "/posts/caf%C3%A9": { "x-page": "cafe" } },
    );

    for (const path of ["/posts/caf%C3%A9", "/posts/caf%c3%a9"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("<p>café</p>");
      expect(response.headers.get("x-page")).toBe("cafe");
    }
  });

  it("serves a public file whose name the URL percent-encodes", async () => {
    const port = await startHandler({ "legal terms.txt": "terms" });

    const response = await fetch(`http://127.0.0.1:${port}/legal%20terms.txt`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("terms");
  });
});
