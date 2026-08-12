import { afterEach, describe, expect, it, vi } from "vitest";

import { createEventStream, serializeEventStreamMessage } from "../src/event-stream.ts";

function createRequest(signal?: AbortSignal): Request {
  return new Request("http://localhost/api/live", { signal });
}

/** Read every chunk currently in the stream until it closes. */
async function readToEnd(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out + decoder.decode();
    out += decoder.decode(value, { stream: true });
  }
}

/** Read exactly one chunk. */
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { done, value } = await reader.read();
  expect(done).toBe(false);
  return new TextDecoder().decode(value);
}

describe("serializeEventStreamMessage", () => {
  it("serializes a plain string payload", () => {
    expect(serializeEventStreamMessage({ data: "hello" })).toBe("data: hello\n\n");
  });

  it("splits multi-line data into one data: line per line, across CRLF, CR, and LF", () => {
    expect(serializeEventStreamMessage({ data: "a\nb\r\nc\rd" })).toBe(
      "data: a\ndata: b\ndata: c\ndata: d\n\n",
    );
  });

  it("JSON-serializes non-string payloads", () => {
    expect(serializeEventStreamMessage({ data: { count: 2 } })).toBe('data: {"count":2}\n\n');
    expect(serializeEventStreamMessage({ data: 42 })).toBe("data: 42\n\n");
    expect(serializeEventStreamMessage({ data: null })).toBe("data: null\n\n");
  });

  it("serializes undefined and unserializable data as an empty data line", () => {
    expect(serializeEventStreamMessage({ data: undefined })).toBe("data: \n\n");
    expect(serializeEventStreamMessage({ data: () => {} })).toBe("data: \n\n");
  });

  it("orders event, id, and retry fields before the data lines", () => {
    expect(serializeEventStreamMessage({ data: "d", event: "tick", id: "7", retry: 1500 })).toBe(
      "event: tick\nid: 7\nretry: 1500\ndata: d\n\n",
    );
  });

  it("refuses CR/LF injection through the event field", () => {
    expect(() => serializeEventStreamMessage({ data: "x", event: "tick\ndata: forged" })).toThrow(
      /event/,
    );
    expect(() => serializeEventStreamMessage({ data: "x", event: "tick\r" })).toThrow(/event/);
  });

  it("refuses CR/LF and NUL injection through the id field", () => {
    expect(() => serializeEventStreamMessage({ data: "x", id: "1\nretry: 1" })).toThrow(/id/);
    expect(() => serializeEventStreamMessage({ data: "x", id: "1\0" })).toThrow(/id/);
  });

  it("refuses non-integer and negative retry values", () => {
    expect(() => serializeEventStreamMessage({ data: "x", retry: 1.5 })).toThrow(/retry/);
    expect(() => serializeEventStreamMessage({ data: "x", retry: -1 })).toThrow(/retry/);
    expect(() => serializeEventStreamMessage({ data: "x", retry: Number.NaN })).toThrow(/retry/);
  });

  it("newlines inside JSON payloads stay escaped, so they cannot split the frame", () => {
    expect(serializeEventStreamMessage({ data: { text: "a\nb" } })).toBe(
      'data: {"text":"a\\nb"}\n\n',
    );
  });
});

describe("createEventStream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("responds with SSE headers that defeat caching, buffering, and transforms", () => {
    const { response, close } = createEventStream(createRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    close();
  });

  it("merges custom headers over the defaults", () => {
    const { response, close } = createEventStream(createRequest(), {
      headers: { "cache-control": "no-cache, no-transform", "x-custom": "1" },
    });
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-custom")).toBe("1");
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    close();
  });

  it("rejects CR/LF in custom header values", () => {
    expect(() =>
      createEventStream(createRequest(), { headers: { "x-evil": "a\r\nset-cookie: b" } }),
    ).toThrow(/x-evil/);
  });

  it("streams sent messages and closes the body on close()", async () => {
    const stream = createEventStream(createRequest());
    expect(stream.send({ data: "one" })).toBe(true);
    expect(stream.send({ data: { n: 2 }, event: "tick" })).toBe(true);
    stream.close();

    await expect(readToEnd(stream.response)).resolves.toBe(
      'data: one\n\nevent: tick\ndata: {"n":2}\n\n',
    );
  });

  it("send() returns false after close() and close() is idempotent", () => {
    const stream = createEventStream(createRequest());
    stream.close();
    stream.close();
    expect(stream.closed).toBe(true);
    expect(stream.send({ data: "late" })).toBe(false);
  });

  it("still throws on malformed fields after close, instead of silently returning false", () => {
    const stream = createEventStream(createRequest());
    stream.close();
    expect(() => stream.send({ data: "x", event: "a\nb" })).toThrow(/event/);
  });

  it("closes when the request aborts (client disconnect on workerd/edge)", async () => {
    const controller = new AbortController();
    const stream = createEventStream(createRequest(controller.signal));
    expect(stream.send({ data: "before" })).toBe(true);

    controller.abort();

    expect(stream.closed).toBe(true);
    expect(stream.send({ data: "after" })).toBe(false);
    // The body ends: a consumer's read loop terminates.
    await expect(readToEnd(stream.response)).resolves.toBe("data: before\n\n");
  });

  it("is born closed when the request signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = createEventStream(createRequest(controller.signal));

    expect(stream.closed).toBe(true);
    expect(stream.send({ data: "x" })).toBe(false);
    await expect(readToEnd(stream.response)).resolves.toBe("");
  });

  it("treats body cancellation as a disconnect (Node adapter destroying the pipe)", async () => {
    const stream = createEventStream(createRequest());
    expect(stream.send({ data: "x" })).toBe(true);

    await stream.response.body!.cancel();

    expect(stream.closed).toBe(true);
    expect(stream.send({ data: "y" })).toBe(false);
  });

  it("emits keep-alive comment lines on the configured interval", async () => {
    vi.useFakeTimers();
    const stream = createEventStream(createRequest(), { keepAlive: 15 });
    const reader = stream.response.body!.getReader();

    vi.advanceTimersByTime(15_000);
    await expect(readChunk(reader)).resolves.toBe(":keep-alive\n\n");
    vi.advanceTimersByTime(15_000);
    await expect(readChunk(reader)).resolves.toBe(":keep-alive\n\n");

    stream.close();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("stops the keep-alive timer on close, abort, and cancel — no timer leaks", async () => {
    vi.useFakeTimers();
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const clearInterval = vi.spyOn(globalThis, "clearInterval");

    const closed = createEventStream(createRequest(), { keepAlive: 1 });
    closed.close();

    const aborter = new AbortController();
    const aborted = createEventStream(createRequest(aborter.signal), { keepAlive: 1 });
    aborter.abort();
    expect(aborted.closed).toBe(true);

    const cancelled = createEventStream(createRequest(), { keepAlive: 1 });
    await cancelled.response.body!.cancel();

    expect(setInterval).toHaveBeenCalledTimes(3);
    expect(clearInterval).toHaveBeenCalledTimes(3);

    // And a cleared timer emits nothing.
    vi.advanceTimersByTime(60_000);
    await expect(readToEnd(closed.response)).resolves.toBe("");
  });

  it("does not start a keep-alive timer for a request that is already aborted", () => {
    vi.useFakeTimers();
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const controller = new AbortController();
    controller.abort();

    createEventStream(createRequest(controller.signal), { keepAlive: 1 });

    expect(setInterval).not.toHaveBeenCalled();
  });

  it("rejects nonsensical keepAlive values", () => {
    for (const keepAlive of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createEventStream(createRequest(), { keepAlive })).toThrow(/keepAlive/);
    }
  });

  it("buffers messages sent before the consumer starts reading", async () => {
    const stream = createEventStream(createRequest());
    for (let i = 0; i < 100; i += 1) {
      expect(stream.send({ data: String(i) })).toBe(true);
    }
    stream.close();

    const body = await readToEnd(stream.response);
    expect(body.startsWith("data: 0\n\n")).toBe(true);
    expect(body.endsWith("data: 99\n\n")).toBe(true);
  });
});
