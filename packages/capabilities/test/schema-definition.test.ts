import { describe, expect, it } from "vitest";

import {
  collectInvalidSchemaKeywordValues,
  collectUnsupportedSchemaKeywords,
} from "../src/schema-definition.ts";

describe("collectUnsupportedSchemaKeywords", () => {
  it("returns an empty list for supported schemas", () => {
    expect(
      collectUnsupportedSchemaKeywords({
        type: "object",
        title: "Input",
        description: "annotated",
        properties: { query: { type: "string", minLength: 1 } },
        required: ["query"],
        additionalProperties: false,
      }),
    ).toEqual([]);
  });

  it("flags unsupported keywords with schema paths", () => {
    expect(
      collectUnsupportedSchemaKeywords({
        type: "object",
        properties: {
          query: { type: "string", pattern: "^a" },
          extra: { oneOf: [{ type: "string" }] },
        },
      }),
    ).toEqual(["/properties/query/pattern", "/properties/extra/oneOf"]);
  });

  it("flags unsupported type values and tuple items", () => {
    expect(collectUnsupportedSchemaKeywords({ type: ["string", "null"] })).toEqual([
      "/type:<array of types>",
    ]);
    expect(
      collectUnsupportedSchemaKeywords({ type: "array", items: [{ type: "string" }] }),
    ).toEqual(["/items:<tuple form>"]);
  });
});

describe("collectInvalidSchemaKeywordValues", () => {
  it("rejects malformed supported keyword values recursively", () => {
    expect(
      collectInvalidSchemaKeywordValues({
        type: 123,
        properties: { nested: { required: "id" } },
        additionalProperties: "yes",
      }),
    ).toEqual([
      "/type:<expected supported type string>",
      "/additionalProperties:<expected boolean or schema object>",
      "/properties/nested/required:<expected string array>",
    ]);
  });

  it("rejects non-JSON const, default, and enum values", () => {
    expect(
      collectInvalidSchemaKeywordValues({
        const: 1n,
        default: undefined,
        enum: ["ok", new Date()],
      }),
    ).toEqual([
      "/enum/1:<expected JSON value>",
      "/const:<expected JSON value>",
      "/default:<expected JSON value>",
    ]);
  });
});
