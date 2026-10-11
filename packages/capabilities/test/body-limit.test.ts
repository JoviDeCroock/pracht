// Capability HTTP dispatch and the remote MCP endpoint parse request bodies on
// runtimes (Workers, edge functions) that do not cap them. These tests pin the
// bounded read: a declared Content-Length over the cap is refused unread, a
// missing or understated one is counted as the stream arrives, and a body of
// exactly the cap is still served.
import { describe, expect, it } from "vitest";

import { defineCapability } from "../src/index.ts";
import { MAX_CAPABILITY_BODY_BYTES, readBoundedBody } from "../src/server/body.ts";
import { createCapabilityHost } from "../src/server/index.ts";

const ORIGIN = "https://app.example";
const LIMIT = MAX_CAPABILITY_BODY_BYTES;
const encoder = new TextEncoder();

const echo = defineCapability({
  title: "Echo",
  description: "Return the length of the text.",
  input: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: { length: { type: "integer" } },
    required: ["length"],
  },
  effect: "read",
  expose: { http: true, mcp: true },
  async run({ input }) {
    return { length: (input as { text: string }).text.length };
  },
});

const host = () =>
  createCapabilityHost({
    capabilities: { echo },
    agents: { mcp: { serverInfo: { name: "limits", version: "1.0.0" } } },
  });

/** A JSON document of exactly `bytes` bytes: `prefix + "x"*n + suffix`. */
function sized(bytes: number, prefix: string, suffix: string): string {
  return `${prefix}${"x".repeat(bytes - prefix.length - suffix.length)}${suffix}`;
}

const httpBody = (bytes: number) => sized(bytes, '{"text":"', '"}');
const mcpBody = (bytes: number) =>
  sized(bytes, '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{},"pad":"', '"}');

/** A stream with no Content-Length, emitting `total` bytes in 64 KiB chunks, counting pulls. */
function chunked(total: number, pulls = { count: 0 }): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      pulls.count++;
      if (sent >= total) return controller.close();
      const size = Math.min(64 * 1024, total - sent);
      sent += size;
      controller.enqueue(encoder.encode("x".repeat(size)));
    },
  });
}

function post(path: string, body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    duplex: "half",
  } as RequestInit);
}

describe("readBoundedBody", () => {
  it("returns a body of exactly the cap and refuses one byte more", async () => {
    const at = await readBoundedBody(
      new Request(ORIGIN, { method: "POST", body: "x".repeat(10) }),
      10,
    );
    expect(at?.byteLength).toBe(10);
    const over = await readBoundedBody(
      new Request(ORIGIN, { method: "POST", body: "x".repeat(11) }),
      10,
    );
    expect(over).toBeNull();
  });

  it("stops pulling an unbounded stream once the cap is passed", async () => {
    const pulls = { count: 0 };
    const request = post("/", chunked(Number.MAX_SAFE_INTEGER, pulls));
    await expect(readBoundedBody(request, LIMIT)).resolves.toBeNull();
    expect(pulls.count).toBeLessThan(LIMIT / (64 * 1024) + 4);
  });

  it("refuses a declared Content-Length over the cap without reading", async () => {
    const pulls = { count: 0 };
    const request = post("/", chunked(16, pulls), { "content-length": String(LIMIT + 1) });
    await expect(readBoundedBody(request, LIMIT)).resolves.toBeNull();
    expect(pulls.count).toBeLessThanOrEqual(1);
  });

  it("counts the stream when Content-Length understates it", async () => {
    const request = post("/", chunked(LIMIT + 1), { "content-length": "16" });
    await expect(readBoundedBody(request, LIMIT)).resolves.toBeNull();
  });

  it("reads an absent body as empty", async () => {
    await expect(readBoundedBody(new Request(ORIGIN))).resolves.toEqual(new Uint8Array(0));
  });
});

describe("capability HTTP dispatch body limit", () => {
  const path = "/api/capabilities/echo";

  it("serves a body of exactly the limit", async () => {
    const response = await host().fetch(post(path, httpBody(LIMIT)));
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      ok: true,
      data: { length: LIMIT - '{"text":"'.length - '"}'.length },
    });
  });

  it.each([
    ["one byte over the limit", () => post(path, httpBody(LIMIT + 1))],
    ["chunked without a length", () => post(path, chunked(LIMIT + 1))],
    [
      "a Content-Length that lies low",
      () => post(path, chunked(LIMIT + 1), { "content-length": "2" }),
    ],
    [
      "a declared Content-Length over the limit",
      () => post(path, "{}", { "content-length": String(LIMIT + 1) }),
    ],
    [
      "an oversized form post",
      () =>
        post(path, `text=${"x".repeat(LIMIT)}`, {
          "content-type": "application/x-www-form-urlencoded",
        }),
    ],
  ])("answers 413 for %s", async (_label, request) => {
    const response = await host().fetch(request());
    expect(response?.status).toBe(413);
    await expect(response?.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "payload_too_large",
        message: `Request body exceeds ${LIMIT} bytes.`,
      },
    });
  });
});

describe("remote MCP body limit", () => {
  it("serves a JSON-RPC message of exactly the limit", async () => {
    const response = await host().fetch(post("/mcp", mcpBody(LIMIT)));
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual(["echo"]);
  });

  it.each([
    ["one byte over the limit", () => post("/mcp", mcpBody(LIMIT + 1))],
    ["chunked without a length", () => post("/mcp", chunked(LIMIT + 1))],
    [
      "a Content-Length that lies low",
      () => post("/mcp", chunked(LIMIT + 1), { "content-length": "2" }),
    ],
    [
      "a declared Content-Length over the limit",
      () => post("/mcp", "{}", { "content-length": String(LIMIT + 1) }),
    ],
  ])("answers a 413 JSON-RPC error for %s", async (_label, request) => {
    const response = await host().fetch(request());
    expect(response?.status).toBe(413);
    await expect(response?.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: `Request body exceeds ${LIMIT} bytes.` },
    });
  });
});
