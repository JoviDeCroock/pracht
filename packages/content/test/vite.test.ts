import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Connect, ViteDevServer } from "vite";
import { build } from "vite";
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
    expect(code).toContain('"body":"Page"');
    expect(code).not.toContain(temporaryDirectory);
    expect(code).not.toContain("node:fs");
  });

  it("runs a bundled collection snapshot after the source tree is removed", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    const source = join(temporaryDirectory, "page.md");
    const output = join(temporaryDirectory, "dist");
    await writeFile(source, "Portable");
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

    await expect(runtime.getByRoute("/docs/page")).resolves.toMatchObject({ body: "Portable" });
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
    const server = {
      moduleGraph: {
        getModuleById: vi.fn(() => runtimeModule),
        invalidateModule,
      },
      watcher: {
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

    expect(code).toContain('"body":"Second"');
    expect(invalidateModule).toHaveBeenCalledWith(runtimeModule);
  });

  it("emits artifact content types for the production headers manifest", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-vite-"));
    await writeFile(join(temporaryDirectory, "page.md"), "Page");
    const collection = defineCollection({
      name: "docs",
      root: temporaryDirectory,
      artifacts: [() => ({ path: "/search.data", source: "{}", contentType: "application/json" })],
    });
    const [, plugin] = prachtContent({ collections: [collection] });
    const generateBundle = hookHandler(plugin.generateBundle);
    const emitFile = vi.fn();

    await generateBundle.call({ emitFile } as never, {} as never, {} as never, false);

    expect(emitFile).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "search.data", source: "{}" }),
    );
    expect(emitFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: "_pracht/content-headers.json",
        source: expect.stringContaining('"content-type": "application/json"'),
      }),
    );
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
    hookHandler(plugin.configureServer).call({} as never, server);
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
    hookHandler(plugin.configureServer).call({} as never, server);
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
