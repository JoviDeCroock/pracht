import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAst } from "vite";

import {
  createPrachtDevModuleSource,
  createPrachtServerModuleSource,
} from "../src/plugin-codegen.ts";
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

  it("accepts extensible page metadata and source output options", () => {
    const page = ({ data }: { data: Record<string, any> }) => ({ title: data.title });
    const render = ({ data }: { data: Record<string, any> }) => data.markdown;
    const resolved = resolveOptions({
      llmsTxt: {
        details: "Start here.",
        full: true,
        markdownSuffix: true,
        page,
        render,
      },
    });
    expect(resolved.llmsTxt).toMatchObject({
      details: "Start here.",
      full: true,
      markdownSuffix: true,
      page,
      render,
    });
  });

  it("rejects unknown include sections", () => {
    // @ts-expect-error — "sitemap" is not a valid section.
    expect(() => resolveOptions({ llmsTxt: { include: ["sitemap"] } })).toThrow(
      /"pages", "api", and\/or "capabilities"/,
    );
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
    expect(source).toContain('import { buildLlmsTxtArtifacts } from "@pracht/core/server";');
    expect(source).toContain(
      'const llmsTxtConfig = {"title":"My App","description":"Demo.","origin":"https://example.com"};',
    );
    expect(source).toContain("export const generateLlmsTxt = async () =>");
  });

  it("serializes page and render callbacks into the generated server module", () => {
    const source = createPrachtServerModuleSource({
      llmsTxt: {
        full: true,
        page: ({ data }) => ({ title: data.content.title }),
        render: ({ data }) => data.content.source,
      },
    });

    expect(source).toContain('"full":true,"page":(');
    expect(source).toContain('"render":(');
    expect(source).toContain("data.content.title");
    expect(source).toContain("data.content.source");
    expect(source).toContain("export const generateLlmsTxtArtifacts = () =>");
  });

  it("normalizes object-method callbacks into valid generated module syntax", () => {
    const source = createPrachtServerModuleSource({
      llmsTxt: {
        page({ path }) {
          return { title: path };
        },
        async render({ data }) {
          return data.markdown;
        },
      },
    });

    expect(source).toContain('"page":(function({ path }) {');
    expect(source).toContain('"render":(async function({ data }) {');
    expect(() => parseAst(source)).not.toThrow();
  });

  it("falls back to the app package.json name for the title", () => {
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const source = createPrachtServerModuleSource({ llmsTxt: {} }, { root: packageRoot });
    expect(source).toContain('"title":"@pracht/vite-plugin"');
  });
});

describe("createPrachtDevModuleSource API graph", () => {
  it("exports adapter-neutral resolved API routes for companion tooling", () => {
    const source = createPrachtDevModuleSource({ apiDir: "/src/http" });
    expect(source).toContain('import { resolveApp, resolveApiRoutes } from "@pracht/core/server";');
    expect(source).toContain(
      'export const apiRoutes = resolveApiRoutes(Object.keys(apiModules), "/src/http");',
    );
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
