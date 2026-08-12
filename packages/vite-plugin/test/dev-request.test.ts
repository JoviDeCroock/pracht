import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { DevRequestBodyTooLargeError, nodeToWebRequest } from "../src/plugin-dev-request.ts";

function nodeRequest(
  body: string[],
  options: { headers?: Record<string, string | string[]>; method?: string; url?: string } = {},
): IncomingMessage {
  const stream = Readable.from(body) as IncomingMessage;
  stream.headers = options.headers ?? { host: "localhost:5173" };
  stream.method = options.method ?? "GET";
  stream.url = options.url ?? "/";
  return stream;
}

describe("development Node request conversion", () => {
  it("preserves the direct host, URL, method, headers, and streamed body", async () => {
    const request = await nodeToWebRequest(
      nodeRequest(["hello", " world"], {
        headers: { host: "example.test:4173", "x-test": ["one", "two"] },
        method: "POST",
        url: "/notes?draft=1",
      }),
      64,
    );

    expect(request.url).toBe("http://example.test:4173/notes?draft=1");
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-test")).toBe("one, two");
    await expect(request.text()).resolves.toBe("hello world");
  });

  it("does not consume bodies for GET and HEAD requests", async () => {
    for (const method of ["GET", "HEAD"]) {
      const request = await nodeToWebRequest(nodeRequest(["ignored"], { method }), 1);
      await expect(request.text()).resolves.toBe("");
    }
  });

  it("throws the typed body-limit error as soon as streamed bytes exceed the limit", async () => {
    await expect(
      nodeToWebRequest(nodeRequest(["1234", "5678"], { method: "POST" }), 7),
    ).rejects.toBeInstanceOf(DevRequestBodyTooLargeError);
  });
});
