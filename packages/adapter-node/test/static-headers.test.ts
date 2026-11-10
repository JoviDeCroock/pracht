import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineApp } from "@pracht/core";

import { createNodeRequestHandler } from "../src/index.ts";

const DOCUMENT_HEADERS = {
  "permissions-policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
};

let staticDir: string;
let base: string;
let server: ReturnType<typeof createServer>;

beforeEach(async () => {
  staticDir = mkdtempSync(join(tmpdir(), "pracht-adapter-node-headers-"));
  mkdirSync(join(staticDir, "assets"));
  const files: Record<string, string> = {
    "assets/app-AbCd1234.js": `console.log(1);\n`.repeat(200),
    "assets/app-AbCd1234.js.map": `{"version":3}`,
    "assets/style-AbCd1234.css": `a{color:red}\n`.repeat(200),
    "assets/font-AbCd1234.woff2": "wOF2",
    "assets/logo-AbCd1234.svg": `<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
    "assets/data-AbCd1234.json": `{}`,
    "assets/artifact.js": `console.log(2);`,
    "robots.txt": "User-agent: *",
    "widget.js": `console.log(3);`,
    "index.html": "<!doctype html><p>home</p>",
  };
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(staticDir, name), contents, "utf-8");
  }
  const handler = createNodeRequestHandler({
    app: defineApp({ routes: [] }),
    canonicalOrigin: "http://localhost",
    // A build-recorded policy that makes an asset revalidate.
    headersManifest: { "/assets/artifact.js": { "cache-control": "no-cache" } },
    staticDir,
  });
  server = createServer((req, res) => void handler(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.close();
  await once(server, "close");
  rmSync(staticDir, { force: true, recursive: true });
});

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const response = await fetch(`${base}${path}`, { headers });
  await response.arrayBuffer();
  return response;
}

describe("static file headers", () => {
  it.each([
    ["/assets/app-AbCd1234.js", { "accept-encoding": "br" }],
    ["/assets/style-AbCd1234.css", { "accept-encoding": "br" }],
    ["/assets/style-AbCd1234.css", {}],
    ["/assets/font-AbCd1234.woff2", {}],
    ["/assets/app-AbCd1234.js.map", {}],
  ])("sends %s only the headers an immutable subresource uses", async (path, headers) => {
    const response = await get(path, headers);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("permissions-policy")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBeNull();
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("last-modified")).toBeNull();
  });

  it("keeps the encoding negotiation headers on a compressed asset", async () => {
    const response = await get("/assets/style-AbCd1234.css", { "accept-encoding": "br" });

    expect(response.headers.get("content-type")).toBe("text/css");
    expect(response.headers.get("vary")).toContain("Accept-Encoding");
  });

  it.each([
    ["/", "text/html; charset=utf-8"],
    ["/robots.txt", "text/plain; charset=utf-8"],
    ["/widget.js", "application/javascript"],
    // Document-capable or unlisted types under /assets/ keep their protection.
    ["/assets/logo-AbCd1234.svg", "image/svg+xml"],
    ["/assets/data-AbCd1234.json", "application/json"],
    // An asset whose build headers make it revalidate keeps its validators.
    ["/assets/artifact.js", "application/javascript"],
  ])("sends %s the full default header set", async (path, contentType) => {
    const response = await get(path);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(contentType);
    for (const [name, value] of Object.entries(DOCUMENT_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
    expect(response.headers.get("etag")).not.toBeNull();
    expect(response.headers.get("last-modified")).not.toBeNull();
  });

  it("still answers 304 for a revalidated public file", async () => {
    const first = await get("/robots.txt");
    const revalidated = await get("/robots.txt", { "if-none-match": first.headers.get("etag")! });

    expect(revalidated.status).toBe(304);
  });
});
