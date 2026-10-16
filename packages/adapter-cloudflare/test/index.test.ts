import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";

import type { Plugin } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import {
  cloudflareAdapter,
  createCloudflareServerEntryModule,
  createCloudflareWorkerModule,
  PRACHT_CLOUDFLARE_WORKER_MODULE_ID,
} from "../src/index.ts";

type ManifestReader = (
  request: Request,
  assets: { fetch(input: Request | URL | string): Promise<Response> },
) => Promise<Record<string, unknown>>;

function getGeneratedManifestReaders(): {
  readPrachtHeadersManifest: ManifestReader;
  readPrachtISGManifest: ManifestReader;
} {
  const source = createCloudflareServerEntryModule();
  const readersStart = source.indexOf("let headersManifestPromise;");
  const readersEnd = source.indexOf("async function fetch(", readersStart);
  const readersSource = source.slice(readersStart, readersEnd);

  return new Function(
    `${readersSource}\nreturn { readPrachtHeadersManifest, readPrachtISGManifest };`,
  )() as {
    readPrachtHeadersManifest: ManifestReader;
    readPrachtISGManifest: ManifestReader;
  };
}

describe("createCloudflareServerEntryModule", () => {
  it("imports an app createContext module when configured", () => {
    const source = createCloudflareServerEntryModule({
      createContextFrom: "/src/server/context.ts",
    });

    expect(source).toContain(
      'import { createContext as createPrachtContext } from "/src/server/context.ts";',
    );
    expect(source).toContain("createContext = createPrachtContext");
    expect(source).toContain("createCloudflareFetchHandler");
    expect(source).toContain("islandsEntryUrl: islandsEntryUrl ?? undefined");
    expect(source).toContain("islandsBootstrapRequired");
    expect(source).toContain("cssContentManifest,");
    expect(source).toContain("assetsBindingUsesPublicBase: import.meta.env.DEV");
  });

  it("re-exports Cloudflare primitives from a dedicated module", () => {
    const source = createCloudflareServerEntryModule({
      workerExportsFrom: "/src/cloudflare.ts",
    });

    expect(source).toContain('export * from "/src/cloudflare.ts";');
  });

  it("omits worker primitive re-exports when no module is configured", () => {
    const source = createCloudflareServerEntryModule();

    expect(source).not.toContain("export * from");
  });

  it("merges worker handlers from a dedicated module into the default export", () => {
    const source = createCloudflareServerEntryModule({
      workerHandlersFrom: "/src/worker-handlers.ts",
    });

    expect(source).toContain('import * as prachtWorkerHandlers from "/src/worker-handlers.ts";');
    expect(source).toContain("export default { ...prachtWorkerHandlers, fetch };");
  });

  it("keeps the default export shape stable when no handlers module is configured", () => {
    const source = createCloudflareServerEntryModule();

    expect(source).toContain("const prachtWorkerHandlers = {};");
    expect(source).toContain("export default { ...prachtWorkerHandlers, fetch };");
  });

  it("bypasses static assets for the _data route-state transport", () => {
    const source = createCloudflareServerEntryModule();

    expect(source).toContain("_pracht/isg.json");
    expect(source).toContain("_pracht/markdown.json");
    expect(source).toContain("markdownManifest,");
  });

  it("skips generated manifest asset reads for upgrade requests", () => {
    const source = createCloudflareServerEntryModule();
    const fetchStart = source.indexOf("async function fetch(request");
    const handlerStart = source.indexOf("const handler = createCloudflareFetchHandler", fetchStart);
    const fetchSetup = source.slice(fetchStart, handlerStart);

    expect(fetchSetup).toContain('const isUpgradeRequest = request.headers.has("upgrade");');
    expect(fetchSetup).toContain(
      'const headersManifest = !isUpgradeRequest && assets && typeof assets.fetch === "function"',
    );
    expect(fetchSetup).toContain(
      'const markdownManifest = !isUpgradeRequest && assets && typeof assets.fetch === "function"',
    );
    expect(fetchSetup).toContain(
      'const isgManifest = !isUpgradeRequest && assets && typeof assets.fetch === "function"',
    );
  });

  it.each([
    ["headers", "readPrachtHeadersManifest"],
    ["ISG", "readPrachtISGManifest"],
  ] as const)("retries the %s manifest after a transient fetch failure", async (_, readerName) => {
    const readers = getGeneratedManifestReaders();
    const reader = readers[readerName];
    let fetchCount = 0;
    const assets = {
      async fetch() {
        fetchCount += 1;
        if (fetchCount === 1) throw new Error("transient asset failure");
        return Response.json({ "/pricing": { revalidate: 60 } });
      },
    };
    const request = new Request("https://example.com/pricing");

    await expect(reader(request, assets)).resolves.toEqual({});
    await expect(reader(request, assets)).resolves.toEqual({
      "/pricing": { revalidate: 60 },
    });
    expect(fetchCount).toBe(2);
  });

  it.each([
    ["headers", "readPrachtHeadersManifest"],
    ["ISG", "readPrachtISGManifest"],
  ] as const)("retries the %s manifest after a transient error response", async (_, readerName) => {
    const readers = getGeneratedManifestReaders();
    const reader = readers[readerName];
    let fetchCount = 0;
    const assets = {
      async fetch() {
        fetchCount += 1;
        return fetchCount === 1
          ? new Response("unavailable", { status: 503 })
          : Response.json({ "/pricing": { revalidate: 60 } });
      },
    };
    const request = new Request("https://example.com/pricing");

    await expect(reader(request, assets)).resolves.toEqual({});
    await expect(reader(request, assets)).resolves.toEqual({
      "/pricing": { revalidate: 60 },
    });
    expect(fetchCount).toBe(2);
  });

  it.each([
    ["headers", "readPrachtHeadersManifest"],
    ["ISG", "readPrachtISGManifest"],
  ] as const)("caches a missing %s manifest", async (_, readerName) => {
    const readers = getGeneratedManifestReaders();
    const reader = readers[readerName];
    let fetchCount = 0;
    const assets = {
      async fetch() {
        fetchCount += 1;
        return new Response("not found", { status: 404 });
      },
    };
    const request = new Request("https://example.com/pricing");

    await expect(reader(request, assets)).resolves.toEqual({});
    await expect(reader(request, assets)).resolves.toEqual({});
    expect(fetchCount).toBe(1);
  });

  it("wires Workers Caching for ISG routes when enabled", () => {
    const source = createCloudflareServerEntryModule({ cache: true });

    // The runtime handler owns the cache logic — the entry only threads the
    // option through and flags the build (snapshot skipping keys off it).
    expect(source).toContain("export const cloudflareWorkersCacheEnabled = true;");
    expect(source).toContain("cache: true,");
  });

  it("passes a custom stale-while-revalidate window through to the handler", () => {
    const source = createCloudflareServerEntryModule({ cache: { staleWhileRevalidate: 60 } });

    expect(source).toContain('cache: {"staleWhileRevalidate":60},');
  });

  it("leaves Workers Caching out when not enabled", () => {
    const source = createCloudflareServerEntryModule();

    expect(source).toContain("export const cloudflareWorkersCacheEnabled = false;");
    expect(source).toContain("cache: false,");
  });
});

describe("createCloudflareServerEntryModule with workerEntry", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Evaluate the generated module's tail against a real user Worker module:
   * the manifest and handler above it are stubbed, the export wiring is not.
   */
  async function loadWorkerEntryTail(userSource: string): Promise<Record<string, any>> {
    const source = createCloudflareServerEntryModule({ workerEntry: "/src/worker.ts" });
    const tail = source.slice(source.indexOf("registerPrachtWorker(fetch);"));
    const dir = mkdtempSync(join(tmpdir(), "pracht-worker-entry-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "user.mjs"), userSource);
    writeFileSync(
      join(dir, "server.mjs"),
      [
        'import * as prachtUserWorker from "./user.mjs";',
        "export const registered = [];",
        "function registerPrachtWorker(handler) { registered.push(handler); }",
        "async function fetch() { return new Response('pracht'); }",
        "export { fetch as prachtFetch };",
        tail.replace('export * from "/src/worker.ts";', 'export * from "./user.mjs";'),
      ].join("\n"),
    );
    return import(pathToFileURL(join(dir, "server.mjs")).href);
  }

  it("imports the app's Worker module instead of exporting a generated default", () => {
    const source = createCloudflareServerEntryModule({ workerEntry: "/src/worker.ts" });

    expect(source).toContain(
      'import { registerPrachtWorker } from "@pracht/adapter-cloudflare/worker";',
    );
    expect(source).toContain('import * as prachtUserWorker from "/src/worker.ts";');
    expect(source).toContain('export * from "/src/worker.ts";');
    expect(source).not.toContain("export default { ...prachtWorkerHandlers, fetch };");
    // Workers Caching and the assets binding still flow from adapter options.
    expect(source).toContain("export const cloudflareWorkersCacheEnabled = false;");
    expect(source).toContain('export const cloudflareAssetsBinding = "ASSETS";');
  });

  it("reads a ./ path relative to the Vite root", () => {
    const source = createCloudflareServerEntryModule({ workerEntry: "./src/worker.ts" });

    expect(source).toContain('import * as prachtUserWorker from "/src/worker.ts";');
  });

  it("deploys the module's default export and its class and handler-object exports", async () => {
    const server = await loadWorkerEntryTail(
      [
        "export class Counter {}",
        "export const Tail = { tail() {} };",
        'export const VERSION = "1";',
        "export const handler = { fetch() { return new Response('app'); } };",
        "export default handler;",
      ].join("\n"),
    );

    expect(server.default).toBe(server.handler);
    expect(server.registered).toEqual([server.prachtFetch]);
    expect(server.cloudflareWorkerEntrypointNames).toEqual(["Counter", "Tail", "handler"]);
    expect(server.Counter).toBeTypeOf("function");
  });

  it("accepts a class-based default export with a fetch method", async () => {
    const server = await loadWorkerEntryTail(
      "export default class Worker { fetch() { return new Response('app'); } }",
    );

    expect(server.default).toBeTypeOf("function");
    expect(server.cloudflareWorkerEntrypointNames).toEqual([]);
  });

  it.each([
    ["no default export", "export class Counter {}"],
    ["a default export without fetch", "export default { scheduled() {} };"],
  ])("fails to load a Worker module with %s", async (_, userSource) => {
    await expect(loadWorkerEntryTail(userSource)).rejects.toThrow(
      "The Cloudflare workerEntry /src/worker.ts must default-export a Worker handler",
    );
  });
});

describe("cloudflareAdapter", () => {
  it.each([
    [{ workerExportsFrom: "/src/cloudflare.ts" }, "workerExportsFrom"],
    [
      { workerHandlersFrom: "/src/handlers.ts", createContextFrom: "/src/context.ts" },
      "workerHandlersFrom, createContextFrom",
    ],
  ])("rejects workerEntry combined with %o", (options, names) => {
    expect(() => cloudflareAdapter({ workerEntry: "/src/worker.ts", ...options })).toThrow(
      `cloudflareAdapter({ workerEntry }) cannot be combined with ${names}.`,
    );
  });

  it("rejects an empty workerEntry", () => {
    expect(() => cloudflareAdapter({ workerEntry: " " })).toThrow(
      "cloudflareAdapter({ workerEntry }) must be a module path",
    );
  });

  it("separates graph-safe stubs from the Cloudflare runtime plugins", () => {
    const adapter = cloudflareAdapter();
    const graphPlugins = adapter.graphVitePlugins?.() ?? [];
    const runtimePlugins = adapter.vitePlugins?.() ?? [];

    expect(graphPlugins.map((plugin) => plugin.name)).toEqual([
      "pracht:cloudflare-graph-runtime-stubs",
    ]);
    expect(runtimePlugins.length).toBeGreaterThan(0);
    expect(runtimePlugins).not.toContainEqual(
      expect.objectContaining({ name: "pracht:cloudflare-graph-runtime-stubs" }),
    );
  });

  it("stubs Cloudflare runtime modules for graph-loaded contracts", async () => {
    const plugin = cloudflareAdapter()
      .graphVitePlugins?.()
      .find((candidate) => candidate.name === "pracht:cloudflare-graph-runtime-stubs");
    expect(plugin).toBeDefined();

    const resolveId = plugin?.resolveId;
    if (typeof resolveId !== "function") throw new Error("Expected a resolveId hook.");
    const resolved = await resolveId.call({} as never, "cloudflare:workers", undefined, {
      isEntry: false,
    });
    expect(resolved).toBe("\0pracht:cloudflare-graph-runtime:cloudflare:workers");

    const load = plugin?.load;
    if (typeof load !== "function") throw new Error("Expected a load hook.");
    const source = await load.call({} as never, String(resolved), {});
    expect(source).toContain("export class WorkerEntrypoint");
    expect(source).toContain("export const env");

    const runtime = await import(
      `data:text/javascript;base64,${Buffer.from(String(source)).toString("base64")}`
    );
    expect(typeof runtime.waitUntil).toBe("function");
    expect(typeof runtime.withEnv).toBe("function");
    expect(typeof runtime.withExports).toBe("function");
    expect(typeof runtime.withEnvAndExports).toBe("function");
    expect(typeof runtime.tracing?.enterSpan).toBe("function");
    for (const className of [
      "RpcStub",
      "RpcPromise",
      "RpcProperty",
      "RpcTarget",
      "ServiceStub",
      "WorkerEntrypoint",
      "DurableObject",
      "WorkflowEntrypoint",
    ] as const) {
      const RuntimeClass = runtime[className];
      class RuntimeDeclaration extends RuntimeClass {}
      expect(typeof RuntimeDeclaration).toBe("function");
      expect(() => new RuntimeClass()).toThrow(
        new RegExp(`cloudflare:workers ${className} is unavailable during graph inspection`),
      );
    }

    for (const [moduleName, className] of [
      ["cloudflare:email", "EmailMessage"],
      ["cloudflare:workflows", "WorkflowEntrypoint"],
      ["cloudflare:pipelines", "PipelineTransformationEntrypoint"],
    ] as const) {
      const resolvedModule = await resolveId.call({} as never, moduleName, undefined, {
        isEntry: false,
      });
      const moduleSource = await load.call({} as never, String(resolvedModule), {});
      const moduleRuntime = await import(
        `data:text/javascript;base64,${Buffer.from(String(moduleSource)).toString("base64")}`
      );
      const RuntimeClass = moduleRuntime[className];
      class RuntimeDeclaration extends RuntimeClass {}
      expect(typeof RuntimeDeclaration).toBe("function");
      expect(() => new RuntimeClass()).toThrow(
        new RegExp(`${moduleName} ${className} is unavailable during graph inspection`),
      );
    }

    // NonRetryableError is a plain Error subclass with no runtime dependency,
    // so workflow modules can construct it while being inspected.
    const workflowsId = await resolveId.call({} as never, "cloudflare:workflows", undefined, {
      isEntry: false,
    });
    const workflows = await import(
      `data:text/javascript;base64,${Buffer.from(String(await load.call({} as never, String(workflowsId), {}))).toString("base64")}`
    );
    const nonRetryable = new workflows.NonRetryableError("stop");
    expect(nonRetryable).toBeInstanceOf(Error);
    expect(nonRetryable.name).toBe("NonRetryableError");

    // Importing or retaining the binding environments is safe. Reading a
    // binding is runtime work and must fail before a placeholder can influence
    // graph metadata through untrappable Boolean/typeof/equality operations.
    const importedBindings = { env: runtime.env, exports: runtime.exports };
    expect(importedBindings.env).toBe(runtime.env);
    expect(importedBindings.exports).toBe(runtime.exports);
    expect(() => runtime.waitUntil(Promise.resolve())).toThrow(
      /cloudflare:workers waitUntil is unavailable during graph inspection/,
    );
    expect(() => runtime.withEnv({}, () => {})).toThrow(
      /cloudflare:workers withEnv is unavailable during graph inspection/,
    );
    expect(() => runtime.tracing.enterSpan("graph", () => {})).toThrow(
      /cloudflare:workers tracing\.enterSpan is unavailable during graph inspection/,
    );

    for (const [name, binding] of [
      ["env", runtime.env],
      ["exports", runtime.exports],
    ] as const) {
      expect(() => binding.MY_BINDING).toThrow(
        new RegExp(
          `cloudflare:workers ${name} property MY_BINDING access is unavailable during graph inspection`,
        ),
      );
      expect(() => Reflect.set(binding, "MY_BINDING", {})).toThrow(
        new RegExp(
          `cloudflare:workers ${name} property MY_BINDING assignment is unavailable during graph inspection`,
        ),
      );
      expect(() => "MY_BINDING" in binding).toThrow(
        new RegExp(
          `cloudflare:workers ${name} property MY_BINDING membership check is unavailable during graph inspection`,
        ),
      );
      expect(() => Object.keys(binding)).toThrow(
        new RegExp(
          `cloudflare:workers ${name} property enumeration is unavailable during graph inspection`,
        ),
      );
      expect(() => Reflect.ownKeys(binding)).toThrow(
        new RegExp(
          `cloudflare:workers ${name} property enumeration is unavailable during graph inspection`,
        ),
      );
      expect(() => Object.getOwnPropertyDescriptor(binding, "MY_BINDING")).toThrow(
        new RegExp(
          `cloudflare:workers ${name} property MY_BINDING descriptor inspection is unavailable during graph inspection`,
        ),
      );
      expect(() => Object.defineProperty(binding, "MY_BINDING", { value: true })).toThrow(
        new RegExp(
          `cloudflare:workers ${name} property MY_BINDING definition is unavailable during graph inspection`,
        ),
      );
      expect(() => Reflect.deleteProperty(binding, "MY_BINDING")).toThrow(
        new RegExp(
          `cloudflare:workers ${name} property MY_BINDING deletion is unavailable during graph inspection`,
        ),
      );
      expect(() => Object.getPrototypeOf(binding)).toThrow(
        new RegExp(
          `cloudflare:workers ${name} prototype inspection is unavailable during graph inspection`,
        ),
      );
      expect(() => Object.setPrototypeOf(binding, null)).toThrow(
        new RegExp(
          `cloudflare:workers ${name} prototype mutation is unavailable during graph inspection`,
        ),
      );
      expect(() => Object.isExtensible(binding)).toThrow(
        new RegExp(
          `cloudflare:workers ${name} extensibility inspection is unavailable during graph inspection`,
        ),
      );
      expect(() => Object.preventExtensions(binding)).toThrow(
        new RegExp(
          `cloudflare:workers ${name} extension prevention is unavailable during graph inspection`,
        ),
      );
      expect(() => inspect(binding)).toThrow(
        new RegExp(`cloudflare:workers ${name} inspection is unavailable during graph inspection`),
      );
    }
  });

  it("fails clearly for Cloudflare modules without graph stubs", async () => {
    const plugin = cloudflareAdapter()
      .graphVitePlugins?.()
      .find((candidate) => candidate.name === "pracht:cloudflare-graph-runtime-stubs");
    expect(plugin).toBeDefined();

    const resolveId = plugin?.resolveId;
    if (typeof resolveId !== "function") throw new Error("Expected a resolveId hook.");
    expect(() =>
      resolveId.call({} as never, "cloudflare:unknown-runtime", undefined, { isEntry: false }),
    ).toThrow(/no Node stub for "cloudflare:unknown-runtime"/);
  });
});

describe("Cloudflare Worker entry", () => {
  function workerPlugin(options: Parameters<typeof cloudflareAdapter>[0] = {}): Plugin {
    const plugin = cloudflareAdapter(options)
      .vitePlugins?.()
      .find((candidate) => candidate.name === "pracht:cloudflare-worker");
    if (!plugin) throw new Error("Expected the pracht:cloudflare-worker plugin.");
    return plugin;
  }

  function hook<T>(value: unknown): T {
    const handler =
      typeof value === "function" ? value : (value as { handler?: unknown } | undefined)?.handler;
    if (typeof handler !== "function") throw new Error("Expected a plugin hook.");
    return handler as T;
  }

  it("exports only the default handler and the app's entrypoint classes", () => {
    expect(createCloudflareWorkerModule()).toBe(
      'export { default } from "virtual:pracht/server";\n',
    );
    expect(createCloudflareWorkerModule({ workerExportsFrom: "/src/cloudflare.ts" })).toBe(
      'export { default } from "virtual:pracht/server";\nexport * from "/src/cloudflare.ts";\n',
    );
    // The app's Worker module: its default reaches the entry through
    // virtual:pracht/server, which registers pracht's fetch for it.
    expect(createCloudflareWorkerModule({ workerEntry: "./src/worker.ts" })).toBe(
      'export { default } from "virtual:pracht/server";\nexport * from "/src/worker.ts";\n',
    );
  });

  it("serves the Worker entry module the Cloudflare plugin runs", async () => {
    const plugin = workerPlugin({ workerExportsFrom: "/src/cloudflare.ts" });
    const resolved = await hook<(id: string) => unknown>(plugin.resolveId).call(
      {} as never,
      PRACHT_CLOUDFLARE_WORKER_MODULE_ID,
    );
    expect(resolved).toBe(`\0${PRACHT_CLOUDFLARE_WORKER_MODULE_ID}`);
    const source = await hook<(id: string) => unknown>(plugin.load).call(
      {} as never,
      String(resolved),
    );
    expect(source).toContain('export * from "/src/cloudflare.ts";');
  });

  it("lays out the build as dist/server/worker.js beside the server.js prerender entry", () => {
    const plugin = workerPlugin();
    // oxlint-disable-next-line typescript/no-explicit-any -- inspecting a Vite config fragment
    type ConfigFragment = Record<string, any> | undefined;
    const config = hook<(config: object, env: object) => ConfigFragment>(plugin.config);

    expect(config({}, { command: "serve", mode: "development" })).toBeUndefined();

    const build = config({}, { command: "build", mode: "production", isSsrBuild: true });
    expect(build?.environments.client.build.outDir).toBe("dist/client");
    expect(build?.environments.ssr.build.outDir).toBe("dist/server");
    expect(build?.environments.ssr.build.rollupOptions.input).toEqual({
      server: "virtual:pracht/server",
    });
    const entryFileNames = build?.environments.ssr.build.rollupOptions.output.entryFileNames;
    expect(entryFileNames({ name: "index" })).toBe("worker.js");
    expect(entryFileNames({ name: "server" })).toBe("[name].js");
  });

  it("drops builtin externals an older vite-plugin sets on the Worker environment", () => {
    const plugin = workerPlugin();
    const configEnvironment = hook<(name: string, config: object, env: object) => void>(
      plugin.configEnvironment,
    );
    const config = { resolve: { external: ["node:module", "node:async_hooks", "some-package"] } };
    configEnvironment("ssr", config, { command: "build" });
    // The Cloudflare plugin rejects what is left with its own error.
    expect(config.resolve.external).toEqual(["some-package"]);
  });

  it("keeps the wrangler deploy redirect unless named environments were not selected", () => {
    const root = mkdtempSync(join(tmpdir(), "pracht-cf-redirect-"));
    const redirect = join(root, ".wrangler/deploy/config.json");
    const run = (generated: object) => {
      mkdirSync(join(root, ".wrangler/deploy"), { recursive: true });
      writeFileSync(redirect, "{}");
      const plugin = workerPlugin();
      hook<(config: object) => void>(plugin.configResolved)({ root });
      const context = { environment: { name: "ssr" } } as never;
      hook<(options: object, bundle: object) => void>(plugin.generateBundle).call(
        context,
        {},
        {
          "wrangler.json": { type: "asset", source: JSON.stringify(generated) },
        },
      );
      hook<() => void>(plugin.writeBundle).call(context);
      return existsSync(redirect);
    };

    try {
      expect(run({ definedEnvironments: [] })).toBe(true);
      expect(run({ definedEnvironments: ["staging"], targetEnvironment: "staging" })).toBe(true);
      // Built without CLOUDFLARE_ENV, the redirect would make
      // `wrangler deploy --env staging` ship the top-level config.
      expect(run({ definedEnvironments: ["staging"] })).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
