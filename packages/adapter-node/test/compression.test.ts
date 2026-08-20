import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { brotliDecompressSync, createBrotliDecompress, createGunzip, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineApp, resolveApiRoutes, route, timeRevalidate } from "@pracht/core";

import { createNodeRequestHandler } from "../src/index.ts";
import { writeISGFile } from "../src/node-isg.ts";
import {
  CompressedAssetCache,
  encodeEtagForEncoding,
  isCompressibleContentType,
  mergeVaryValue,
  negotiateEncoding,
  protectIdentityEtag,
} from "../src/node-compress.ts";

const tempDirs: string[] = [];
const servers = new Set<ReturnType<typeof createServer>>();

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pracht-adapter-node-compress-"));
  tempDirs.push(dir);
  return dir;
}

interface RawResponse {
  status: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

/**
 * A raw HTTP request that never advertises `Accept-Encoding` on its own and
 * never decompresses — unlike `fetch`, which does both — so the tests can
 * assert on the exact bytes and headers on the wire.
 */
function rawRequest(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<RawResponse> {
  return new Promise((resolveRequest, reject) => {
    const req = httpRequest(url, { headers, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolveRequest({
          body: Buffer.concat(chunks),
          headers: res.headers,
          status: res.statusCode ?? 0,
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<string> {
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
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const server of servers) {
    server.close();
    await once(server, "close");
  }
  servers.clear();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { force: true, recursive: true });
  }
});

describe("negotiateEncoding", () => {
  it("prefers brotli over gzip", () => {
    expect(negotiateEncoding("gzip, deflate, br")).toBe("br");
    expect(negotiateEncoding("br")).toBe("br");
  });

  it("falls back to gzip when brotli is not acceptable", () => {
    expect(negotiateEncoding("gzip, deflate")).toBe("gzip");
    expect(negotiateEncoding("gzip, br;q=0")).toBe("gzip");
    expect(negotiateEncoding("x-gzip")).toBe("gzip");
  });

  it("returns identity when nothing usable is acceptable", () => {
    expect(negotiateEncoding(null)).toBeNull();
    expect(negotiateEncoding("")).toBeNull();
    expect(negotiateEncoding("identity")).toBeNull();
    expect(negotiateEncoding("deflate, zstd")).toBeNull();
    expect(negotiateEncoding("gzip;q=0, br;q=0")).toBeNull();
  });

  it("honors wildcards and q-values", () => {
    expect(negotiateEncoding("*")).toBe("br");
    expect(negotiateEncoding("*;q=0.5, br;q=0")).toBe("gzip");
    expect(negotiateEncoding("*;q=0")).toBeNull();
  });

  it("prefers the acceptable coding with the highest qvalue (RFC 9110 §12.5.3)", () => {
    expect(negotiateEncoding("gzip;q=1.0, br;q=0.1")).toBe("gzip");
    expect(negotiateEncoding("gzip;q=0.8, br;q=0.9")).toBe("br");
    expect(negotiateEncoding("br;q=0.5, gzip;q=0.5")).toBe("br"); // ties go to brotli
    expect(negotiateEncoding("gzip;q=0.5, *;q=1")).toBe("br"); // wildcard covers br at q=1
    expect(negotiateEncoding("identity;q=0, gzip")).toBe("gzip");
    expect(negotiateEncoding("gzip;q=0.5, identity;q=1, *;q=0")).toBeNull();
    expect(negotiateEncoding("gzip;q=1, identity;q=1, *;q=0")).toBe("gzip");
  });

  it("weakens derived ETags for encoded variants", () => {
    const gzip = encodeEtagForEncoding('"strong-v1"', "gzip");
    const brotli = encodeEtagForEncoding('W/"weak-v1"', "br");

    expect(gzip).toMatch(/^W\/"pracht-gzip-[A-Za-z0-9_-]{43}"$/);
    expect(brotli).toMatch(/^W\/"pracht-br-[A-Za-z0-9_-]{43}"$/);
    expect(encodeEtagForEncoding('W/"strong-v1"', "gzip")).toBe(gzip);
    expect(encodeEtagForEncoding('"release"', "br")).not.toBe('W/"release-br"');
    expect(protectIdentityEtag(gzip)).toMatch(/^W\/"pracht-identity-[A-Za-z0-9_-]{43}"$/);
    expect(protectIdentityEtag('"ordinary"')).toBe('"ordinary"');
  });
});

describe("isCompressibleContentType", () => {
  it("allows text, structured syntax, and well-known application types", () => {
    expect(isCompressibleContentType("text/html; charset=utf-8")).toBe(true);
    expect(isCompressibleContentType("text/css")).toBe(true);
    expect(isCompressibleContentType("application/json")).toBe(true);
    expect(isCompressibleContentType("application/javascript")).toBe(true);
    expect(isCompressibleContentType("image/svg+xml")).toBe(true);
    expect(isCompressibleContentType("application/manifest+json")).toBe(true);
  });

  it("rejects binary media and missing types", () => {
    expect(isCompressibleContentType(null)).toBe(false);
    expect(isCompressibleContentType("image/png")).toBe(false);
    expect(isCompressibleContentType("font/woff2")).toBe(false);
    expect(isCompressibleContentType("application/octet-stream")).toBe(false);
    expect(isCompressibleContentType("video/mp4")).toBe(false);
  });
});

describe("mergeVaryValue", () => {
  it("merges without duplicating and respects wildcards", () => {
    expect(mergeVaryValue(null)).toBe("Accept-Encoding");
    expect(mergeVaryValue("x-pracht-route-state-request")).toBe(
      "x-pracht-route-state-request, Accept-Encoding",
    );
    expect(mergeVaryValue("accept-encoding")).toBe("accept-encoding");
    expect(mergeVaryValue("*")).toBe("*");
  });
});

describe("CompressedAssetCache", () => {
  it("evicts the least recently used entries once over budget", () => {
    const cache = new CompressedAssetCache(10);
    cache.set("a", Buffer.alloc(4));
    cache.set("b", Buffer.alloc(4));
    // Touch "a" so "b" is the eviction candidate.
    expect(cache.get("a")).toBeDefined();
    cache.set("c", Buffer.alloc(4));

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.totalBytes).toBeLessThanOrEqual(10);
  });

  it("never stores an entry larger than its budget", () => {
    const cache = new CompressedAssetCache(10);
    cache.set("huge", Buffer.alloc(64));
    expect(cache.get("huge")).toBeUndefined();
    expect(cache.totalBytes).toBe(0);
  });

  it("deduplicates concurrent compressions of the same key", async () => {
    const cache = new CompressedAssetCache(1024);
    let produced = 0;
    const produce = async (): Promise<Buffer> => {
      produced += 1;
      await new Promise((resolveTick) => setTimeout(resolveTick, 10));
      return Buffer.from("compressed");
    };

    const requests = Array.from({ length: 8 }, () => cache.getOrCompress("asset", 10, produce));
    expect(requests.every(Boolean)).toBe(true);
    const results = await Promise.all(requests as Promise<Buffer>[]);

    expect(produced).toBe(1);
    for (const result of results) expect(result.toString()).toBe("compressed");
    // Later requests hit the stored entry, not `produce`.
    await cache.getOrCompress("asset", 10, produce);
    expect(produced).toBe(1);
  });

  it("bounds the source bytes retained by distinct in-flight compressions", async () => {
    const cache = new CompressedAssetCache(10, 8);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseGate = resolveGate;
    });
    const produce = async (value: string): Promise<Buffer> => {
      await gate;
      return Buffer.from(value);
    };

    const first = cache.getOrCompress("a", 6, () => produce("a"));
    expect(first).not.toBeNull();

    const second = cache.getOrCompress("b", 4, () => produce("b"));
    expect(second).not.toBeNull();
    // The pending byte budget is full even though concurrency remains.
    expect(cache.getOrCompress("c", 1, () => produce("c"))).toBeNull();

    releaseGate();
    await Promise.all([first!, second!]);

    // Once pending work drains, a new cold key can use the buffered path.
    await expect(cache.getOrCompress("c", 1, async () => Buffer.from("c"))).resolves.toEqual(
      Buffer.from("c"),
    );
  });

  it("caps distinct in-flight jobs without blocking same-key waiters", async () => {
    const cache = new CompressedAssetCache(100, 2);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseGate = resolveGate;
    });
    const produce = async (value: string): Promise<Buffer> => {
      await gate;
      return Buffer.from(value);
    };

    const first = cache.getOrCompress("a", 1, () => produce("a"));
    const second = cache.getOrCompress("b", 1, () => produce("b"));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(cache.getOrCompress("a", 1, () => produce("duplicate"))).toBe(first);
    expect(cache.getOrCompress("c", 1, () => produce("c"))).toBeNull();

    releaseGate();
    await Promise.all([first!, second!]);
  });

  it("does not cache a failed compression and lets the next request retry", async () => {
    const cache = new CompressedAssetCache(1024);
    let calls = 0;
    const failThenSucceed = async (): Promise<Buffer> => {
      calls += 1;
      if (calls === 1) throw new Error("EIO");
      return Buffer.from("ok");
    };

    await expect(cache.getOrCompress("asset", 2, failThenSucceed)).rejects.toThrow("EIO");
    await expect(cache.getOrCompress("asset", 2, failThenSucceed)).resolves.toBeDefined();
    expect(calls).toBe(2);
  });

  it("bounds source bytes read by distinct in-flight validator hashes", async () => {
    const cache = new CompressedAssetCache(10, 8);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseGate = resolveGate;
    });
    const produce = async (value: string): Promise<string> => {
      await gate;
      return value;
    };

    const first = cache.getOrCreateFileEtag("a", 6, () => produce('W/"a"'));
    const second = cache.getOrCreateFileEtag("b", 4, () => produce('W/"b"'));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(cache.getOrCreateFileEtag("c", 1, () => produce('W/"c"'))).toBeNull();

    releaseGate();
    await Promise.all([first!, second!]);

    await expect(cache.getOrCreateFileEtag("c", 1, async () => 'W/"c"')).resolves.toBe('W/"c"');
  });

  it("caps distinct validator hashes without blocking same-key waiters", async () => {
    const cache = new CompressedAssetCache(100, 2);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseGate = resolveGate;
    });
    const produce = async (value: string): Promise<string> => {
      await gate;
      return value;
    };

    const first = cache.getOrCreateFileEtag("a", 1, () => produce('W/"a"'));
    const second = cache.getOrCreateFileEtag("b", 1, () => produce('W/"b"'));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(cache.getOrCreateFileEtag("a", 1, () => produce('W/"duplicate"'))).toBe(first);
    expect(cache.getOrCreateFileEtag("c", 1, () => produce('W/"c"'))).toBeNull();

    releaseGate();
    await Promise.all([first!, second!]);
  });
});

describe("dynamic response compression", () => {
  const longText = "Pracht compresses dynamic documents. ".repeat(100);

  function createSsrHandler(options?: { compression?: boolean }) {
    return createNodeRequestHandler({
      app: defineApp({ routes: [route("/page", "./routes/page.tsx", { render: "ssr" })] }),
      compression: options?.compression,
      registry: {
        routeModules: {
          "./routes/page.tsx": async () => ({
            Component: () => longText,
          }),
        },
      },
    });
  }

  it("streams brotli-compressed HTML when the client accepts it", async () => {
    const base = await listen(createSsrHandler());

    const response = await rawRequest(`${base}/page`, { "accept-encoding": "gzip, br" });

    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe("br");
    expect(response.headers["content-length"]).toBeUndefined();
    expect(response.headers.vary).toContain("Accept-Encoding");
    expect(brotliDecompressSync(response.body).toString("utf-8")).toContain(
      "Pracht compresses dynamic documents.",
    );
  });

  it("falls back to gzip when brotli is not accepted", async () => {
    const base = await listen(createSsrHandler());

    const response = await rawRequest(`${base}/page`, { "accept-encoding": "gzip" });

    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(response.body).toString("utf-8")).toContain(
      "Pracht compresses dynamic documents.",
    );
  });

  it("serves identity with Vary when the client sends no Accept-Encoding", async () => {
    const base = await listen(createSsrHandler());

    const response = await rawRequest(`${base}/page`);

    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers.vary).toContain("Accept-Encoding");
    expect(response.body.toString("utf-8")).toContain("Pracht compresses dynamic documents.");
  });

  it("compresses route-state JSON for client navigations", async () => {
    const base = await listen(
      createNodeRequestHandler({
        app: defineApp({ routes: [route("/data", "./routes/data.tsx", { render: "ssr" })] }),
        registry: {
          routeModules: {
            "./routes/data.tsx": async () => ({
              Component: () => "ok",
              loader: async () => ({ rows: Array.from({ length: 200 }, (_, i) => `row-${i}`) }),
            }),
          },
        },
      }),
    );

    const response = await rawRequest(`${base}/data`, {
      "accept-encoding": "br",
      "x-pracht-route-state-request": "1",
    });

    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["content-encoding"]).toBe("br");
    expect(response.headers.vary).toContain("Accept-Encoding");
    const payload = JSON.parse(brotliDecompressSync(response.body).toString("utf-8"));
    expect(payload.data.rows).toHaveLength(200);
  });

  it("does not compress non-compressible content types", async () => {
    const base = await listen(
      createNodeRequestHandler({
        apiRoutes: resolveApiRoutes(["/src/api/binary.ts"]),
        app: defineApp({ routes: [] }),
        registry: {
          apiModules: {
            "/src/api/binary.ts": async () => ({
              GET: async () =>
                new Response(Buffer.alloc(4096, 7), {
                  headers: { "content-type": "application/octet-stream" },
                }),
            }),
          },
        },
      }),
    );

    const response = await rawRequest(`${base}/api/binary`, { "accept-encoding": "br, gzip" });

    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers.vary ?? "").not.toContain("Accept-Encoding");
    expect(response.body.byteLength).toBe(4096);
  });

  it("never double-compresses an already-encoded response", async () => {
    const base = await listen(
      createNodeRequestHandler({
        apiRoutes: resolveApiRoutes(["/src/api/pre.ts"]),
        app: defineApp({ routes: [] }),
        registry: {
          apiModules: {
            "/src/api/pre.ts": async () => ({
              GET: async () =>
                new Response("pretend-gzipped-bytes", {
                  headers: {
                    "content-encoding": "gzip",
                    "content-type": "text/plain",
                  },
                }),
            }),
          },
        },
      }),
    );

    const response = await rawRequest(`${base}/api/pre`, { "accept-encoding": "br" });

    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.body.toString("utf-8")).toBe("pretend-gzipped-bytes");
  });

  it("respects Cache-Control: no-transform", async () => {
    const base = await listen(
      createNodeRequestHandler({
        apiRoutes: resolveApiRoutes(["/src/api/raw.ts"]),
        app: defineApp({ routes: [] }),
        registry: {
          apiModules: {
            "/src/api/raw.ts": async () => ({
              GET: async () =>
                new Response("x".repeat(4096), {
                  headers: {
                    "cache-control": "public, no-transform",
                    "content-type": "text/plain",
                  },
                }),
            }),
          },
        },
      }),
    );

    const response = await rawRequest(`${base}/api/raw`, { "accept-encoding": "br, gzip" });

    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.body.byteLength).toBe(4096);
  });

  it("preserves conditional headers for Range responses that are never compressed", async () => {
    let receivedIfNoneMatch: string | null = null;
    const identityEtag = '"range-v1"';
    const base = await listen(
      createNodeRequestHandler({
        apiRoutes: resolveApiRoutes(["/src/api/range.ts"]),
        app: defineApp({ routes: [] }),
        registry: {
          apiModules: {
            "/src/api/range.ts": async () => ({
              GET: async ({ request }) => {
                receivedIfNoneMatch = request.headers.get("if-none-match");
                if (receivedIfNoneMatch === identityEtag) {
                  return new Response(null, { status: 304, headers: { etag: identityEtag } });
                }
                return new Response("part", {
                  status: 206,
                  headers: {
                    "content-range": "bytes 0-3/10",
                    "content-type": "text/plain",
                    etag: identityEtag,
                  },
                });
              },
            }),
          },
        },
      }),
    );

    const response = await rawRequest(`${base}/api/range`, {
      "accept-encoding": "gzip",
      "if-none-match": identityEtag,
      range: "bytes=0-3",
    });

    expect(receivedIfNoneMatch).toBe(identityEtag);
    expect(response.status).toBe(304);
    expect(response.headers["content-range"]).toBeUndefined();
  });

  it("keeps ignored Range requests identity-encoded before application validation", async () => {
    const identityEtag = '"ignored-range-v1"';
    const received: Array<{ etag: string | null; range: string | null }> = [];
    const base = await listen(
      createNodeRequestHandler({
        apiRoutes: resolveApiRoutes(["/src/api/ignored-range.ts"]),
        app: defineApp({ routes: [] }),
        registry: {
          apiModules: {
            "/src/api/ignored-range.ts": async () => ({
              GET: async ({ request }) => {
                received.push({
                  etag: request.headers.get("if-none-match"),
                  range: request.headers.get("range"),
                });
                if (request.headers.get("if-none-match") === identityEtag) {
                  return new Response(null, { status: 304, headers: { etag: identityEtag } });
                }
                return new Response("ignored range payload ".repeat(300), {
                  headers: { etag: identityEtag, "content-type": "text/plain" },
                });
              },
            }),
          },
        },
      }),
    );

    const ranged = await rawRequest(`${base}/api/ignored-range`, {
      "accept-encoding": "gzip",
      range: "not-a-valid-range",
    });
    const revalidated = await rawRequest(`${base}/api/ignored-range`, {
      "accept-encoding": "gzip",
      "if-none-match": identityEtag,
      range: "not-a-valid-range",
    });
    const ordinary = await rawRequest(`${base}/api/ignored-range`, {
      "accept-encoding": "gzip",
    });

    expect(ranged.status).toBe(200);
    expect(ranged.headers["content-encoding"]).toBeUndefined();
    expect(ranged.headers.etag).toBe(identityEtag);
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.etag).toBe(identityEtag);
    expect(ordinary.headers["content-encoding"]).toBe("gzip");
    expect(ordinary.headers.etag).toBe(encodeEtagForEncoding(identityEtag, "gzip"));
    expect(received).toEqual([
      { etag: null, range: "not-a-valid-range" },
      { etag: identityEtag, range: "not-a-valid-range" },
      { etag: null, range: null },
    ]);
  });

  it.each(["content-digest", "repr-digest", "digest", "content-md5"])(
    "preserves identity encoding when a response carries %s",
    async (integrityHeader) => {
      const body = "integrity-protected payload ".repeat(200);
      const base = await listen(
        createNodeRequestHandler({
          apiRoutes: resolveApiRoutes(["/src/api/integrity.ts"]),
          app: defineApp({ routes: [] }),
          registry: {
            apiModules: {
              "/src/api/integrity.ts": async () => ({
                GET: async () =>
                  new Response(body, {
                    headers: {
                      "content-type": "text/plain",
                      [integrityHeader]: "identity-digest",
                    },
                  }),
              }),
            },
          },
        }),
      );

      const response = await rawRequest(`${base}/api/integrity`, { "accept-encoding": "br" });

      expect(response.headers["content-encoding"]).toBeUndefined();
      expect(response.headers[integrityHeader]).toBe("identity-digest");
      expect(response.body.toString("utf-8")).toBe(body);
    },
  );

  it("skips tiny bodies when the Content-Length is known", async () => {
    const base = await listen(
      createNodeRequestHandler({
        apiRoutes: resolveApiRoutes(["/src/api/tiny.ts"]),
        app: defineApp({ routes: [] }),
        registry: {
          apiModules: {
            "/src/api/tiny.ts": async () => ({
              GET: async () =>
                new Response("ok", {
                  headers: { "content-length": "2", "content-type": "text/plain" },
                }),
            }),
          },
        },
      }),
    );

    const response = await rawRequest(`${base}/api/tiny`, { "accept-encoding": "br, gzip" });

    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers.vary).toContain("Accept-Encoding");
    expect(response.body.toString("utf-8")).toBe("ok");
  });

  it("merges Accept-Encoding into an existing Vary header", async () => {
    const base = await listen(
      createNodeRequestHandler({
        apiRoutes: resolveApiRoutes(["/src/api/vary.ts"]),
        app: defineApp({ routes: [] }),
        registry: {
          apiModules: {
            "/src/api/vary.ts": async () => ({
              GET: async () =>
                new Response("y".repeat(4096), {
                  headers: { "content-type": "text/plain", vary: "Accept" },
                }),
            }),
          },
        },
      }),
    );

    const response = await rawRequest(`${base}/api/vary`, { "accept-encoding": "gzip" });

    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers.vary).toContain("Accept");
    expect(response.headers.vary).toContain("Accept-Encoding");
  });

  it("revalidates an encoding-specific dynamic ETag", async () => {
    const identityEtag = '"dynamic-v1"';
    const base = await listen(
      createNodeRequestHandler({
        apiRoutes: resolveApiRoutes(["/src/api/etag.ts"]),
        app: defineApp({ routes: [] }),
        registry: {
          apiModules: {
            "/src/api/etag.ts": async () => ({
              GET: async ({ request }) =>
                request.headers.get("if-none-match") === identityEtag
                  ? new Response(null, {
                      status: 304,
                      headers: { etag: identityEtag },
                    })
                  : new Response("etag payload ".repeat(300), {
                      headers: { etag: identityEtag, "content-type": "text/plain" },
                    }),
            }),
          },
        },
      }),
    );

    const identity = await rawRequest(`${base}/api/etag`);
    const crossEncoding = await rawRequest(`${base}/api/etag`, {
      "accept-encoding": "gzip",
      "if-none-match": identity.headers.etag!,
    });
    const first = await rawRequest(`${base}/api/etag`, { "accept-encoding": "gzip" });
    const revalidated = await rawRequest(`${base}/api/etag`, {
      "accept-encoding": "gzip",
      "if-none-match": first.headers.etag!,
    });

    expect(identity.headers.etag).toBe(identityEtag);
    expect(crossEncoding.status).toBe(200);
    expect(crossEncoding.headers["content-encoding"]).toBe("gzip");
    expect(crossEncoding.headers.etag).toBe(encodeEtagForEncoding(identityEtag, "gzip"));
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBe(encodeEtagForEncoding(identityEtag, "gzip"));
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.etag).toBe(first.headers.etag);
    expect(revalidated.headers.vary).toContain("Accept-Encoding");
    expect(revalidated.body.byteLength).toBe(0);
  });

  it("evaluates If-Match against the selected dynamic representation", async () => {
    const identityEtag = '"match-v1"';
    const receivedPreconditions: Array<{ match: string | null; unmodified: string | null }> = [];
    const base = await listen(
      createNodeRequestHandler({
        apiRoutes: resolveApiRoutes(["/src/api/match.ts"]),
        app: defineApp({ routes: [] }),
        registry: {
          apiModules: {
            "/src/api/match.ts": async () => ({
              GET: async ({ request }) => {
                const match = request.headers.get("if-match");
                receivedPreconditions.push({
                  match,
                  unmodified: request.headers.get("if-unmodified-since"),
                });
                if (match && match !== identityEtag && match !== "*") {
                  return new Response("precondition failed", { status: 412 });
                }
                return new Response("match payload ".repeat(300), {
                  headers: {
                    ...(new URL(request.url).searchParams.has("identity")
                      ? { "cache-control": "no-transform" }
                      : {}),
                    etag: identityEtag,
                    "last-modified": "Fri, 15 Aug 2025 00:00:00 GMT",
                    "content-type": "text/plain",
                  },
                });
              },
            }),
          },
        },
      }),
    );

    const crossEncoding = await rawRequest(`${base}/api/match`, {
      "accept-encoding": "gzip",
      "if-match": identityEtag,
    });
    const wildcard = await rawRequest(`${base}/api/match`, {
      "accept-encoding": "gzip",
      "if-match": "*",
      "if-unmodified-since": "Thu, 01 Jan 1970 00:00:00 GMT",
    });
    const selectedIdentity = await rawRequest(`${base}/api/match?identity=1`, {
      "accept-encoding": "gzip",
      "if-match": identityEtag,
    });
    const weakIdentityMatch = await rawRequest(`${base}/api/match?identity=1`, {
      "accept-encoding": "gzip",
      "if-match": `W/${identityEtag}`,
    });

    expect(crossEncoding.status).toBe(412);
    expect(crossEncoding.headers.etag).toBe(encodeEtagForEncoding(identityEtag, "gzip"));
    expect(crossEncoding.headers["content-encoding"]).toBeUndefined();
    expect(crossEncoding.headers["cache-control"]).toBe("no-store");
    expect(crossEncoding.body.byteLength).toBe(0);

    expect(wildcard.status).toBe(200);
    expect(wildcard.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(wildcard.body).toString("utf-8")).toContain("match payload");

    expect(selectedIdentity.status).toBe(200);
    expect(selectedIdentity.headers["content-encoding"]).toBeUndefined();
    expect(selectedIdentity.headers.etag).toBe(identityEtag);
    expect(selectedIdentity.body.toString("utf-8")).toContain("match payload");

    expect(weakIdentityMatch.status).toBe(412);
    expect(weakIdentityMatch.headers["content-encoding"]).toBeUndefined();
    expect(weakIdentityMatch.body.byteLength).toBe(0);
    expect(receivedPreconditions).toEqual([
      { match: null, unmodified: null },
      { match: null, unmodified: null },
      { match: null, unmodified: null },
      { match: null, unmodified: null },
    ]);
  });

  it("revalidates encoded ETags for successful non-200 responses", async () => {
    const identityEtag = '"non-authoritative-v1"';
    const base = await listen(
      createNodeRequestHandler({
        apiRoutes: resolveApiRoutes(["/src/api/non-authoritative.ts"]),
        app: defineApp({ routes: [] }),
        registry: {
          apiModules: {
            "/src/api/non-authoritative.ts": async () => ({
              GET: async () =>
                new Response("non-authoritative payload ".repeat(300), {
                  status: 203,
                  headers: { etag: identityEtag, "content-type": "text/plain" },
                }),
            }),
          },
        },
      }),
    );

    const first = await rawRequest(`${base}/api/non-authoritative`, {
      "accept-encoding": "gzip",
    });
    const revalidated = await rawRequest(`${base}/api/non-authoritative`, {
      "accept-encoding": "gzip",
      "if-none-match": first.headers.etag!,
    });

    expect(first.status).toBe(203);
    expect(first.headers["content-encoding"]).toBe("gzip");
    expect(first.headers.etag).toBe(encodeEtagForEncoding(identityEtag, "gzip"));
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.etag).toBe(first.headers.etag);
    expect(revalidated.body.byteLength).toBe(0);
  });

  it("drops partial-response metadata when revalidating a successful 206", async () => {
    const identityEtag = '"partial-v1"';
    const base = await listen(
      createNodeRequestHandler({
        apiRoutes: resolveApiRoutes(["/src/api/partial.ts"]),
        app: defineApp({ routes: [] }),
        registry: {
          apiModules: {
            "/src/api/partial.ts": async () => ({
              GET: async () =>
                new Response("part", {
                  status: 206,
                  headers: {
                    "content-range": "bytes 0-3/10",
                    "content-type": "text/plain",
                    etag: identityEtag,
                  },
                }),
            }),
          },
        },
      }),
    );

    const first = await rawRequest(`${base}/api/partial`, {
      "accept-encoding": "gzip",
    });
    const revalidated = await rawRequest(`${base}/api/partial`, {
      "accept-encoding": "gzip",
      "if-none-match": first.headers.etag!,
    });

    expect(first.status).toBe(206);
    expect(first.headers["content-range"]).toBe("bytes 0-3/10");
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers["content-range"]).toBeUndefined();
    expect(revalidated.body.byteLength).toBe(0);
  });

  it("keeps Accept-Encoding in Vary on an application-generated identity 304", async () => {
    const identityEtag = '"identity-v1"';
    const base = await listen(
      createNodeRequestHandler({
        apiRoutes: resolveApiRoutes(["/src/api/identity-304.ts"]),
        app: defineApp({ routes: [] }),
        registry: {
          apiModules: {
            "/src/api/identity-304.ts": async () => ({
              GET: async ({ request }) =>
                request.headers.get("if-none-match") === identityEtag
                  ? new Response(null, { status: 304, headers: { etag: identityEtag } })
                  : new Response("identity payload ".repeat(300), {
                      headers: { etag: identityEtag, "content-type": "text/plain" },
                    }),
            }),
          },
        },
      }),
    );

    const first = await rawRequest(`${base}/api/identity-304`);
    const revalidated = await rawRequest(`${base}/api/identity-304`, {
      "if-none-match": identityEtag,
    });

    expect(first.headers.vary).toContain("Accept-Encoding");
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.vary).toContain("Accept-Encoding");
  });

  it("evaluates If-Modified-Since after selecting the dynamic encoding", async () => {
    const identityEtag = '"modified-v1"';
    const lastModified = "Fri, 15 Aug 2025 00:00:00 GMT";
    const receivedConditionalHeaders: Array<{ etag: boolean; modified: boolean }> = [];
    const base = await listen(
      createNodeRequestHandler({
        apiRoutes: resolveApiRoutes(["/src/api/modified.ts"]),
        app: defineApp({ routes: [] }),
        registry: {
          apiModules: {
            "/src/api/modified.ts": async () => ({
              GET: async ({ request }) => {
                const conditional = {
                  etag: request.headers.has("if-none-match"),
                  modified: request.headers.has("if-modified-since"),
                };
                receivedConditionalHeaders.push(conditional);
                if (conditional.modified) {
                  return new Response(null, {
                    status: 304,
                    headers: { etag: identityEtag, "last-modified": lastModified },
                  });
                }
                return new Response("modified payload ".repeat(300), {
                  headers: {
                    etag: identityEtag,
                    "last-modified": lastModified,
                    "content-type": "text/plain",
                  },
                });
              },
            }),
          },
        },
      }),
    );

    const first = await rawRequest(`${base}/api/modified`, { "accept-encoding": "gzip" });
    const revalidated = await rawRequest(`${base}/api/modified`, {
      "accept-encoding": "gzip",
      "if-modified-since": lastModified,
    });

    expect(first.headers.etag).toBe(encodeEtagForEncoding(identityEtag, "gzip"));
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.etag).toBe(first.headers.etag);
    expect(revalidated.headers.vary).toContain("Accept-Encoding");
    expect(revalidated.body.byteLength).toBe(0);
    expect(receivedConditionalHeaders).toEqual([
      { etag: false, modified: false },
      { etag: false, modified: false },
    ]);
  });

  it("revalidates encoded ETags whose opaque tag contains a comma", async () => {
    const base = await listen(
      createNodeRequestHandler({
        apiRoutes: resolveApiRoutes(["/src/api/comma-etag.ts"]),
        app: defineApp({ routes: [] }),
        registry: {
          apiModules: {
            "/src/api/comma-etag.ts": async () => ({
              GET: async () =>
                new Response("comma etag payload ".repeat(300), {
                  headers: { etag: '"release,1"', "content-type": "text/plain" },
                }),
            }),
          },
        },
      }),
    );

    const first = await rawRequest(`${base}/api/comma-etag`, { "accept-encoding": "gzip" });
    const revalidated = await rawRequest(`${base}/api/comma-etag`, {
      "accept-encoding": "gzip",
      "if-none-match": first.headers.etag!,
    });

    expect(first.headers.etag).toBe(encodeEtagForEncoding('"release,1"', "gzip"));
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.etag).toBe(first.headers.etag);
  });

  it("uses the GET representation metadata for dynamic HEAD responses", async () => {
    const headers = { etag: 'W/"head-v1"', "content-type": "text/plain" };
    const base = await listen(
      createNodeRequestHandler({
        apiRoutes: resolveApiRoutes(["/src/api/head.ts"]),
        app: defineApp({ routes: [] }),
        registry: {
          apiModules: {
            "/src/api/head.ts": async () => ({
              GET: async () => new Response("head payload ".repeat(300), { headers }),
              HEAD: async () => new Response(null, { headers }),
            }),
          },
        },
      }),
    );

    const get = await rawRequest(`${base}/api/head`, { "accept-encoding": "br" });
    const head = await rawRequest(`${base}/api/head`, { "accept-encoding": "br" }, "HEAD");

    expect(head.status).toBe(200);
    expect(head.headers["content-encoding"]).toBe(get.headers["content-encoding"]);
    expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
    expect(head.headers.etag).toBe(get.headers.etag);
    expect(head.body.byteLength).toBe(0);
  });

  it("does not alias an encoded validator with a later identity ETag", async () => {
    let identityEtag = '"release"';
    let body = "first ".repeat(800);
    const base = await listen(
      createNodeRequestHandler({
        apiRoutes: resolveApiRoutes(["/src/api/collision.ts"]),
        app: defineApp({ routes: [] }),
        registry: {
          apiModules: {
            "/src/api/collision.ts": async () => ({
              GET: async ({ request }) =>
                request.headers.get("if-none-match") === identityEtag
                  ? new Response(null, { status: 304, headers: { etag: identityEtag } })
                  : new Response(body, {
                      headers: { etag: identityEtag, "content-type": "text/plain" },
                    }),
            }),
          },
        },
      }),
    );

    const encoded = await rawRequest(`${base}/api/collision`, { "accept-encoding": "br" });
    identityEtag = encoded.headers.etag!;
    body = "second ".repeat(800);
    const identity = await rawRequest(`${base}/api/collision`, {
      "accept-encoding": "identity",
      "if-none-match": encoded.headers.etag!,
    });

    expect(identity.status).toBe(200);
    expect(identity.headers.etag).toBe(protectIdentityEtag(identityEtag));
    expect(identity.headers.etag).not.toBe(encoded.headers.etag);
    expect(identity.body.toString("utf-8")).toBe(body);
  });

  it("keeps a matching 304 when response-body cancellation rejects", async () => {
    const identityEtag = '"cancel-v1"';
    const base = await listen(
      createNodeRequestHandler({
        apiRoutes: resolveApiRoutes(["/src/api/cancel.ts"]),
        app: defineApp({ routes: [] }),
        registry: {
          apiModules: {
            "/src/api/cancel.ts": async () => ({
              GET: async () =>
                new Response(
                  new ReadableStream({
                    cancel() {
                      throw new Error("cancel failed");
                    },
                    start(controller) {
                      controller.enqueue(new TextEncoder().encode("payload ".repeat(400)));
                    },
                  }),
                  { headers: { etag: identityEtag, "content-type": "text/plain" } },
                ),
            }),
          },
        },
      }),
    );

    const response = await rawRequest(`${base}/api/cancel`, {
      "accept-encoding": "gzip",
      "if-none-match": encodeEtagForEncoding(identityEtag, "gzip"),
    });

    expect(response.status).toBe(304);
    expect(response.body.byteLength).toBe(0);
  });

  it("keeps a streamed multi-chunk body intact through the compressor", async () => {
    const chunks = Array.from({ length: 32 }, (_, i) => `chunk-${i}-${"z".repeat(256)}\n`);
    const base = await listen(
      createNodeRequestHandler({
        apiRoutes: resolveApiRoutes(["/src/api/stream.ts"]),
        app: defineApp({ routes: [] }),
        registry: {
          apiModules: {
            "/src/api/stream.ts": async () => ({
              GET: async () =>
                new Response(
                  new ReadableStream({
                    async start(controller) {
                      for (const chunk of chunks) {
                        controller.enqueue(new TextEncoder().encode(chunk));
                        await new Promise((resolveTick) => setTimeout(resolveTick, 1));
                      }
                      controller.close();
                    },
                  }),
                  { headers: { "content-type": "text/plain" } },
                ),
            }),
          },
        },
      }),
    );

    const response = await rawRequest(`${base}/api/stream`, { "accept-encoding": "gzip" });

    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(response.body).toString("utf-8")).toBe(chunks.join(""));
  });

  for (const [encoding, createDecompressor] of [
    ["gzip", createGunzip],
    ["br", createBrotliDecompress],
  ] as const) {
    it(`delivers ${encoding}-compressed SSE events incrementally, not at stream end`, async () => {
      // The producer holds the stream open until the test observes the first
      // event on the wire. Without per-chunk flushing the compressor sits on
      // the event (brotli emits zero bytes, gzip only its header) and this
      // deadlocks: the event would only surface when the stream closes.
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolveGate) => {
        releaseGate = resolveGate;
      });

      const base = await listen(
        createNodeRequestHandler({
          apiRoutes: resolveApiRoutes(["/src/api/events.ts"]),
          app: defineApp({ routes: [] }),
          registry: {
            apiModules: {
              "/src/api/events.ts": async () => ({
                GET: async () =>
                  new Response(
                    new ReadableStream({
                      async start(controller) {
                        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
                        await gate;
                        controller.enqueue(new TextEncoder().encode("data: second\n\n"));
                        controller.close();
                      },
                    }),
                    { headers: { "content-type": "text/event-stream" } },
                  ),
              }),
            },
          },
        }),
      );

      let openRequest: ReturnType<typeof httpRequest> | undefined;
      const firstEventWhileOpen = await new Promise<string>((resolveProbe, reject) => {
        const timeout = setTimeout(() => {
          releaseGate();
          reject(new Error("first SSE event was not delivered while the stream was open"));
        }, 3000);
        const req = httpRequest(
          `${base}/api/events`,
          { headers: { "accept-encoding": encoding } },
          (res) => {
            expect(res.headers["content-encoding"]).toBe(encoding);
            const decompressor = createDecompressor();
            let decompressed = "";
            let observed = false;
            decompressor.on("data", (chunk: Buffer) => {
              decompressed += chunk.toString("utf-8");
              if (!observed && decompressed.includes("data: first\n\n")) {
                observed = true;
                clearTimeout(timeout);
                resolveProbe(decompressed);
                releaseGate();
              }
            });
            decompressor.on("error", reject);
            res.pipe(decompressor);
          },
        );
        req.on("error", reject);
        req.end();
        openRequest = req;
      });

      // Tear the client connection down so server close in `afterEach` does
      // not wait out the keep-alive window of a socket the test is done with.
      openRequest?.destroy();
      releaseGate();

      expect(firstEventWhileOpen).toContain("data: first");
      expect(firstEventWhileOpen).not.toContain("data: second");
    });
  }

  it("can be disabled entirely with compression: false", async () => {
    const base = await listen(createSsrHandler({ compression: false }));

    const response = await rawRequest(`${base}/page`, { "accept-encoding": "br, gzip" });

    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers.vary ?? "").not.toContain("Accept-Encoding");
    expect(response.body.toString("utf-8")).toContain("Pracht compresses dynamic documents.");
  });
});

describe("static asset compression", () => {
  function createStaticHandler(options?: { compression?: boolean }): {
    handler: ReturnType<typeof createNodeRequestHandler>;
  } {
    const staticDir = makeTempDir();
    mkdirSync(join(staticDir, "assets"), { recursive: true });
    writeFileSync(
      join(staticDir, "assets", "app.js"),
      `// pracht\n${'console.log("payload");\n'.repeat(300)}`,
      "utf-8",
    );
    writeFileSync(join(staticDir, "assets", "tiny.css"), "a{color:red}", "utf-8");
    writeFileSync(join(staticDir, "assets", "pixel.png"), Buffer.alloc(4096, 3));
    writeFileSync(join(staticDir, "assets", "module.wasm"), Buffer.alloc(4096, 5));
    writeFileSync(
      join(staticDir, "index.html"),
      `<html><body>${"<p>prerendered</p>".repeat(200)}</body></html>`,
      "utf-8",
    );

    const handler = createNodeRequestHandler({
      app: defineApp({ routes: [] }),
      compression: options?.compression,
      staticDir,
    });
    return { handler };
  }

  it("serves brotli-compressed assets with a distinct weak ETag", async () => {
    const { handler } = createStaticHandler();
    const base = await listen(handler);

    const identity = await rawRequest(`${base}/assets/app.js`);
    const compressed = await rawRequest(`${base}/assets/app.js`, {
      "accept-encoding": "gzip, br",
    });

    expect(compressed.status).toBe(200);
    expect(compressed.headers["content-encoding"]).toBe("br");
    expect(compressed.headers["content-type"]).toBe("application/javascript");
    expect(compressed.headers.vary).toContain("Accept-Encoding");
    expect(compressed.headers["content-length"]).toBe(String(compressed.body.byteLength));
    expect(compressed.body.byteLength).toBeLessThan(identity.body.byteLength);
    expect(brotliDecompressSync(compressed.body).toString("utf-8")).toBe(
      identity.body.toString("utf-8"),
    );

    // Encoded variants must not share a validator with identity.
    expect(identity.headers.etag).toBeDefined();
    expect(compressed.headers.etag).toBe(encodeEtagForEncoding(identity.headers.etag!, "br"));
  });

  it("answers 304 against the encoded variant's ETag", async () => {
    const { handler } = createStaticHandler();
    const base = await listen(handler);

    const compressed = await rawRequest(`${base}/assets/app.js`, { "accept-encoding": "br" });
    const revalidated = await rawRequest(`${base}/assets/app.js`, {
      "accept-encoding": "br",
      "if-none-match": compressed.headers.etag!,
    });

    expect(revalidated.status).toBe(304);
    expect(revalidated.body.byteLength).toBe(0);

    // The identity ETag does not validate the encoded variant.
    const identity = await rawRequest(`${base}/assets/app.js`);
    const crossEncoding = await rawRequest(`${base}/assets/app.js`, {
      "accept-encoding": "br",
      "if-modified-since": "Thu, 01 Jan 1970 00:00:00 GMT",
      "if-none-match": identity.headers.etag!,
    });
    expect(crossEncoding.status).toBe(200);
    expect(crossEncoding.headers["content-encoding"]).toBe("br");
  });

  it("keeps static validators stable across replica-local file copies", async () => {
    const source = `// replica\n${'console.log("stable");\n'.repeat(300)}`;
    const fixedTimestamp = new Date(Math.floor(Date.now() / 1000) * 1000);
    const createReplica = (): string => {
      const staticDir = makeTempDir();
      const assetDir = join(staticDir, "assets");
      const assetPath = join(assetDir, "app.js");
      mkdirSync(assetDir, { recursive: true });
      writeFileSync(assetPath, source, "utf-8");
      utimesSync(assetPath, fixedTimestamp, fixedTimestamp);
      return staticDir;
    };

    const firstBase = await listen(
      createNodeRequestHandler({ app: defineApp({ routes: [] }), staticDir: createReplica() }),
    );
    const secondBase = await listen(
      createNodeRequestHandler({ app: defineApp({ routes: [] }), staticDir: createReplica() }),
    );
    const first = await rawRequest(`${firstBase}/assets/app.js`, { "accept-encoding": "gzip" });
    const second = await rawRequest(`${secondBase}/assets/app.js`, {
      "accept-encoding": "gzip",
    });

    expect(first.headers.etag).toBe(second.headers.etag);
    expect(gunzipSync(first.body)).toEqual(gunzipSync(second.body));
  });

  it("does not reuse same-metadata ISG validators after a handler restart", async () => {
    const staticDir = makeTempDir();
    const htmlDir = join(staticDir, "page");
    const htmlPath = join(htmlDir, "index.html");
    mkdirSync(htmlDir, { recursive: true });
    const staleHtml = `<main>${"a".repeat(4096)}</main>`;
    const freshHtml = `<main>${"b".repeat(4096)}</main>`;
    const fixedTimestamp = new Date(1_700_000_000_000);
    writeFileSync(htmlPath, staleHtml, "utf-8");
    utimesSync(htmlPath, fixedTimestamp, fixedTimestamp);

    const createHandler = () =>
      createNodeRequestHandler({
        app: defineApp({ routes: [] }),
        headersManifest: { "/page": { etag: '"page-document"' } },
        isgManifest: { "/page": { revalidate: timeRevalidate(3600) } },
        staticDir,
      });

    const firstBase = await listen(createHandler());
    const stale = await rawRequest(`${firstBase}/page`, { "accept-encoding": "gzip" });
    expect(gunzipSync(stale.body).toString("utf-8")).toBe(staleHtml);

    await writeISGFile(htmlPath, freshHtml);
    // Model a coarse filesystem whose externally visible mtime does not move.
    utimesSync(htmlPath, fixedTimestamp, fixedTimestamp);

    const restartedBase = await listen(createHandler());
    const etagRevalidation = await rawRequest(`${restartedBase}/page`, {
      "accept-encoding": "gzip",
      "if-none-match": stale.headers.etag!,
    });
    const dateRevalidation = await rawRequest(`${restartedBase}/page`, {
      "accept-encoding": "gzip",
      "if-modified-since": stale.headers["last-modified"]!,
    });

    expect(etagRevalidation.status).toBe(200);
    expect(etagRevalidation.headers.etag).not.toBe(stale.headers.etag);
    expect(gunzipSync(etagRevalidation.body).toString("utf-8")).toBe(freshHtml);
    expect(dateRevalidation.status).toBe(200);
    expect(gunzipSync(dateRevalidation.body).toString("utf-8")).toBe(freshHtml);
  });

  it("keeps regenerated ISG validators stable across deployment replicas", async () => {
    const primaryStaticDir = makeTempDir();
    const siblingStaticDir = makeTempDir();
    const app = defineApp({
      routes: [
        route("/page", "./routes/page.tsx", {
          render: "isg",
          revalidate: timeRevalidate(3600),
        }),
      ],
    });
    const options = {
      app,
      headersManifest: { "/page": { etag: '"page-document"' } },
      isgManifest: { "/page": { revalidate: timeRevalidate(3600) } },
      registry: {
        routeModules: {
          "./routes/page.tsx": async () => ({
            Component: () => `<main>${"sibling-safe".repeat(400)}</main>`,
          }),
        },
      },
    };
    const primaryBase = await listen(
      createNodeRequestHandler({ ...options, staticDir: primaryStaticDir }),
    );

    // The cold render writes the snapshot and advances only the primary
    // handler's process-local cache generation.
    const cold = await rawRequest(`${primaryBase}/page`);
    expect(cold.status).toBe(200);

    // Model another deployment replica: the bytes and build metadata match,
    // but its local device/inode/ctime identity necessarily differs.
    const primaryHtmlPath = join(primaryStaticDir, "page", "index.html");
    const siblingHtmlPath = join(siblingStaticDir, "page", "index.html");
    const fixedTimestamp = new Date(Math.floor(Date.now() / 1000) * 1000);
    mkdirSync(join(siblingStaticDir, "page"), { recursive: true });
    writeFileSync(siblingHtmlPath, readFileSync(primaryHtmlPath));
    utimesSync(primaryHtmlPath, fixedTimestamp, fixedTimestamp);
    utimesSync(siblingHtmlPath, fixedTimestamp, fixedTimestamp);
    const siblingBase = await listen(
      createNodeRequestHandler({ ...options, staticDir: siblingStaticDir }),
    );

    const primary = await rawRequest(`${primaryBase}/page`, { "accept-encoding": "gzip" });
    const sibling = await rawRequest(`${siblingBase}/page`, { "accept-encoding": "gzip" });

    expect(primary.headers.etag).toBe(sibling.headers.etag);
    expect(gunzipSync(primary.body)).toEqual(gunzipSync(sibling.body));
  });

  it("omits the ISG ETag when content-validator work cannot be admitted", async () => {
    const staticDir = makeTempDir();
    const htmlDir = join(staticDir, "page");
    const html = `<main>${"bounded validator work ".repeat(300)}</main>`;
    mkdirSync(htmlDir, { recursive: true });
    writeFileSync(join(htmlDir, "index.html"), html, "utf-8");
    const etagSpy = vi
      .spyOn(CompressedAssetCache.prototype, "getOrCreateFileEtag")
      .mockReturnValue(null);

    try {
      const base = await listen(
        createNodeRequestHandler({
          app: defineApp({ routes: [] }),
          canonicalOrigin: "http://localhost",
          isgManifest: { "/page": { revalidate: timeRevalidate(3600) } },
          staticDir,
        }),
      );
      const response = await rawRequest(`${base}/page`, { "accept-encoding": "gzip" });

      expect(response.status).toBe(200);
      expect(response.headers.etag).toBeUndefined();
      expect(response.headers["content-encoding"]).toBe("gzip");
      expect(gunzipSync(response.body).toString("utf-8")).toBe(html);
    } finally {
      etagSpy.mockRestore();
    }
  });

  it("reads the same file version that supplied compression metadata", async () => {
    const staticDir = makeTempDir();
    const assetDir = join(staticDir, "assets");
    const assetPath = join(assetDir, "app.js");
    mkdirSync(assetDir, { recursive: true });
    const oldSource = `// old\n${"oldPayload();\n".repeat(400)}`;
    const newSource = `// new\n${"newPayload();\n".repeat(80_000)}`;
    writeFileSync(assetPath, oldSource, "utf-8");

    const replacementHandler = createNodeRequestHandler({
      app: defineApp({ routes: [] }),
      staticDir,
    });
    const probe = await open(assetPath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      readFile(): Promise<Buffer>;
    };
    await probe.close();
    const originalReadFile = fileHandlePrototype.readFile;
    let replaced = false;
    const readFileSpy = vi
      .spyOn(fileHandlePrototype, "readFile")
      .mockImplementation(async function (this: { readFile(): Promise<Buffer> }) {
        if (!replaced) {
          replaced = true;
          await writeISGFile(assetPath, newSource);
        }
        return originalReadFile.call(this);
      });
    const base = await listen(replacementHandler);
    let raced: RawResponse;

    try {
      raced = await rawRequest(`${base}/assets/app.js`, { "accept-encoding": "gzip" });
      expect(replaced).toBe(true);
      expect(gunzipSync(raced.body).toString("utf-8")).toBe(oldSource);
    } finally {
      readFileSpy.mockRestore();
    }

    const replacement = await rawRequest(`${base}/assets/app.js`, {
      "accept-encoding": "gzip",
    });
    expect(gunzipSync(replacement.body).toString("utf-8")).toBe(newSource);
    expect(replacement.headers.etag).not.toBe(raced.headers.etag);
  });

  it("ignores If-Modified-Since when If-None-Match is present (RFC 9110 §13.1.3)", async () => {
    const { handler } = createStaticHandler();
    const base = await listen(handler);

    const identity = await rawRequest(`${base}/assets/app.js`);

    // A client revalidating its identity-encoded cache entry sends both
    // validators. The brotli variant carries a different ETag, so this must
    // be a fresh 200: the still-fresh Last-Modified date must not shadow the
    // ETag mismatch, or the client's identity body would be relabeled with
    // the brotli variant's validator by a spurious 304.
    const crossEncoding = await rawRequest(`${base}/assets/app.js`, {
      "accept-encoding": "br",
      "if-modified-since": identity.headers["last-modified"]!,
      "if-none-match": identity.headers.etag!,
    });
    expect(crossEncoding.status).toBe(200);
    expect(crossEncoding.headers["content-encoding"]).toBe("br");

    // A matching ETag still answers 304 even alongside a stale IMS date.
    const conditional = await rawRequest(`${base}/assets/app.js`, {
      "accept-encoding": "br",
      "if-modified-since": "Thu, 01 Jan 1970 00:00:00 GMT",
      "if-none-match": crossEncoding.headers.etag!,
    });
    expect(conditional.status).toBe(304);
  });

  it("keeps static Range requests identity-encoded when returning a full response", async () => {
    const { handler } = createStaticHandler();
    const base = await listen(handler);

    const response = await rawRequest(`${base}/assets/app.js`, {
      "accept-encoding": "br",
      range: "bytes=0-3",
    });

    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.body.toString("utf-8")).toContain("payload");
  });

  it("serves identical bytes to concurrent first requests for the same asset", async () => {
    const { handler } = createStaticHandler();
    const base = await listen(handler);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        rawRequest(`${base}/assets/app.js`, { "accept-encoding": "br" }),
      ),
    );

    const [first, ...rest] = responses;
    expect(first!.headers["content-encoding"]).toBe("br");
    for (const response of rest) {
      expect(response.headers.etag).toBe(first!.headers.etag);
      expect(response.body.equals(first!.body)).toBe(true);
    }
  });

  it("serves compressed prerendered HTML", async () => {
    const { handler } = createStaticHandler();
    const base = await listen(handler);

    const response = await rawRequest(`${base}/`, { "accept-encoding": "gzip" });

    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(response.body).toString("utf-8")).toContain("<p>prerendered</p>");
  });

  it("serves static WebAssembly with its compressible MIME type", async () => {
    const { handler } = createStaticHandler();
    const base = await listen(handler);

    const response = await rawRequest(`${base}/assets/module.wasm`, {
      "accept-encoding": "gzip",
    });

    expect(response.headers["content-type"]).toBe("application/wasm");
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(response.body)).toEqual(Buffer.alloc(4096, 5));
  });

  it("drops an identity Content-Length when streaming a large compressed page", async () => {
    const staticDir = makeTempDir();
    const html = `<html><body>${"large prerendered page ".repeat(60_000)}</body></html>`;
    writeFileSync(join(staticDir, "index.html"), html, "utf-8");

    const base = await listen(
      createNodeRequestHandler({
        app: defineApp({ routes: [] }),
        canonicalOrigin: "http://localhost",
        headersManifest: {
          "/": { "content-length": String(Buffer.byteLength(html)) },
        },
        staticDir,
      }),
    );

    const response = await rawRequest(`${base}/`, { "accept-encoding": "br" });

    expect(Buffer.byteLength(html)).toBeGreaterThan(1024 * 1024);
    expect(response.headers["content-encoding"]).toBe("br");
    expect(response.headers["content-length"]).toBeUndefined();
    expect(brotliDecompressSync(response.body).toString("utf-8")).toBe(html);
  });

  it("leaves tiny and binary files identity-encoded", async () => {
    const { handler } = createStaticHandler();
    const base = await listen(handler);

    const tiny = await rawRequest(`${base}/assets/tiny.css`, { "accept-encoding": "br, gzip" });
    expect(tiny.headers["content-encoding"]).toBeUndefined();
    expect(tiny.body.toString("utf-8")).toBe("a{color:red}");

    const binary = await rawRequest(`${base}/assets/pixel.png`, { "accept-encoding": "br, gzip" });
    expect(binary.headers["content-encoding"]).toBeUndefined();
    expect(binary.headers.vary ?? "").not.toContain("Accept-Encoding");
    expect(binary.body.byteLength).toBe(4096);
  });

  it("serves identical compressed bytes from the in-memory LRU on repeat requests", async () => {
    const { handler } = createStaticHandler();
    const base = await listen(handler);

    const first = await rawRequest(`${base}/assets/app.js`, { "accept-encoding": "br" });
    const second = await rawRequest(`${base}/assets/app.js`, { "accept-encoding": "br" });

    expect(second.headers.etag).toBe(first.headers.etag);
    expect(second.body.equals(first.body)).toBe(true);
  });

  it("keeps static files identity-encoded when compression is disabled", async () => {
    const { handler } = createStaticHandler({ compression: false });
    const base = await listen(handler);

    const response = await rawRequest(`${base}/assets/app.js`, { "accept-encoding": "br, gzip" });

    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers.vary ?? "").not.toContain("Accept-Encoding");
    expect(response.body.toString("utf-8")).toContain("payload");
  });

  it("omits the body but keeps GET negotiation metadata for HEAD", async () => {
    const { handler } = createStaticHandler();
    const base = await listen(handler);

    const get = await rawRequest(`${base}/assets/app.js`, { "accept-encoding": "br, gzip" });
    const head = await rawRequest(
      `${base}/assets/app.js`,
      { "accept-encoding": "br, gzip" },
      "HEAD",
    );

    expect(head.status).toBe(200);
    expect(head.headers["content-encoding"]).toBe(get.headers["content-encoding"]);
    expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
    expect(head.headers.etag).toBe(get.headers.etag);
    expect(head.headers.vary).toContain("Accept-Encoding");
    expect(head.body.byteLength).toBe(0);
  });
});
