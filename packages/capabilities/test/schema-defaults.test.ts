import { describe, expect, it } from "vitest";

import { applySchemaDefaults } from "../src/schema-defaults.ts";

describe("applySchemaDefaults", () => {
  it("fills missing properties with defaults without mutating the input", () => {
    const schema = {
      type: "object",
      properties: {
        limit: { type: "integer", default: 10 },
        query: { type: "string" },
      },
    };
    const input = { query: "x" };
    const result = applySchemaDefaults(schema, input) as Record<string, unknown>;

    expect(result).toEqual({ query: "x", limit: 10 });
    expect(input).toEqual({ query: "x" });
  });

  it("does not override provided values", () => {
    const schema = { type: "object", properties: { limit: { default: 10 } } };
    expect(applySchemaDefaults(schema, { limit: 3 })).toEqual({ limit: 3 });
  });

  it("applies defaults for names inherited from Object.prototype", () => {
    const schema = {
      type: "object",
      properties: { toString: { type: "string", default: "value" } },
    };
    expect(applySchemaDefaults(schema, {})).toEqual({ toString: "value" });
  });

  it("applies defaults in nested objects and array items", () => {
    const schema = {
      type: "object",
      properties: {
        nested: { type: "object", properties: { flag: { default: true } } },
        items: {
          type: "array",
          items: { type: "object", properties: { size: { default: 1 } } },
        },
      },
    };
    expect(applySchemaDefaults(schema, { nested: {}, items: [{}, { size: 4 }] })).toEqual({
      nested: { flag: true },
      items: [{ size: 1 }, { size: 4 }],
    });
  });

  it("clones object defaults so callers cannot mutate the schema", () => {
    const schema = { type: "object", properties: { meta: { default: { a: 1 } } } };
    const first = applySchemaDefaults(schema, {}) as { meta: { a: number } };
    first.meta.a = 99;
    const second = applySchemaDefaults(schema, {}) as { meta: { a: number } };
    expect(second.meta.a).toBe(1);
  });
});
