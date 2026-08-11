import { build, parseAst, type Plugin } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pracht, type PrachtAdapter } from "../src/index.ts";

const edgeAdapter: PrachtAdapter = {
  id: "cloudflare",
  edge: true,
  serverImports: "",
  createServerEntryModule: () => "export default {};",
};

interface BuildConfig {
  resolve?: { dedupe?: string[] };
  ssr?: { noExternal?: boolean; target?: string };
  define?: Record<string, unknown>;
  environments?: {
    ssr?: {
      keepProcessEnv?: boolean;
      resolve?: { conditions?: string[]; external?: string[] };
    };
  };
  build?: {
    rollupOptions?: {
      external?: unknown[];
      output?: { manualChunks?: unknown };
    };
  };
}

function runConfigHook(adapter: PrachtAdapter, isSsrBuild: boolean): BuildConfig {
  const plugin = pracht({ adapter }).find((candidate) => candidate.name === "pracht");
  if (!plugin) throw new Error("pracht plugin not found");
  const hook = plugin.config as (
    config: Record<string, unknown>,
    env: { command: string; mode: string; isSsrBuild: boolean },
  ) => BuildConfig;
  return hook.call(plugin as never, {}, { command: "build", mode: "production", isSsrBuild });
}

function getHook<T>(plugin: Plugin, name: keyof Plugin): T {
  const hook = plugin[name] as unknown as T | { handler: T };
  return typeof hook === "object" && hook !== null && "handler" in hook ? hook.handler : hook;
}

function runEdgeRuntimeSafety(bundle: Record<string, unknown>): void {
  const plugin = pracht({ adapter: edgeAdapter }).find(
    (candidate) => candidate.name === "pracht:edge-runtime-safety",
  );
  if (!plugin) throw new Error("edge runtime safety plugin not found");

  const configResolved = getHook<(this: unknown, config: unknown) => void>(
    plugin,
    "configResolved",
  );
  configResolved.call({}, { build: { ssr: true } });

  const generateBundle = getHook<
    (this: unknown, options: unknown, output: Record<string, unknown>) => void
  >(plugin, "generateBundle");
  generateBundle.call(
    {
      error(message: string) {
        throw new Error(message);
      },
      parse: parseAst,
    },
    {},
    bundle,
  );
}

function chunk(imports: string[] = [], dynamicImports: string[] = []) {
  return {
    type: "chunk" as const,
    code: [
      ...imports.map((specifier) => `import ${JSON.stringify(specifier)};`),
      ...dynamicImports.map((specifier) => `import(${JSON.stringify(specifier)});`),
      'const eliminatedHelperSource = "node:module";',
    ].join("\n"),
    dynamicImports,
    importedBindings: {},
    imports,
  };
}

describe("pracht plugin build config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads only explicitly graph-safe adapter plugins for graph commands", () => {
    const runtimePlugin: Plugin = { name: "platform-runtime" };
    const graphPlugin: Plugin = { name: "platform-graph-stub" };
    const adapter: PrachtAdapter = {
      ...edgeAdapter,
      graphVitePlugins: () => [graphPlugin],
      vitePlugins: () => [runtimePlugin],
    };

    vi.stubEnv("PRACHT_GRAPH_ONLY", "1");
    const graphPlugins = pracht({ adapter });
    expect(graphPlugins).toContain(graphPlugin);
    expect(graphPlugins).not.toContain(runtimePlugin);

    vi.stubEnv("PRACHT_GRAPH_ONLY", "0");
    const runtimePlugins = pracht({ adapter });
    expect(runtimePlugins).toContain(runtimePlugin);
    expect(runtimePlugins).not.toContain(graphPlugin);
  });

  it("loads no adapter plugins in graph mode when the safe hook is omitted", () => {
    const runtimePlugin: Plugin = { name: "platform-runtime" };
    vi.stubEnv("PRACHT_GRAPH_ONLY", "1");

    expect(
      pracht({ adapter: { ...edgeAdapter, vitePlugins: () => [runtimePlugin] } }),
    ).not.toContain(runtimePlugin);
  });

  it("targets webworker and externalizes platform-scheme modules for edge SSR builds", () => {
    const config = runConfigHook(edgeAdapter, true);

    expect(config.ssr?.noExternal).toBe(true);
    expect(config.ssr?.target).toBe("webworker");
    const external = config.build?.rollupOptions?.external ?? [];
    expect(
      external.some((entry) => entry instanceof RegExp && entry.test("cloudflare:workers")),
    ).toBe(true);
  });

  it("uses server package conditions without preserving raw process.env reads", () => {
    const config = runConfigHook(edgeAdapter, true);

    expect(config.environments?.ssr?.resolve?.conditions).toEqual([
      "worker",
      "module",
      "browser",
      "development|production",
    ]);
    expect(config.environments?.ssr?.resolve?.external).toEqual(["node:module"]);
    expect(config.environments?.ssr?.keepProcessEnv).toBeUndefined();
    expect(config.define?.["process.env.NODE_ENV"]).toBeUndefined();
  });

  it("keeps the vendor manualChunks split on client builds only", () => {
    const clientConfig = runConfigHook(edgeAdapter, false);
    const ssrConfig = runConfigHook(edgeAdapter, true);

    expect(typeof clientConfig.build?.rollupOptions?.output?.manualChunks).toBe("function");
    expect(ssrConfig.build?.rollupOptions?.output?.manualChunks).toBeUndefined();
  });

  it("does not force edge SSR options on non-edge adapters", () => {
    const nodeLikeAdapter: PrachtAdapter = { ...edgeAdapter, id: "node", edge: false };
    const config = runConfigHook(nodeLikeAdapter, true);

    expect(config.ssr).toBeUndefined();
  });

  it("allows eliminated interop helpers and platform runtime imports", () => {
    expect(() =>
      runEdgeRuntimeSafety({
        "server.js": chunk(["cloudflare:workers"]),
      }),
    ).not.toThrow();
  });

  it.each([
    ["static", chunk(["node:module"])],
    ["dynamic", chunk([], ["node:fs"])],
    ["bare static", chunk(["module"])],
    ["bare dynamic", chunk([], ["fs"])],
  ])("fails an edge build with a surviving %s Node import", (_, output) => {
    expect(() => runEdgeRuntimeSafety({ "server.js": output })).toThrow(
      /Edge server bundle retains Node\.js builtin imports.*(?:node:)?(?:fs|module)/s,
    );
  });

  it.each(["fs", "module", "node:fs", "node:module"])(
    "rejects a real edge bundle fixture that imports %s",
    async (specifier) => {
      const entry = `virtual:pracht-node-import-fixture-${specifier}`;
      const fixturePlugin: Plugin = {
        name: "pracht:node-import-fixture",
        resolveId(id) {
          return id === entry ? `\0${entry}` : null;
        },
        load(id) {
          if (id !== `\0${entry}`) return null;
          return `import * as builtin from ${JSON.stringify(specifier)}; export default builtin;`;
        },
      };

      await expect(
        build({
          configFile: false,
          logLevel: "silent",
          plugins: [fixturePlugin, ...pracht({ adapter: edgeAdapter })],
          build: {
            rollupOptions: { input: entry, preserveEntrySignatures: "strict" },
            ssr: true,
            write: false,
          },
        }),
      ).rejects.toThrow(new RegExp(`${specifier.replace(":", "\\:")} in `));
    },
  );
});
