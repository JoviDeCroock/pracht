import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import { pracht } from "../src/index.ts";
import {
  DEV_PAGE_TOOLS_BROWSER_PATH,
  PRACHT_DEV_PAGE_TOOLS_MODULE_ID,
  isDevPageToolsModule,
} from "../src/plugin-assets.ts";
import {
  appCoreHasDevPageTools,
  createDevPageToolsScriptTag,
  createPrachtDevPageToolsModuleSource,
  shouldInjectDevPageTools,
} from "../src/plugin-dev-page-tools.ts";

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

/** An app root with an installed `@pracht/core` manifest; stale ones lack the entry. */
function createAppRoot(options: { stale: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "pracht-dev-page-tools-"));
  scratchDirs.push(root);
  const core = join(root, "node_modules", "@pracht", "core");
  mkdirSync(core, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app" }));
  writeFileSync(
    join(core, "package.json"),
    JSON.stringify({
      name: "@pracht/core",
      exports: {
        "./client": "./client.mjs",
        ...(options.stale ? {} : { "./dev-page-tools": "./dev-page-tools.mjs" }),
      },
    }),
  );
  writeFileSync(join(core, "client.mjs"), "export {};");
  return root;
}
const createStaleCoreRoot = () => createAppRoot({ stale: true });
const createCurrentCoreRoot = () => createAppRoot({ stale: false });

describe("dev page tools module", () => {
  it("resolves the virtual id and its browser path", () => {
    expect(isDevPageToolsModule(PRACHT_DEV_PAGE_TOOLS_MODULE_ID)).toBe(true);
    expect(isDevPageToolsModule(DEV_PAGE_TOOLS_BROWSER_PATH)).toBe(true);
    expect(isDevPageToolsModule(`\0${PRACHT_DEV_PAGE_TOOLS_MODULE_ID}`)).toBe(true);
    expect(isDevPageToolsModule("virtual:pracht/webmcp")).toBe(false);
  });

  it("feature-detects before importing the runtime and disposes on HMR", () => {
    const source = createPrachtDevPageToolsModuleSource({ root: createCurrentCoreRoot() });
    expect(source).toContain('const DEVTOOLS_JSON_URL = "/_pracht.json";');
    // The runtime import sits behind the feature check, so a browser without
    // the WebMCP API never loads it.
    expect(source.indexOf("document.modelContext")).toBeLessThan(
      source.indexOf('import("@pracht/core/dev-page-tools")'),
    );
    expect(source).toContain("registerDevPageTools({ devtoolsJsonUrl: DEVTOOLS_JSON_URL })");
    expect(source).toContain("import.meta.hot.dispose");
    expect(source).toContain("registration?.abort()");
  });

  it("carries the deploy base into the devtools JSON URL", () => {
    const source = createPrachtDevPageToolsModuleSource({
      root: createCurrentCoreRoot(),
      base: "/app/",
    });
    expect(source).toContain('const DEVTOOLS_JSON_URL = "/app/_pracht.json";');
  });

  it("degrades to one warning when the installed @pracht/core lacks the entry", () => {
    const root = createStaleCoreRoot();
    const source = createPrachtDevPageToolsModuleSource({ root });
    expect(source).toContain("console.warn(");
    expect(source).toContain("no dev-page-tools entry");
    expect(source).not.toContain("import(");
    expect(appCoreHasDevPageTools(root)).toBe(false);
    expect(appCoreHasDevPageTools(createCurrentCoreRoot())).toBe(true);
  });
});

describe("dev page tools script tag", () => {
  it("targets the browser path under the deploy base, in <head>", () => {
    expect(createDevPageToolsScriptTag("/")).toEqual({
      tag: "script",
      attrs: { type: "module", src: "/@pracht/dev-page-tools.js" },
      injectTo: "head",
    });
    expect(createDevPageToolsScriptTag("/app/").attrs).toEqual({
      type: "module",
      src: "/app/@pracht/dev-page-tools.js",
    });
  });

  it("skips the devtools page and its JSON twin", () => {
    expect(shouldInjectDevPageTools("/")).toBe(true);
    expect(shouldInjectDevPageTools("/notes?x=1")).toBe(true);
    expect(shouldInjectDevPageTools("/_pracht")).toBe(false);
    expect(shouldInjectDevPageTools("/_pracht?tab=agents")).toBe(false);
    expect(shouldInjectDevPageTools("/_pracht.json")).toBe(false);
    expect(shouldInjectDevPageTools("/_pracht-ish")).toBe(true);
  });
});

describe("pracht() plugin wiring", () => {
  function corePlugin(options: { isBuild?: boolean; devPageTools?: boolean } = {}): Plugin {
    const plugins = pracht(
      options.devPageTools === undefined ? {} : { devPageTools: options.devPageTools },
    );
    const plugin = plugins.find((candidate) => candidate.name === "pracht")!;
    callHook(plugin.configResolved, {
      base: "/",
      command: options.isBuild ? "build" : "serve",
      // A fixture root, not the workspace: the generated module's "does the
      // installed core carry the entry" probe must not depend on repo layout.
      root: createCurrentCoreRoot(),
      resolve: {},
    });
    return plugin;
  }

  function callHook<T>(hook: unknown, ...args: unknown[]): T {
    const fn = typeof hook === "function" ? hook : (hook as { handler: unknown }).handler;
    return (fn as (...args: unknown[]) => T).apply({}, args);
  }

  it("serves the module in dev and an empty module in a build", async () => {
    const dev = corePlugin();
    expect(callHook(dev.resolveId, DEV_PAGE_TOOLS_BROWSER_PATH, undefined, {})).toBe(
      PRACHT_DEV_PAGE_TOOLS_MODULE_ID,
    );
    const devSource = await callHook<Promise<string>>(dev.load, PRACHT_DEV_PAGE_TOOLS_MODULE_ID);
    expect(devSource).toContain("registerDevPageTools");

    const build = corePlugin({ isBuild: true });
    const buildSource = await callHook<Promise<string>>(
      build.load,
      PRACHT_DEV_PAGE_TOOLS_MODULE_ID,
    );
    expect(buildSource.trim()).toBe("export {};");
  });

  it("honours devPageTools: false by emitting neither the tag nor the module", async () => {
    const plugin = corePlugin({ devPageTools: false });
    const server = { config: { base: "/" }, moduleGraph: {} } as unknown as ViteDevServer;
    const html = "<!doctype html><html><head></head><body></body></html>";
    const result = await callHook<Promise<{ tags: unknown[] }>>(plugin.transformIndexHtml, html, {
      server,
      path: "/notes",
      filename: "index.html",
    });
    expect(result.tags).toEqual([]);
    const source = await callHook<Promise<string>>(plugin.load, PRACHT_DEV_PAGE_TOOLS_MODULE_ID);
    expect(source.trim()).toBe("export {};");
    expect(() => pracht({ devPageTools: "yes" as unknown as boolean })).toThrow(
      "pracht({ devPageTools }) expects a boolean.",
    );
  });

  it("injects the script tag into every dev document except the devtools page", async () => {
    const plugin = corePlugin();
    // A server whose CSS discovery throws: the tag must still be emitted,
    // because the page tools do not depend on the route's stylesheet graph.
    const server = {
      config: { base: "/app/" },
      moduleGraph: {},
    } as unknown as ViteDevServer;
    const html = "<!doctype html><html><head></head><body></body></html>";

    const result = await callHook<Promise<{ html: string; tags: unknown[] }>>(
      plugin.transformIndexHtml,
      html,
      { server, path: "/notes", filename: "index.html" },
    );
    expect(result.html).toBe(html);
    expect(result.tags).toEqual([
      {
        tag: "script",
        attrs: { type: "module", src: "/app/@pracht/dev-page-tools.js" },
        injectTo: "head",
      },
    ]);

    const devtools = await callHook<Promise<{ tags: unknown[] }>>(plugin.transformIndexHtml, html, {
      server,
      path: "/_pracht",
      filename: "index.html",
    });
    expect(devtools.tags).toEqual([]);

    // No <head>: nothing to inject into, and the hook stays a passthrough.
    const headless = await callHook<Promise<unknown>>(plugin.transformIndexHtml, "<p>x</p>", {
      server,
      path: "/notes",
      filename: "index.html",
    });
    expect(headless).toBe("<p>x</p>");
  });
});
