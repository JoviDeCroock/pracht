import { build, parseAst, resolveConfig, type Plugin } from "vite";
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
  ssr?: { noExternal?: boolean | Array<string | RegExp>; target?: string };
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
      output?: {
        manualChunks?: unknown;
        codeSplitting?: { groups?: Array<{ name: string; test?: unknown }> };
        advancedChunks?: { groups?: Array<{ name: string; test?: unknown }> };
      };
    };
  };
}

function runConfigHook(
  adapter: PrachtAdapter,
  isSsrBuild: boolean,
  options: Partial<Parameters<typeof pracht>[0]> = {},
  userConfig: Record<string, unknown> = {},
): BuildConfig {
  const plugin = pracht({ adapter, ...options }).find((candidate) => candidate.name === "pracht");
  if (!plugin) throw new Error("pracht plugin not found");
  const hook = plugin.config as (
    config: Record<string, unknown>,
    env: { command: string; mode: string; isSsrBuild: boolean },
  ) => BuildConfig;
  return hook.call(plugin as never, userConfig, {
    command: "build",
    mode: "production",
    isSsrBuild,
  });
}

function withOutput(output: unknown): Record<string, unknown> {
  return { build: { rollupOptions: { output } } };
}

function runConfigResolvedHook(base: string): void {
  const plugin = pracht({ adapter: edgeAdapter }).find((candidate) => candidate.name === "pracht");
  if (!plugin) throw new Error("pracht plugin not found");
  const hook = getHook<(this: unknown, config: unknown) => void>(plugin, "configResolved");
  hook.call({}, { base, build: { ssr: true }, command: "build", root: "/project" });
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

  it("rejects unsafe root-absolute deploy bases before building", () => {
    for (const base of [
      "/app%2Fadmin/",
      "/app%5Cadmin/",
      "/app/%2e%2e/",
      "/app/%00/",
      "/app%ZZ/",
      "/app?preview/",
      "/app//",
      "/app//admin/",
    ]) {
      expect(() => runConfigResolvedHook(base)).toThrow(/safe URL segments/);
    }
  });

  it("captures a relative base contributed by a later config plugin", async () => {
    const plugins = pracht({ adapter: edgeAdapter });
    const basePlugin: Plugin = {
      name: "later-base",
      config() {
        return { base: "./" };
      },
    };

    const config = await resolveConfig(
      {
        build: { ssr: true },
        configFile: false,
        logLevel: "silent",
        plugins: [...plugins, basePlugin],
      },
      "build",
    );
    expect(config.base).toBe("/");

    const plugin = plugins.find((candidate) => candidate.name === "pracht");
    if (!plugin) throw new Error("pracht plugin not found");
    const load = getHook<(this: unknown, id: string) => string | null>(plugin, "load");
    const source = load.call({}, "virtual:pracht/server");

    expect(source).toContain('export const buildBase = "/";');
    expect(source).toContain('export const configuredBase = "./";');
  });

  it("accepts safe path and asset-only CDN bases", () => {
    for (const base of ["/", "/app/", "/caf%C3%A9/", "https://cdn.example.com/"]) {
      expect(() => runConfigResolvedHook(base)).not.toThrow();
    }
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

  it("bundles Pracht runtime packages in non-edge SSR builds", () => {
    const nodeAdapter: PrachtAdapter = {
      id: "node",
      serverImports: "",
      createServerEntryModule: () => "export default {};",
    };
    const config = runConfigHook(nodeAdapter, true);
    const noExternal = config.ssr?.noExternal;

    expect(Array.isArray(noExternal)).toBe(true);
    expect(
      (noExternal as Array<string | RegExp>).some(
        (entry) => entry instanceof RegExp && entry.test("@pracht/core"),
      ),
    ).toBe(true);
    expect(
      (noExternal as Array<string | RegExp>).some(
        (entry) => entry instanceof RegExp && entry.test("@pracht/image"),
      ),
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

  it("defines every client feature as enabled by default", () => {
    const config = runConfigHook(edgeAdapter, false);

    expect(config.define?.__PRACHT_CLIENT_PREFETCH__).toBe("true");
  });

  it("defines a disabled client feature as false in dev as well as in builds", () => {
    // The flag is declared by the app rather than derived from the manifest, so
    // unlike __PRACHT_AGENT_SURFACE__ it must not be forced on outside builds —
    // `pracht dev` has to behave like the bundle that ships.
    const built = runConfigHook(edgeAdapter, false, { client: { prefetch: false } });
    expect(built.define?.__PRACHT_CLIENT_PREFETCH__).toBe("false");

    const plugin = pracht({ adapter: edgeAdapter, client: { prefetch: false } }).find(
      (candidate) => candidate.name === "pracht",
    );
    if (!plugin) throw new Error("pracht plugin not found");
    const hook = plugin.config as (
      config: Record<string, unknown>,
      env: { command: string; mode: string; isSsrBuild: boolean },
    ) => BuildConfig;
    const dev = hook.call(
      plugin as never,
      {},
      {
        command: "serve",
        mode: "development",
        isSsrBuild: false,
      },
    );

    expect(dev.define?.__PRACHT_CLIENT_PREFETCH__).toBe("false");
  });

  it("groups Preact into a vendor chunk on client builds only", () => {
    const clientConfig = runConfigHook(edgeAdapter, false);
    const ssrConfig = runConfigHook(edgeAdapter, true);

    expect(clientConfig.build?.rollupOptions?.output?.codeSplitting?.groups).toEqual([
      { name: "vendor", test: /node_modules[\\/]preact/ },
    ]);
    expect(ssrConfig.build?.rollupOptions?.output).toBeUndefined();
  });

  it("contributes only its own group, so Vite appends it to the app's", () => {
    // Vite merges a plugin's config over the user's and concatenates arrays.
    // Returning the whole merged list here would duplicate every app group.
    const config = runConfigHook(
      edgeAdapter,
      false,
      {},
      withOutput({
        codeSplitting: {
          groups: [{ name: "editor", test: /src[\\/]features[\\/]editor/ }],
        },
      }),
    );

    expect(config.build?.rollupOptions?.output?.codeSplitting?.groups).toEqual([
      { name: "vendor", test: /node_modules[\\/]preact/ },
    ]);
  });

  it("contributes nothing when the app switches code splitting off", () => {
    const config = runConfigHook(edgeAdapter, false, {}, withOutput({ codeSplitting: false }));

    expect(config.build?.rollupOptions?.output).toBeUndefined();
  });

  it("contributes nothing when vendorChunk is disabled", () => {
    const config = runConfigHook(edgeAdapter, false, { vendorChunk: false });

    expect(config.build?.rollupOptions?.output).toBeUndefined();
  });

  it("matches the deprecated advancedChunks form so the app's groups survive", () => {
    // Rolldown ignores advancedChunks as soon as codeSplitting is present.
    const config = runConfigHook(
      edgeAdapter,
      false,
      {},
      withOutput({ advancedChunks: { groups: [{ name: "app" }] } }),
    );

    expect(config.build?.rollupOptions?.output?.advancedChunks?.groups).toEqual([
      { name: "vendor", test: /node_modules[\\/]preact/ },
    ]);
    expect(config.build?.rollupOptions?.output?.codeSplitting).toBeUndefined();
  });

  it("composes with a manualChunks function instead of replacing it", () => {
    const appManualChunks = vi.fn((id: string) => (id.includes("lodash") ? "utils" : undefined));
    const config = runConfigHook(
      edgeAdapter,
      false,
      {},
      withOutput({ manualChunks: appManualChunks }),
    );

    const composed = config.build?.rollupOptions?.output?.manualChunks as (
      id: string,
      meta: unknown,
    ) => unknown;
    expect(typeof composed).toBe("function");
    expect(composed("/app/node_modules/preact/dist/preact.mjs", {})).toBe("vendor");
    expect(composed("/app/node_modules/lodash/index.js", {})).toBe("utils");
    expect(appManualChunks).toHaveBeenCalledWith("/app/node_modules/lodash/index.js", {});
  });

  it("warns rather than clobbering an array of outputs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = runConfigHook(edgeAdapter, false, {}, withOutput([{ format: "es" }]));

    expect(config.build?.rollupOptions?.output).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("frameworkChunkGroups()"));
    warn.mockRestore();
  });

  it("does not force edge-only SSR options on non-edge adapters", () => {
    const nodeLikeAdapter: PrachtAdapter = { ...edgeAdapter, id: "node", edge: false };
    const config = runConfigHook(nodeLikeAdapter, true);

    expect(config.ssr?.target).toBeUndefined();
    expect(config.environments?.ssr).toBeUndefined();
    expect(config.ssr?.noExternal).toEqual([expect.any(RegExp)]);
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
