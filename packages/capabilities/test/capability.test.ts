import { describe, expect, it } from "vitest";

import { defineCapability } from "../src/index.ts";

const baseDefinition = {
  title: "Search notes",
  description: "Find notes.",
  input: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: { notes: { type: "array", items: { type: "string" } } },
    required: ["notes"],
  },
  effect: "read" as const,
  run: async () => ({ notes: [] }),
};

describe("defineCapability", () => {
  it("normalizes the definition and defaults middleware/expose", () => {
    const capability = defineCapability(baseDefinition);

    expect(capability.kind).toBe("capability");
    expect(capability.middleware).toEqual([]);
    expect(capability.expose).toBeNull();
  });

  it("normalizes expose.http: true to a POST exposure", () => {
    const capability = defineCapability({ ...baseDefinition, expose: { http: true } });
    expect(capability.expose).toEqual({ http: { method: "POST" }, mcp: false, webmcp: false });
  });

  it("keeps custom HTTP paths", () => {
    const capability = defineCapability({
      ...baseDefinition,
      expose: { http: { path: "/api/search-notes" } },
    });
    expect(capability.expose?.http).toEqual({ method: "POST", path: "/api/search-notes" });
  });

  it("applies input defaults before validating", () => {
    const capability = defineCapability(baseDefinition);
    const result = capability.validateInput({ query: "x" });
    expect(result).toEqual({ ok: true, value: { query: "x", limit: 10 } });
  });

  it("preserves explicit null input for null schemas", () => {
    const capability = defineCapability({
      ...baseDefinition,
      input: { type: "null" },
    });
    expect(capability.validateInput(null)).toEqual({ ok: true, value: null });
  });

  it("returns path-scoped input issues", () => {
    const capability = defineCapability(baseDefinition);
    const result = capability.validateInput({ query: "x", limit: 99 });
    expect(result).toEqual({
      ok: false,
      issues: [{ path: "/limit", message: "must be <= 50" }],
    });
  });

  it("validates output", () => {
    const capability = defineCapability(baseDefinition);
    expect(capability.validateOutput({ notes: ["a"] })).toEqual({
      ok: true,
      value: { notes: ["a"] },
    });
    expect(capability.validateOutput({})).toEqual({
      ok: false,
      issues: [{ path: "/notes", message: "is required" }],
    });
  });

  it("rejects missing contract fields", () => {
    expect(() => defineCapability({ ...baseDefinition, description: " " })).toThrow(
      /"description" must be a non-empty string/,
    );
    expect(() =>
      defineCapability({ ...baseDefinition, effect: "delete" as unknown as "read" }),
    ).toThrow(/"effect" must be "read", "write", or "destructive"/);
    expect(() =>
      defineCapability({ ...baseDefinition, input: undefined as unknown as {} }),
    ).toThrow(/"input" must be a JSON Schema object/);
  });

  it("rejects schemas using unsupported keywords, naming them", () => {
    expect(() =>
      defineCapability({
        ...baseDefinition,
        input: {
          type: "object",
          properties: { query: { type: "string", pattern: "^a" } },
        },
      }),
    ).toThrow(/unsupported JSON Schema keywords: \/properties\/query\/pattern/);
  });

  it("rejects malformed values for supported schema keywords", () => {
    expect(() =>
      defineCapability({
        ...baseDefinition,
        input: { type: 123 },
      }),
    ).toThrow(/invalid JSON Schema values: \/type:<expected supported type string>/);
    expect(() =>
      defineCapability({
        ...baseDefinition,
        input: { type: "object", required: "query" },
      }),
    ).toThrow(/\/required:<expected string array>/);
  });

  it("rejects exposing destructive capabilities to agent projections", () => {
    expect(() =>
      defineCapability({
        ...baseDefinition,
        effect: "destructive",
        expose: { http: true, webmcp: true },
      }),
    ).toThrow(/destructive capabilities cannot be exposed to agent projections/);
    expect(() =>
      defineCapability({
        ...baseDefinition,
        effect: "destructive",
        expose: { http: true, mcp: true },
      }),
    ).toThrow(/destructive capabilities cannot be exposed to agent projections/);
  });

  it("allows destructive capabilities over HTTP (confirmation-gated at runtime)", () => {
    const capability = defineCapability({
      ...baseDefinition,
      effect: "destructive",
      expose: { http: true },
    });
    expect(capability.expose?.http).toEqual({ method: "POST" });
  });

  it("allows private destructive capabilities", () => {
    const capability = defineCapability({ ...baseDefinition, effect: "destructive" });
    expect(capability.expose).toBeNull();
  });

  it("records agentPolicy and rejects invalid values", () => {
    const capability = defineCapability({ ...baseDefinition, agentPolicy: "require" });
    expect(capability.agentPolicy).toBe("require");
    expect(() =>
      defineCapability({ ...baseDefinition, agentPolicy: "always" as unknown as "require" }),
    ).toThrow(/"agentPolicy" must be "observe" or "require"/);
  });

  it("rejects webmcp exposure without http", () => {
    expect(() => defineCapability({ ...baseDefinition, expose: { webmcp: true } })).toThrow(
      /expose\.webmcp requires expose\.http/,
    );
  });

  it("rejects non-POST HTTP methods and invalid paths", () => {
    expect(() =>
      defineCapability({
        ...baseDefinition,
        expose: { http: { method: "GET" as unknown as "POST" } },
      }),
    ).toThrow(/only supports method: "POST"/);
    expect(() =>
      defineCapability({ ...baseDefinition, expose: { http: { path: "no-slash" } } }),
    ).toThrow(/must be a string starting with "\/"/);
  });
});
