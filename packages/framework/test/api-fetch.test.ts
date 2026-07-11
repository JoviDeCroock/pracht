import { describe, expect, it, vi } from "vitest";

import { apiFetch, ApiFetchError } from "../src/index.ts";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("apiFetch", () => {
  it("defaults to GET and parses JSON responses", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ items: [1, 2] }));

    const result = await apiFetch("/api/items", { fetch: fetchSpy });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/items");
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ method: "GET" });
    expect(result).toEqual({ items: [1, 2] });
  });

  it("substitutes and encodes route params in the path template", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));

    await apiFetch("/api/items/:id", { params: { id: "a b" }, fetch: fetchSpy });

    expect(fetchSpy.mock.calls[0][0]).toBe("/api/items/a%20b");
  });

  it("throws on missing route params", async () => {
    const fetchSpy = vi.fn();
    await expect(apiFetch("/api/items/:id", { fetch: fetchSpy })).rejects.toThrow(
      "Missing route param: id.",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serializes query records and prefixes baseUrl", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));

    await apiFetch("/api/search", {
      baseUrl: "https://example.com",
      query: { q: "hi", tags: ["a", "b"] },
      fetch: fetchSpy,
    });

    expect(fetchSpy.mock.calls[0][0]).toBe("https://example.com/api/search?q=hi&tags=a&tags=b");
  });

  it("JSON-encodes object bodies and sets the content type", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));

    await apiFetch("/api/items", {
      method: "POST",
      body: { name: "pracht" },
      fetch: fetchSpy,
    });

    const init = fetchSpy.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "pracht" }));
    expect(init.headers.get("content-type")).toBe("application/json");
  });

  it("passes FormData bodies through untouched", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const formData = new FormData();
    formData.set("name", "pracht");

    await apiFetch("/api/items", { method: "POST", body: formData, fetch: fetchSpy });

    const init = fetchSpy.mock.calls[0][1];
    expect(init.body).toBe(formData);
    expect(init.headers.has("content-type")).toBe(false);
  });

  it("sets the Node fetch duplex option for stream bodies", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("pracht"));
        controller.close();
      },
    });

    await apiFetch("/api/items", { method: "POST", body, fetch: fetchSpy });

    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ body, duplex: "half" });
  });

  it("throws ApiFetchError with normalized issues on 422 validation failures", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: "validation",
          issues: [{ in: "body", message: "Expected string", path: ["name"] }],
        },
        { status: 422 },
      ),
    );

    const error = await apiFetch("/api/items", {
      method: "POST",
      body: { name: 1 },
      fetch: fetchSpy,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiFetchError);
    expect((error as ApiFetchError).status).toBe(422);
    expect((error as ApiFetchError).issues).toEqual([
      { in: "body", message: "Expected string", path: ["name"] },
    ]);
  });

  it("throws ApiFetchError without issues for non-validation failures", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));

    const error = await apiFetch("/api/items", { fetch: fetchSpy }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiFetchError);
    expect((error as ApiFetchError).status).toBe(500);
    expect((error as ApiFetchError).issues).toBeUndefined();
  });

  it("resolves text responses to strings and 204 to undefined", async () => {
    const textFetch = vi
      .fn()
      .mockResolvedValue(new Response("plain", { headers: { "content-type": "text/plain" } }));
    await expect(apiFetch("/api/text", { fetch: textFetch })).resolves.toBe("plain");

    const emptyFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(apiFetch("/api/empty", { fetch: emptyFetch })).resolves.toBeUndefined();
  });

  it("treats HEAD responses as bodyless", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 200, headers: { "content-type": "application/json" } }),
      );

    await expect(
      apiFetch("/api/items", { method: "HEAD", fetch: fetchSpy }),
    ).resolves.toBeUndefined();
  });

  it("parses media types case-insensitively", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "Application/JSON" },
      }),
    );

    await expect(apiFetch("/api/items", { fetch: fetchSpy })).resolves.toEqual({ ok: true });
  });

  it("rejects malformed JSON in successful responses", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response("{broken", { headers: { "content-type": "application/json" } }),
      );

    await expect(apiFetch("/api/items", { fetch: fetchSpy })).rejects.toBeInstanceOf(SyntaxError);
  });
});
