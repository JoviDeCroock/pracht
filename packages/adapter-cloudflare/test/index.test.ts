import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { cloudflareAdapter, createCloudflareServerEntryModule } from "../src/index.ts";

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
    expect(source).toContain("createContext: createPrachtContext");
    expect(source).toContain("createCloudflareFetchHandler");
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

describe("cloudflareAdapter", () => {
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
      "RpcTarget",
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
