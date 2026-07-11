import { describe, expect, it } from "vitest";

import { schemaToTypeText } from "../src/schema-types.js";

describe("schemaToTypeText", () => {
  it("maps primitive types", () => {
    expect(schemaToTypeText({ type: "string" }, "input")).toBe("string");
    expect(schemaToTypeText({ type: "number" }, "input")).toBe("number");
    expect(schemaToTypeText({ type: "integer" }, "input")).toBe("number");
    expect(schemaToTypeText({ type: "boolean" }, "input")).toBe("boolean");
    expect(schemaToTypeText({ type: "null" }, "input")).toBe("null");
  });

  it("falls back to unknown for missing or unrecognized schemas", () => {
    expect(schemaToTypeText(null, "input")).toBe("unknown");
    expect(schemaToTypeText({}, "input")).toBe("unknown");
    expect(schemaToTypeText("not a schema", "output")).toBe("unknown");
  });

  it("renders enum and const as literal types", () => {
    expect(schemaToTypeText({ enum: ["draft", "published", 3, null] }, "input")).toBe(
      '"draft" | "published" | 3 | null',
    );
    expect(schemaToTypeText({ const: true }, "output")).toBe("true");
    expect(schemaToTypeText({ const: { tag: ["a", 1] } }, "output")).toBe('{ "tag": ["a", 1]; }');
  });

  it("renders arrays through their item schema", () => {
    expect(schemaToTypeText({ type: "array", items: { type: "string" } }, "input")).toBe(
      "Array<string>",
    );
    expect(schemaToTypeText({ type: "array" }, "input")).toBe("Array<unknown>");
  });

  it("closes objects with additionalProperties: false and keeps open ones indexed", () => {
    const closed = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    };
    expect(schemaToTypeText(closed, "input")).toBe('{ "query": string; }');

    const open = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    expect(schemaToTypeText(open, "input")).toBe('{ "query": string; [key: string]: unknown; }');
  });

  it("renders property-less objects as Records", () => {
    expect(schemaToTypeText({ type: "object" }, "output")).toBe("Record<string, unknown>");
    expect(schemaToTypeText({ type: "object", additionalProperties: false }, "output")).toBe(
      "Record<string, never>",
    );
    expect(
      schemaToTypeText({ type: "object", additionalProperties: { type: "number" } }, "output"),
    ).toBe("Record<string, number>");
  });

  it("treats defaulted input properties as optional, but not output properties", () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", default: 10 },
      },
      required: ["query", "limit"],
      additionalProperties: false,
    };
    // Defaults are applied before input validation, so callers may omit `limit`.
    expect(schemaToTypeText(schema, "input")).toBe('{ "query": string; "limit"?: number; }');
    // Output validation applies no defaults: required means present.
    expect(schemaToTypeText(schema, "output")).toBe('{ "query": string; "limit": number; }');
  });

  it("marks non-required properties optional in both positions", () => {
    const schema = {
      type: "object",
      properties: { cursor: { type: "string" } },
      additionalProperties: false,
    };
    expect(schemaToTypeText(schema, "input")).toBe('{ "cursor"?: string; }');
    expect(schemaToTypeText(schema, "output")).toBe('{ "cursor"?: string; }');
  });

  it("renders nested structures", () => {
    const schema = {
      type: "object",
      properties: {
        notes: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, title: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      required: ["notes"],
      additionalProperties: false,
    };
    expect(schemaToTypeText(schema, "output")).toBe(
      '{ "notes": Array<{ "id": string; "title"?: string; }>; }',
    );
  });
});
