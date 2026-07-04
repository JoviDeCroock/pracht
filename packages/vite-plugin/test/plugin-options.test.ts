import { describe, expect, it } from "vitest";

import { createPrachtServerModuleSource } from "../src/plugin-codegen.ts";
import { resolveOptions } from "../src/plugin-options.ts";

describe("resolveOptions budgets", () => {
  it("defaults to no budgets", () => {
    expect(resolveOptions({}).budgets).toEqual({});
  });

  it("accepts size strings and byte counts keyed by route path or *", () => {
    const resolved = resolveOptions({
      budgets: { "*": "120kb", "/dashboard": "200kb", "/": 50000 },
    });
    expect(resolved.budgets).toEqual({ "*": "120kb", "/dashboard": "200kb", "/": 50000 });
  });

  it("rejects keys that are not * or a route path", () => {
    expect(() => resolveOptions({ budgets: { dashboard: "200kb" } })).toThrow(
      /keys must be "\*" or a route path/,
    );
  });

  it("rejects non-positive or empty values", () => {
    expect(() => resolveOptions({ budgets: { "*": 0 } })).toThrow(/positive number of bytes/);
    expect(() => resolveOptions({ budgets: { "*": "" } })).toThrow(/positive number of bytes/);
  });
});

describe("createPrachtServerModuleSource budgets export", () => {
  it("embeds the configured budgets in the server module", () => {
    const source = createPrachtServerModuleSource({
      budgets: { "*": "120kb", "/dashboard": "200kb" },
    });
    expect(source).toContain('export const budgets = {"*":"120kb","/dashboard":"200kb"};');
  });

  it("embeds an empty budgets object by default", () => {
    const source = createPrachtServerModuleSource();
    expect(source).toContain("export const budgets = {};");
  });
});
