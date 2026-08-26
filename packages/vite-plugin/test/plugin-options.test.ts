import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  createPrachtDevModuleSource,
  createPrachtServerModuleSource,
} from "../src/plugin-codegen.ts";
import { resolveOptions } from "../src/plugin-options.ts";

describe("resolveOptions additionalExtensions", () => {
  it("defaults to no additional route extensions", () => {
    expect(resolveOptions({}).additionalExtensions).toEqual([]);
  });

  it("normalizes, deduplicates, and excludes built-in extensions", () => {
    const additionalExtensions = [".TSRX", ".tsrx", ".vue", ".tsx"] as const;
    expect(resolveOptions({ additionalExtensions }).additionalExtensions).toEqual([
      ".tsrx",
      ".vue",
    ]);
  });

  it("rejects values that are not dot-prefixed extensions", () => {
    expect(() => resolveOptions({ additionalExtensions: ["vue"] })).toThrow(
      /dot-prefixed extensions/,
    );
    // @ts-expect-error — extension values must be strings.
    expect(() => resolveOptions({ additionalExtensions: [42] })).toThrow(/dot-prefixed extensions/);
  });
});

describe("resolveOptions client", () => {
  it("enables every client feature by default", () => {
    expect(resolveOptions({}).client).toEqual({ prefetch: true });
  });

  it("applies an explicit override", () => {
    expect(resolveOptions({ client: { prefetch: false } }).client).toEqual({ prefetch: false });
  });

  it("treats an explicit undefined as unset rather than as false", () => {
    expect(resolveOptions({ client: { prefetch: undefined } }).client.prefetch).toBe(true);
  });

  it("rejects non-boolean feature values", () => {
    // @ts-expect-error — feature flags are booleans.
    expect(() => resolveOptions({ client: { prefetch: "no" } })).toThrow(
      /client: \{ prefetch \} \}\) expects a boolean/,
    );
  });

  it("rejects unknown feature names so a typo cannot silently do nothing", () => {
    // @ts-expect-error — "prefetching" is not a feature.
    expect(() => resolveOptions({ client: { prefetching: false } })).toThrow(
      /does not accept "prefetching"/,
    );
  });
});

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

describe("resolveOptions llmsTxt", () => {
  it("defaults to disabled", () => {
    expect(resolveOptions({}).llmsTxt).toBe(false);
  });

  it("accepts an options object", () => {
    const resolved = resolveOptions({
      llmsTxt: { title: "My App", origin: "https://example.com", include: ["pages"] },
    });
    expect(resolved.llmsTxt).toEqual({
      title: "My App",
      origin: "https://example.com",
      include: ["pages"],
    });
  });

  it("rejects non-object values such as true", () => {
    // @ts-expect-error — llmsTxt is `false | object`, not `true`.
    expect(() => resolveOptions({ llmsTxt: true })).toThrow(/false or an options object/);
  });

  it("accepts the capabilities section", () => {
    const resolved = resolveOptions({ llmsTxt: { include: ["capabilities"] } });
    expect(resolved.llmsTxt).toEqual({ include: ["capabilities"] });
  });

  it("rejects unknown include sections", () => {
    // @ts-expect-error — "sitemap" is not a valid section.
    expect(() => resolveOptions({ llmsTxt: { include: ["sitemap"] } })).toThrow(
      /"pages", "api", and\/or "capabilities"/,
    );
  });

  it("rejects a negative, fractional or non-numeric maxPagesPerRoute", () => {
    for (const value of [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveOptions({ llmsTxt: { maxPagesPerRoute: value } })).toThrow(
        /non-negative integer/,
      );
    }
    // @ts-expect-error — a string ceiling is the shape a config file produces.
    expect(() => resolveOptions({ llmsTxt: { maxPagesPerRoute: "50" } })).toThrow(
      /non-negative integer/,
    );
  });

  it("keeps a maxPagesPerRoute of 0", () => {
    expect(resolveOptions({ llmsTxt: { maxPagesPerRoute: 0 } }).llmsTxt).toEqual({
      maxPagesPerRoute: 0,
    });
  });
});

describe("createPrachtServerModuleSource llmsTxt export", () => {
  it("emits no llms.txt code when disabled", () => {
    const source = createPrachtServerModuleSource();
    expect(source).not.toContain("generateLlmsTxt");
    expect(source).not.toContain("buildLlmsTxt");
  });

  it("exports generateLlmsTxt with the configured options", () => {
    const source = createPrachtServerModuleSource({
      llmsTxt: { title: "My App", description: "Demo.", origin: "https://example.com" },
    });
    expect(source).toContain('import { buildLlmsTxt } from "@pracht/core/server";');
    expect(source).toContain(
      'const llmsTxtConfig = {"title":"My App","description":"Demo.","origin":"https://example.com"};',
    );
    expect(source).toContain("export const generateLlmsTxt = () =>");
  });

  // `0` means "list every instance". A truthiness check when serializing the
  // config would drop it and silently restore the default ceiling of 50 — the
  // one value of this option whose absence is indistinguishable from its
  // presence.
  it("serializes a maxPagesPerRoute of 0", () => {
    const source = createPrachtServerModuleSource({
      llmsTxt: { title: "My App", maxPagesPerRoute: 0 },
    });
    expect(source).toContain('"maxPagesPerRoute":0');
  });

  it("omits maxPagesPerRoute when it is not configured", () => {
    const source = createPrachtServerModuleSource({ llmsTxt: { title: "My App" } });
    expect(source).not.toContain("maxPagesPerRoute");
  });

  it("falls back to the app package.json name for the title", () => {
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const source = createPrachtServerModuleSource({ llmsTxt: {} }, { root: packageRoot });
    expect(source).toContain('"title":"@pracht/vite-plugin"');
  });
});

describe("createPrachtDevModuleSource API graph", () => {
  it("exposes the configured base to graph-only CLI consumers", () => {
    expect(createPrachtDevModuleSource({}, { base: "/app/" })).toContain(
      'export const buildBase = "/app/";',
    );
  });

  it("exports the resolved llms.txt state for graph readers", () => {
    expect(createPrachtDevModuleSource({ llmsTxt: { title: "Docs" } })).toContain(
      "export const llmsTxtEnabled = true;",
    );
    expect(createPrachtDevModuleSource({ llmsTxt: undefined })).toContain(
      "export const llmsTxtEnabled = false;",
    );
  });

  it("exports adapter-neutral resolved API routes for companion tooling", () => {
    const source = createPrachtDevModuleSource({ apiDir: "/src/http" });
    expect(source).toContain('import { resolveApp, resolveApiRoutes } from "@pracht/core/server";');
    expect(source).toContain(
      'export const apiRoutes = resolveApiRoutes(Object.keys(apiModules), "/src/http");',
    );
  });

  it("applies route hints and exports the authoritative static target", () => {
    const source = createPrachtDevModuleSource({
      adapter: {
        id: "custom-static",
        serverImports: "",
        staticTarget: true,
        createServerEntryModule: () => "",
      },
    });

    expect(source).toContain("const routeLoaderHints = ");
    expect(source).toContain("const routeHeadHints = ");
    expect(source).toContain("const routeStaticPathsHints = ");
    expect(source).toContain(
      "applyRouteHints(resolvedApp, routeLoaderHints, routeHeadHints, routeStaticPathsHints);",
    );
    expect(source).toContain('export const buildTarget = "custom-static";');
    expect(source).toContain("export const staticTarget = true;");
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

describe("createPrachtServerModuleSource static target export", () => {
  it("exports staticTarget independently from a custom adapter id", () => {
    const source = createPrachtServerModuleSource({
      adapter: {
        id: "custom-static",
        serverImports: 'import { resolveApp, resolveApiRoutes } from "@pracht/core/server";',
        staticTarget: true,
        createServerEntryModule: () => "",
      },
    });

    expect(source).toContain('export const buildTarget = "custom-static";');
    expect(source).toContain("export const staticTarget = true;");
  });

  it("exports staticTarget false for serverful adapters", () => {
    expect(createPrachtServerModuleSource()).toContain("export const staticTarget = false;");
  });

  it("exports the resolved Vite base so the CLI can reject sub-path static deploys", () => {
    const source = createPrachtServerModuleSource({}, { base: "/", configuredBase: "./" });
    expect(createPrachtServerModuleSource({}, { base: "/app/" })).toContain(
      'export const buildBase = "/app/";',
    );
    expect(createPrachtServerModuleSource()).toContain('export const buildBase = "/";');
    expect(source).toContain('export const configuredBase = "./";');
  });

  it("prefixes stable development client entries with the Vite base", () => {
    const source = createPrachtServerModuleSource({}, { base: "/app/" });

    expect(source).toContain('export const clientEntryUrl = "/app/@pracht/client.js";');
    expect(source).toContain('export const islandsEntryUrl = "/app/@pracht/islands.js";');
  });
});
