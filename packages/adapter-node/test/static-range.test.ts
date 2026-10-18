import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineApp } from "@pracht/core";

import { createNodeRequestHandler } from "../src/index.ts";

const FILE_SIZE = 1000;
const fileBytes = Buffer.from(Array.from({ length: FILE_SIZE }, (_, index) => index % 251));

let staticDir: string;
let base: string;
let server: ReturnType<typeof createServer>;

beforeEach(async () => {
  staticDir = mkdtempSync(join(tmpdir(), "pracht-adapter-node-range-"));
  writeFileSync(join(staticDir, "clip.mp4"), fileBytes);
  writeFileSync(join(staticDir, "rows.csv"), fileBytes);
  writeFileSync(join(staticDir, "signed.csv"), fileBytes);
  const handler = createNodeRequestHandler({
    app: defineApp({ routes: [] }),
    canonicalOrigin: "http://localhost",
    // Build-recorded headers that describe the whole file.
    headersManifest: {
      "/rows.csv": { "content-length": String(FILE_SIZE) },
      "/signed.csv": { "content-digest": "sha-256=:AAAA:" },
    },
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

async function get(headers: Record<string, string>, method = "GET", path = "/clip.mp4") {
  const response = await fetch(`${base}${path}`, { headers, method });
  return { response, body: Buffer.from(await response.arrayBuffer()) };
}

describe("static byte ranges", () => {
  it.each([
    ["bytes=0-99", 0, 99],
    ["bytes=900-", 900, 999],
    ["bytes=-10", 990, 999],
    ["bytes=990-5000", 990, 999],
  ])("answers %s with 206 and the requested bytes", async (range, start, end) => {
    const { response, body } = await get({ range });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${FILE_SIZE}`);
    expect(response.headers.get("content-length")).toBe(String(end - start + 1));
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(body.equals(fileBytes.subarray(start, end + 1))).toBe(true);
  });

  it("advertises byte ranges on full responses", async () => {
    const { response, body } = await get({});

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(body.equals(fileBytes)).toBe(true);
  });

  it("answers an unsatisfiable range with 416", async () => {
    const { response, body } = await get({ range: "bytes=5000-" });

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${FILE_SIZE}`);
    expect(body.byteLength).toBe(0);
  });

  it.each(["bytes=0-1,5-6", "items=0-1", "bytes=20-10", "bytes=abc"])(
    "serves the whole file for %s",
    async (range) => {
      const { response, body } = await get({ range });

      expect(response.status).toBe(200);
      expect(body.equals(fileBytes)).toBe(true);
    },
  );

  it("honours If-Range against Last-Modified", async () => {
    const { response: full } = await get({});
    const lastModified = full.headers.get("last-modified")!;

    const current = await get({ range: "bytes=0-9", "if-range": lastModified });
    expect(current.response.status).toBe(206);

    const outdated = await get({
      range: "bytes=0-9",
      "if-range": new Date(Date.parse(lastModified) - 60_000).toUTCString(),
    });
    expect(outdated.response.status).toBe(200);
    expect(outdated.body.equals(fileBytes)).toBe(true);
  });

  it("replaces a recorded Content-Length on partial and unsatisfiable answers", async () => {
    const partial = await get({ range: "bytes=0-9" }, "GET", "/rows.csv");
    expect(partial.response.status).toBe(206);
    expect(partial.response.headers.get("content-length")).toBe("10");
    expect(partial.body.byteLength).toBe(10);

    const unsatisfiable = await get({ range: "bytes=1000-" }, "GET", "/rows.csv");
    expect(unsatisfiable.response.status).toBe(416);
    expect(unsatisfiable.response.headers.get("content-length")).toBe("0");
  });

  it("sends a file with a recorded content digest whole", async () => {
    const { response, body } = await get({ range: "bytes=0-9" }, "GET", "/signed.csv");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-digest")).toBe("sha-256=:AAAA:");
    expect(body.equals(fileBytes)).toBe(true);
  });

  it("does not apply a range to HEAD", async () => {
    const { response } = await get({ range: "bytes=0-9" }, "HEAD");

    expect(response.status).toBe(200);
  });
});
