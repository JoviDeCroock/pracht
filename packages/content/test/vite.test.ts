import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Connect, ViteDevServer } from "vite";
import { build, createServer as createViteServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineCollection } from "../src/index.ts";
import { prachtContent } from "../src/vite.ts";

let temporaryDirectory: string | undefined;

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { force: true, recursive: true });
  temporaryDirectory = undefined;
});

function hookHandler<T extends (...args: any[]) => any>(hook: T | { handler: T } | undefined): T {
  if (!hook) throw new Error("Expected Vite hook");
  return typeof hook === "function" ? hook : hook.handler;
}

/** Read back the snapshot a generated collection module embeds. */
function loadedSnapshot(result: unknown): Record<string, any> {
  const code =
    typeof result === "string" ? result : ((result as { code?: string } | null)?.code ?? "");
  const serialized = /JSON\.parse\((".*")\)/.exec(code)?.[1];
  if (!serialized) throw new Error("Expected a serialized snapshot");
  return JSON.parse(JSON.parse(serialized));
}

describe("prachtContent", () => {
  it("transforms registered sources through the collection compiler", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    const source = join(temporaryDirectory, "page.md");
    const unregistered = join(temporaryDirectory, "draft.md");
    await writeFile(source, "# File");
    await writeFile(unregistered, "# Draft");
    const collection = defineCollection({
      name: "docs",
      root: temporaryDirectory,
      sources: [{ source: "page.md" }],
      module: (document) => `export const markdown = ${JSON.stringify(document.raw)};`,
    });
    const [plugin] = prachtContent({ collections: [collection] });
    const transform = hookHandler(plugin.transform);

    const result = await transform.call({} as never, "# Live", source);
    expect(typeof result === "string" ? result : result?.code).toContain(
      'export const markdown = "# Live"',
    );
    expect(
      await transform.call({} as never, "text", join(temporaryDirectory, "page.txt")),
    ).toBeNull();
    expect(await transform.call({} as never, "# Draft", unregistered)).toBeNull();
    expect(await transform.call({} as never, 'export default "# Raw"', `${source}?raw`)).toBeNull();
    expect(
      await transform.call({} as never, 'export default "/page.md"', `${source}?url`),
    ).toBeNull();
    expect(
      await transform.call(
        {} as never,
        "export default function WorkerWrapper() {}",
        `${source}?worker`,
      ),
    ).toBeNull();
    expect(
      await transform.call(
        {} as never,
        "export default function SharedWorkerWrapper() {}",
        `${source}?sharedworker&inline`,
      ),
    ).toBeNull();
    const clientResult = await transform.call({} as never, "# Client", `${source}?pracht-client`);
    expect(typeof clientResult === "string" ? clientResult : clientResult?.code).toContain(
      'export const markdown = "# Client"',
    );
    const hmrResult = await transform.call({} as never, "# HMR", `${source}?t=123`);
    expect(typeof hmrResult === "string" ? hmrResult : hmrResult?.code).toContain(
      'export const markdown = "# HMR"',
    );
  });

  it("generates a filesystem-free production module for each collection", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    await writeFile(join(temporaryDirectory, "page.md"), "Page");
    const collection = defineCollection({ name: "docs", root: temporaryDirectory });
    const [plugin] = prachtContent({ collections: [collection] });
    const resolveId = hookHandler(plugin.resolveId);
    const load = hookHandler(plugin.load);

    const resolved = await resolveId.call(
      {} as never,
      "virtual:pracht/content/docs",
      undefined,
      {} as never,
    );
    expect(resolved).toBe("\0virtual:pracht/content/docs");
    const result = await load.call({} as never, String(resolved));
    const code = typeof result === "string" ? result : result?.code;
    expect(code).toContain('from "@pracht/content/runtime"');
    expect(code).toContain("const snapshot = JSON.parse(");
    expect(code).toContain('\\"body\\":\\"Page\\"');
    expect(code).not.toContain(temporaryDirectory);
    expect(code).not.toContain("node:fs");
  });

  it("resolves literal percent signs in collection names without throwing", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    const collection = defineCollection({ name: "100%", root: temporaryDirectory });
    const [plugin] = prachtContent({ collections: [collection] });
    const resolveId = hookHandler(plugin.resolveId);

    expect(resolveId.call({} as never, "virtual:pracht/content/100%", undefined, {} as never)).toBe(
      "\0virtual:pracht/content/100%25",
    );
    expect(
      resolveId.call({} as never, "virtual:pracht/content/missing%", undefined, {} as never),
    ).toBeNull();
  });

  it("omits opted-out source representations from the generated module", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    await writeFile(join(temporaryDirectory, "page.md"), "---\ntitle: Page\n---\nBody");
    const collection = defineCollection({
      name: "docs",
      root: temporaryDirectory,
      snapshot: { body: false, raw: false },
    });
    const [plugin] = prachtContent({ collections: [collection] });

    const snapshot = loadedSnapshot(
      await hookHandler(plugin.load).call({} as never, "\0virtual:pracht/content/docs"),
    );

    expect(snapshot.fields).toEqual({ body: false, raw: false });
    expect(snapshot.documents).toEqual([
      {
        compiled: "Body",
        frontmatter: { title: "Page" },
        id: "page",
        path: "/page",
        relativeSource: "page.md",
      },
    ]);
  });

  it("keeps every source representation in a generated module by default", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    await writeFile(join(temporaryDirectory, "page.md"), "---\ntitle: Page\n---\nBody");
    const collection = defineCollection({ name: "docs", root: temporaryDirectory });
    const [plugin] = prachtContent({ collections: [collection] });

    const snapshot = loadedSnapshot(
      await hookHandler(plugin.load).call({} as never, "\0virtual:pracht/content/docs"),
    );

    expect(snapshot.fields).toBeUndefined();
    expect(snapshot.documents[0]).toMatchObject({
      body: "Body",
      raw: "---\ntitle: Page\n---\nBody",
    });
  });

  it("runs a bundled collection snapshot after the source tree is removed", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    const source = join(temporaryDirectory, "page.md");
    const output = join(temporaryDirectory, "dist");
    await writeFile(source, "---\n__proto__:\n  published: true\n---\nPortable");
    const collection = defineCollection({
      name: "docs",
      root: temporaryDirectory,
      routeBase: "/docs",
    });

    await build({
      configFile: false,
      logLevel: "silent",
      plugins: prachtContent({ collections: [collection] }),
      resolve: {
        alias: {
          "@pracht/content/runtime": fileURLToPath(new URL("../src/runtime.ts", import.meta.url)),
        },
      },
      build: {
        outDir: output,
        ssr: true,
        rollupOptions: { input: "virtual:pracht/content/docs" },
      },
    });
    await rm(source);
    const [entry] = (await readdir(output)).filter((file) => /\.m?js$/.test(file));
    const runtime = (await import(pathToFileURL(join(output, entry)).href)).default;

    const document = await runtime.getByRoute("/docs/page");
    expect(document).toMatchObject({ body: "Portable" });
    expect(Object.hasOwn(document.frontmatter, "__proto__")).toBe(true);
    expect(document.frontmatter.__proto__).toEqual({ published: true });
  });

  it("invalidates generated runtime modules when a collection source changes", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    const source = join(temporaryDirectory, "page.md");
    await writeFile(source, "First");
    const collection = defineCollection({ name: "docs", root: temporaryDirectory });
    const [plugin] = prachtContent({ collections: [collection] });
    const configureServer = hookHandler(plugin.configureServer);
    const load = hookHandler(plugin.load);
    let change: ((file: string) => void) | undefined;
    const runtimeModule = {};
    const invalidateModule = vi.fn();
    const add = vi.fn();
    const server = {
      moduleGraph: {
        getModuleById: vi.fn(() => runtimeModule),
        invalidateModule,
      },
      watcher: {
        add,
        on(event: string, handler: (file: string) => void) {
          if (event === "change") change = handler;
        },
      },
    } as unknown as ViteDevServer;
    configureServer.call({} as never, server);

    await writeFile(source, "Second");
    change?.(source);
    const result = await load.call({} as never, "\0virtual:pracht/content/docs");
    const code = typeof result === "string" ? result : result?.code;

    expect(code).toContain('\\"body\\":\\"Second\\"');
    expect(invalidateModule).toHaveBeenCalledWith(runtimeModule);
    // A root outside Vite's own project root emits no events until it is
    // watched explicitly, which would serve stale content for the session.
    expect(add).toHaveBeenCalledWith(temporaryDirectory);
  });

  it("emits deploy-safe headers for production artifacts in the asset namespace", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    await writeFile(join(temporaryDirectory, "page.md"), "Page");
    const collection = defineCollection({
      name: "docs",
      root: temporaryDirectory,
      artifacts: [
        () => ({ path: "/assets/search.data", source: "{}", contentType: "application/json" }),
      ],
    });
    const [, plugin] = prachtContent({ collections: [collection] });
    const generateBundle = hookHandler(plugin.generateBundle);
    const emitFile = vi.fn();

    await generateBundle.call({ emitFile } as never, {} as never, {} as never, false);

    expect(emitFile).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "assets/search.data", source: "{}" }),
    );
    expect(emitFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: "_pracht/content-headers.json",
        source: expect.stringContaining('"cache-control": "public, max-age=0, must-revalidate"'),
      }),
    );
    expect(emitFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: "_pracht/content-headers.json",
        source: expect.stringContaining('"content-type": "application/json"'),
      }),
    );
  });

  it("hands the CLI the generated routes so the app manifest can be reconciled", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    await mkdir(join(temporaryDirectory, "en"));
    await writeFile(join(temporaryDirectory, "en/guide.md"), "---\ntitle: Guide\n---\nBody");
    const collection = defineCollection({
      name: "docs",
      root: temporaryDirectory,
      routeBase: "/docs",
      locales: { default: "en", supported: ["en", "nl"] },
    });
    const [, plugin] = prachtContent({ collections: [collection] });
    const emitFile = vi.fn();

    await hookHandler(plugin.generateBundle).call(
      { emitFile } as never,
      {} as never,
      {} as never,
      false,
    );

    const call = emitFile.mock.calls.find(
      ([file]) => file.fileName === "_pracht/content-routes.json",
    );
    expect(JSON.parse(call?.[0].source)).toEqual({
      policy: "warn",
      collections: {
        docs: [
          { path: "/docs/guide", source: "en/guide.md" },
          { path: "/nl/docs/guide", source: "en/guide.md" },
        ],
      },
    });
  });

  it("preserves prototype-named collections in the route manifest", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    await writeFile(join(temporaryDirectory, "guide.md"), "Body");
    const collection = defineCollection({
      name: "__proto__",
      root: temporaryDirectory,
      routeBase: "/docs",
    });
    const [, plugin] = prachtContent({
      collections: [collection],
      unroutedDocuments: "error",
    });
    const emitFile = vi.fn();

    await hookHandler(plugin.generateBundle).call(
      { emitFile } as never,
      {} as never,
      {} as never,
      false,
    );

    const call = emitFile.mock.calls.find(
      ([file]) => file.fileName === "_pracht/content-routes.json",
    );
    const manifest = JSON.parse(call?.[0].source);
    expect(Object.hasOwn(manifest.collections, "__proto__")).toBe(true);
    expect(manifest).toEqual({
      policy: "error",
      collections: Object.fromEntries([
        ["__proto__", [{ path: "/docs/guide", source: "guide.md" }]],
      ]),
    });
  });

  it("omits the route manifest for a data-only collection", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    await writeFile(join(temporaryDirectory, "guide.md"), "Body");
    const collection = defineCollection({ name: "docs", root: temporaryDirectory });
    const [, plugin] = prachtContent({
      collections: [collection],
      unroutedDocuments: "ignore",
    });
    const emitFile = vi.fn();

    await hookHandler(plugin.generateBundle).call(
      { emitFile } as never,
      {} as never,
      {} as never,
      false,
    );

    expect(
      emitFile.mock.calls.some(([file]) => file.fileName === "_pracht/content-routes.json"),
    ).toBe(false);
  });

  it("rejects a route manifest that collides with existing Vite output", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    await writeFile(join(temporaryDirectory, "guide.md"), "Body");
    const collection = defineCollection({ name: "docs", root: temporaryDirectory });
    const [, plugin] = prachtContent({ collections: [collection] });

    await expect(
      hookHandler(plugin.generateBundle).call(
        { emitFile: vi.fn() } as never,
        {} as never,
        { "_PRACHT/CONTENT-ROUTES.JSON": {} } as never,
        false,
      ),
    ).rejects.toThrow(/content routes manifest collides with existing Vite build output/);
  });

  it("rejects an unknown unroutedDocuments policy", () => {
    expect(() => prachtContent({ collections: [], unroutedDocuments: "fail" as never })).toThrow(
      /`unroutedDocuments` must be "error", "warn", or "ignore"/,
    );
  });

  it("rejects artifacts that collide with the internal content headers manifest", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    await writeFile(join(temporaryDirectory, "page.md"), "Page");
    for (const path of ["/_PRACHT/content-headers.json", "/_pracht"]) {
      const collection = defineCollection({
        name: "docs",
        root: temporaryDirectory,
        artifacts: [() => ({ path, source: "shadow" })],
      });
      const [, plugin] = prachtContent({ collections: [collection] });
      const generateBundle = hookHandler(plugin.generateBundle);

      await expect(
        generateBundle.call({ emitFile: vi.fn() } as never, {} as never, {} as never, false),
      ).rejects.toThrow(/internal content headers manifest/);
    }
  });

  it("rejects artifacts in Pracht's reserved build output namespace", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    await writeFile(join(temporaryDirectory, "page.md"), "Page");

    for (const path of [
      "/_pracht/headers.json",
      "/_pracht/markdown.json",
      "/_pracht/isg.json",
      "/_PRACHT/custom.json",
    ]) {
      const collection = defineCollection({
        name: "docs",
        root: temporaryDirectory,
        artifacts: [() => ({ path, source: "shadow" })],
      });
      const [, plugin] = prachtContent({ collections: [collection] });
      const generateBundle = hookHandler(plugin.generateBundle);

      await expect(
        generateBundle.call({ emitFile: vi.fn() } as never, {} as never, {} as never, false),
      ).rejects.toThrow(/reserved \/_pracht build output namespace/);
    }
  });

  it("rejects case-folded and file-directory artifact output collisions", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    await writeFile(join(temporaryDirectory, "page.md"), "Page");

    for (const paths of [
      ["/Feed.json", "/feed.json"],
      ["/feed", "/feed/items.json"],
    ]) {
      const collection = defineCollection({
        name: "docs",
        root: temporaryDirectory,
        artifacts: [() => paths.map((path) => ({ path, source: path }))],
      });
      const [, plugin] = prachtContent({ collections: [collection] });
      const generateBundle = hookHandler(plugin.generateBundle);

      await expect(
        generateBundle.call({ emitFile: vi.fn() } as never, {} as never, {} as never, false),
      ).rejects.toThrow(/portable output-path collision/);
    }
  });

  it("rejects artifacts that collide with existing Vite bundle output", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    await writeFile(join(temporaryDirectory, "page.md"), "Page");

    for (const path of ["/assets/entry.js", "/assets"]) {
      const collection = defineCollection({
        name: "docs",
        root: temporaryDirectory,
        artifacts: [() => ({ path, source: "shadow" })],
      });
      const [, plugin] = prachtContent({ collections: [collection] });
      const generateBundle = hookHandler(plugin.generateBundle);

      await expect(
        generateBundle.call(
          { emitFile: vi.fn() } as never,
          {} as never,
          { "assets/entry.js": {} } as never,
          false,
        ),
      ).rejects.toThrow(/collides with existing Vite build output/);
    }
  });

  it("serves generated artifacts in development with HEAD and method handling", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    await writeFile(join(temporaryDirectory, "page.md"), "Page");
    const collection = defineCollection({
      name: "docs",
      root: temporaryDirectory,
      artifacts: [() => ({ path: "/content.txt", source: "content", contentType: "text/plain" })],
    });
    const [, plugin] = prachtContent({ collections: [collection] });
    let middleware: Connect.NextHandleFunction | undefined;
    const server = {
      config: { logger: { error: vi.fn() } },
      middlewares: { use: (handler: Connect.NextHandleFunction) => (middleware = handler) },
      ssrFixStacktrace: vi.fn(),
    } as unknown as ViteDevServer;
    const postHook = hookHandler(plugin.configureServer).call({} as never, server);
    if (typeof postHook !== "function") throw new Error("Expected post configure hook");
    postHook();
    if (!middleware) throw new Error("Expected middleware");

    expect(await runMiddleware(middleware, "/content.txt", "GET")).toMatchObject({
      body: "content",
      status: 200,
    });
    expect(await runMiddleware(middleware, "/content.txt", "HEAD")).toMatchObject({
      body: "",
      status: 200,
    });
    expect(await runMiddleware(middleware, "/content.txt", "POST")).toMatchObject({ status: 405 });
  });

  it("serves generated artifacts beneath Vite's configured base", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    await writeFile(join(temporaryDirectory, "page.md"), "Page");
    const collection = defineCollection({
      name: "docs",
      root: temporaryDirectory,
      artifacts: [() => ({ path: "/content.txt", source: "content", contentType: "text/plain" })],
    });
    const server = await createViteServer({
      appType: "custom",
      base: "/app/",
      configFile: false,
      logLevel: "silent",
      plugins: prachtContent({ collections: [collection] }),
      root: temporaryDirectory,
      server: { middlewareMode: true },
    });
    const httpServer = createHttpServer(server.middlewares);

    try {
      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
      const address = httpServer.address();
      if (!address || typeof address === "string") throw new Error("Expected Vite HTTP server");
      const response = await fetch(`http://127.0.0.1:${address.port}/app/content.txt`);

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("content");
    } finally {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
      await server.close();
    }
  });

  it("keeps artifact failures scoped to known artifact routes", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    await writeFile(join(temporaryDirectory, "page.md"), "Page");
    let shouldFail = false;
    const collection = defineCollection({
      name: "docs",
      root: temporaryDirectory,
      artifacts: [
        () => {
          if (shouldFail) throw new Error("Invalid content");
          return { path: "/content.txt", source: "content" };
        },
      ],
    });
    const [, plugin] = prachtContent({ collections: [collection] });
    let middleware: Connect.NextHandleFunction | undefined;
    const server = {
      config: { logger: { error: vi.fn() } },
      middlewares: { use: (handler: Connect.NextHandleFunction) => (middleware = handler) },
      ssrFixStacktrace: vi.fn(),
    } as unknown as ViteDevServer;
    const postHook = hookHandler(plugin.configureServer).call({} as never, server);
    if (typeof postHook !== "function") throw new Error("Expected post configure hook");
    postHook();
    if (!middleware) throw new Error("Expected middleware");

    expect(await runMiddleware(middleware, "/content.txt", "GET")).toMatchObject({ status: 200 });
    shouldFail = true;
    collection.invalidate();
    expect(await runMiddleware(middleware, "/@vite/client", "GET")).toMatchObject({
      next: true,
      status: 200,
    });
    expect(await runMiddleware(middleware, "/content.txt", "GET")).toMatchObject({
      body: "Content artifact generation failed",
      next: false,
      status: 500,
    });
  });
});

async function runMiddleware(
  middleware: Connect.NextHandleFunction,
  url: string,
  method: string,
): Promise<{ body: string; headers: Record<string, string>; next: boolean; status: number }> {
  const request = { method, url } as IncomingMessage;
  const headers: Record<string, string> = {};
  let body = "";
  const response = {
    end(value?: unknown) {
      body = value === undefined ? "" : String(value);
    },
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = String(value);
    },
    statusCode: 200,
  } as unknown as ServerResponse;
  const next = vi.fn();
  await middleware(request, response, next);
  return { body, headers, next: next.mock.calls.length > 0, status: response.statusCode };
}
