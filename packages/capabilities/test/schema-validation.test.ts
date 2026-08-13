import { describe, expect, it } from "vitest";

import { validateAgainstSchema } from "../src/schema-validation.ts";

describe("validateAgainstSchema", () => {
  const schema = {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 10 },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      tags: { type: "array", items: { type: "string" } },
      status: { enum: ["draft", "published"] },
      kind: { const: "note" },
      nested: {
        type: "object",
        properties: { flag: { type: "boolean" } },
        required: ["flag"],
      },
    },
    required: ["query"],
    additionalProperties: false,
  };

  it("accepts a conforming value", () => {
    expect(
      validateAgainstSchema(schema, {
        query: "hello",
        limit: 10,
        tags: ["a", "b"],
        status: "draft",
        kind: "note",
        nested: { flag: true },
      }),
    ).toEqual([]);
  });

  it("reports missing required properties with a path", () => {
    const issues = validateAgainstSchema(schema, {});
    expect(issues).toEqual([{ path: "/query", message: "is required" }]);
  });

  it("does not satisfy required properties through Object.prototype", () => {
    expect(validateAgainstSchema({ type: "object", required: ["constructor"] }, {})).toEqual([
      { path: "/constructor", message: "is required" },
    ]);
  });

  it("reports type mismatches with the actual type", () => {
    const issues = validateAgainstSchema(schema, { query: 42 });
    expect(issues).toEqual([{ path: "/query", message: "must be of type string, got number" }]);
  });

  it("rejects JavaScript objects outside the JSON data model", () => {
    class Instance {}

    for (const value of [new Date(), new Map(), new Instance()]) {
      expect(validateAgainstSchema({ type: "object" }, value)).toEqual([
        { path: "", message: "must be JSON-serializable, got object" },
      ]);
    }
    expect(validateAgainstSchema({ type: "object" }, Object.create(null))).toEqual([]);
  });

  it("rejects non-JSON values through unconstrained and additional properties", () => {
    expect(validateAgainstSchema({}, { upload: new Blob(["data"]) })).toEqual([
      { path: "/upload", message: "must be JSON-serializable, got object" },
    ]);
    expect(validateAgainstSchema({ type: "object" }, { value: undefined })).toEqual([
      { path: "/value", message: "must be JSON-serializable, got undefined" },
    ]);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(validateAgainstSchema({}, circular)).toEqual([
      { path: "/self", message: "must be JSON-serializable, got a circular reference" },
    ]);

    const sparse = Array(1);
    expect(validateAgainstSchema({}, sparse)).toEqual([
      { path: "/0", message: "must be JSON-serializable, got a sparse array slot" },
    ]);
  });

  it("enforces integer vs number", () => {
    expect(validateAgainstSchema(schema, { query: "x", limit: 1.5 })).toEqual([
      { path: "/limit", message: "must be of type integer, got number" },
    ]);
  });

  it("enforces minimum/maximum and minLength/maxLength", () => {
    expect(validateAgainstSchema(schema, { query: "x", limit: 99 })).toEqual([
      { path: "/limit", message: "must be <= 50" },
    ]);
    expect(validateAgainstSchema(schema, { query: "" })).toEqual([
      { path: "/query", message: "must be at least 1 character(s) long" },
    ]);
    expect(validateAgainstSchema(schema, { query: "way-too-long-string" })).toEqual([
      { path: "/query", message: "must be at most 10 character(s) long" },
    ]);
  });

  it("counts Unicode code points for minLength and maxLength", () => {
    expect(validateAgainstSchema({ type: "string", minLength: 2 }, "😀")).toEqual([
      { path: "", message: "must be at least 2 character(s) long" },
    ]);
    expect(validateAgainstSchema({ type: "string", maxLength: 1 }, "😀")).toEqual([]);
  });

  it("rejects unknown properties when additionalProperties is false", () => {
    expect(validateAgainstSchema(schema, { query: "x", bogus: 1 })).toEqual([
      { path: "/bogus", message: "is not an allowed property" },
    ]);
  });

  it("rejects prototype-named properties unless explicitly declared", () => {
    const closedSchema = { type: "object", properties: {}, additionalProperties: false };
    for (const name of ["constructor", "toString", "__proto__"]) {
      const input = JSON.parse(`{${JSON.stringify(name)}:1}`);
      expect(validateAgainstSchema(closedSchema, input)).toEqual([
        { path: `/${name}`, message: "is not an allowed property" },
      ]);
    }
  });

  it("validates array items with indexed paths", () => {
    expect(validateAgainstSchema(schema, { query: "x", tags: ["ok", 7] })).toEqual([
      { path: "/tags/1", message: "must be of type string, got number" },
    ]);
  });

  it("validates enum and const", () => {
    expect(validateAgainstSchema(schema, { query: "x", status: "archived" })).toEqual([
      { path: "/status", message: 'must be one of "draft", "published"' },
    ]);
    expect(validateAgainstSchema(schema, { query: "x", kind: "todo" })).toEqual([
      { path: "/kind", message: 'must equal "note"' },
    ]);
  });

  it("recurses into nested objects", () => {
    expect(validateAgainstSchema(schema, { query: "x", nested: {} })).toEqual([
      { path: "/nested/flag", message: "is required" },
    ]);
  });

  it("does not accept a __proto__ payload as an object-valued const", () => {
    const constSchema = { const: { x: 1 } };
    const proto = JSON.parse('{"__proto__": {}}') as Record<string, unknown>;
    expect(validateAgainstSchema(constSchema, proto)).not.toEqual([]);
    expect(validateAgainstSchema(constSchema, { x: 1 })).toEqual([]);
  });

  it("does not accept a __proto__ payload as an object-valued enum member", () => {
    const enumSchema = { enum: [{ mode: "safe" }] };
    const proto = JSON.parse('{"__proto__": {}}') as Record<string, unknown>;
    expect(validateAgainstSchema(enumSchema, proto)).not.toEqual([]);
  });

  it("validates null and boolean types", () => {
    expect(validateAgainstSchema({ type: "null" }, null)).toEqual([]);
    expect(validateAgainstSchema({ type: "boolean" }, "true")).toEqual([
      { path: "", message: "must be of type boolean, got string" },
    ]);
  });
});
