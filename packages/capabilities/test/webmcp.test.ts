import { afterEach, describe, expect, it, vi } from "vitest";

import { registerWebmcpTools, webmcpToolAnnotations, type WebmcpTool } from "../src/webmcp.ts";

interface RegisteredTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: unknown;
  annotations: Record<string, unknown>;
  execute: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
}

function installModelContext(
  registerTool: (tool: RegisteredTool) => unknown = () => undefined,
): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  (globalThis as { document?: unknown }).document = {
    modelContext: {
      registerTool(tool: RegisteredTool) {
        registered.push(tool);
        return registerTool(tool);
      },
    },
  };
  return registered;
}

const searchTool: WebmcpTool = {
  name: "notes.search",
  title: "Search notes",
  description: "Find notes.",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  effect: "read",
};

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  vi.restoreAllMocks();
});

describe("webmcpToolAnnotations", () => {
  it("matches the remote MCP projection's hint set per effect class", () => {
    expect(webmcpToolAnnotations("read")).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    // `write` omits destructiveHint so the host's conservative default applies.
    expect(webmcpToolAnnotations("write")).toEqual({
      readOnlyHint: false,
      idempotentHint: false,
    });
    expect(webmcpToolAnnotations(undefined)).toEqual({
      readOnlyHint: false,
      idempotentHint: false,
    });
    expect(webmcpToolAnnotations("read", true)).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      untrustedContentHint: true,
    });
  });
});

describe("registerWebmcpTools", () => {
  it("returns false without breaking when the API is absent", () => {
    expect(registerWebmcpTools([searchTool], () => null)).toBe(false);
  });

  it("registers tools with derived annotations and dispatch-backed execute", async () => {
    const registered = installModelContext();
    const dispatch = vi.fn(async (name: string, input: unknown) => ({ ok: true, name, input }));

    expect(registerWebmcpTools([searchTool], dispatch)).toBe(true);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      name: "notes.search",
      title: "Search notes",
      description: "Find notes.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    });

    const controller = new AbortController();
    const result = await registered[0].execute({ query: "a" }, { signal: controller.signal });
    expect(result).toEqual({ ok: true, name: "notes.search", input: { query: "a" } });
    expect(dispatch).toHaveBeenCalledWith(
      "notes.search",
      { query: "a" },
      { signal: controller.signal },
    );
  });

  it("lets explicit annotations override the derived ones", () => {
    const registered = installModelContext();
    registerWebmcpTools([{ ...searchTool, annotations: { idempotentHint: false } }], () => null);
    expect(registered[0].annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  it("refuses to register destructive tools", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registered = installModelContext();

    expect(
      registerWebmcpTools(
        [searchTool, { ...searchTool, name: "notes.wipe", effect: "destructive" }],
        () => null,
      ),
    ).toBe(true);
    expect(registered.map((tool) => tool.name)).toEqual(["notes.search"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("survives registerTool throwing or rejecting", async () => {
    let calls = 0;
    installModelContext(() => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return Promise.reject(new Error("async boom"));
    });

    expect(registerWebmcpTools([searchTool, { ...searchTool, name: "b" }], () => null)).toBe(true);
    // Give the swallowed rejection a microtask to settle; an unhandled
    // rejection would fail the test run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
