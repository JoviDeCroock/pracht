import { describe, expect, it } from "vitest";

import { coerceFormInput } from "../src/form.ts";

const SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string" },
    limit: { type: "integer" },
    price: { type: "number" },
    urgent: { type: "boolean" },
    note: { type: "null" },
    tags: { type: "array", items: { type: "string" } },
    counts: { type: "array", items: { type: "integer" } },
  },
} as const;

describe("coerceFormInput", () => {
  it("parses numbers and integers, leaving unparseable values for validation", () => {
    const result = coerceFormInput(SCHEMA, [
      ["limit", "5"],
      ["price", "9.99"],
      ["query", "42"],
    ]);
    expect(result).toEqual({ limit: 5, price: 9.99, query: "42" });

    // Not a number: passes through so schema validation reports the real issue.
    expect(coerceFormInput(SCHEMA, [["limit", "many"]])).toEqual({ limit: "many" });
    expect(coerceFormInput(SCHEMA, [["limit", " "]])).toEqual({ limit: " " });
  });

  it('treats checkbox "on" and "true"/"false" as booleans', () => {
    expect(coerceFormInput(SCHEMA, [["urgent", "on"]])).toEqual({ urgent: true });
    expect(coerceFormInput(SCHEMA, [["urgent", "true"]])).toEqual({ urgent: true });
    expect(coerceFormInput(SCHEMA, [["urgent", "false"]])).toEqual({ urgent: false });
    expect(coerceFormInput(SCHEMA, [["urgent", "maybe"]])).toEqual({ urgent: "maybe" });
  });

  it("collects repeated fields into arrays when the schema says array", () => {
    const result = coerceFormInput(SCHEMA, [
      ["tags", "a"],
      ["tags", "b"],
      ["counts", "1"],
      ["counts", "2"],
    ]);
    expect(result).toEqual({ tags: ["a", "b"], counts: [1, 2] });

    // A single entry still becomes a one-element array.
    expect(coerceFormInput(SCHEMA, [["tags", "solo"]])).toEqual({ tags: ["solo"] });
  });

  it("collapses repeated non-array fields to the last value", () => {
    expect(
      coerceFormInput(SCHEMA, [
        ["query", "first"],
        ["query", "second"],
      ]),
    ).toEqual({ query: "second" });
  });

  it("passes unknown fields and non-string values through unchanged", () => {
    const blob = new Blob(["x"]);
    expect(
      coerceFormInput(SCHEMA, [
        ["unknown", "value"],
        ["query", blob],
      ]),
    ).toEqual({ unknown: "value", query: blob });
  });

  it("tolerates schemas without properties", () => {
    expect(coerceFormInput({ type: "object" }, [["a", "1"]])).toEqual({ a: "1" });
    expect(coerceFormInput(null, [["a", "1"]])).toEqual({ a: "1" });
  });
});
