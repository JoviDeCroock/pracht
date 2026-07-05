import { describe, expect, it } from "vitest";

import { load, resolve } from "../src/prerender-module-hooks.ts";

const nextResolve = (specifier: string) => ({ url: `resolved:${specifier}` });
const nextLoad = (url: string) => ({ format: "module", source: `loaded:${url}` });

describe("prerender module hooks", () => {
  it("short-circuits known cloudflare modules to stub URLs", () => {
    const result = resolve("cloudflare:workers", {}, nextResolve) as {
      url: string;
      shortCircuit: boolean;
    };
    expect(result.url).toBe("pracht-cloudflare-stub:cloudflare:workers");
    expect(result.shortCircuit).toBe(true);
  });

  it("serves stub sources with the platform base classes", () => {
    const result = load("pracht-cloudflare-stub:cloudflare:workers", {}, nextLoad) as {
      format: string;
      source: string;
    };
    expect(result.format).toBe("module");
    expect(result.source).toContain("export class WorkerEntrypoint {}");
    expect(result.source).toContain("export class DurableObject {}");
  });

  it("throws a descriptive error for unknown cloudflare modules", () => {
    expect(() => resolve("cloudflare:unknown-thing", {}, nextResolve)).toThrow(
      /no prerender stub for "cloudflare:unknown-thing"/,
    );
  });

  it("delegates non-cloudflare specifiers to the next resolver", () => {
    expect(resolve("node:fs", {}, nextResolve)).toEqual({ url: "resolved:node:fs" });
    expect(load("file:///app.js", {}, nextLoad)).toEqual({
      format: "module",
      source: "loaded:file:///app.js",
    });
  });
});
