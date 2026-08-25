import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer as createViteServer, type Plugin, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pracht } from "../src/index.ts";

const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/fast-refresh-app");

/**
 * Route and shell modules reach the browser as `?pracht-client` variants so
 * pracht's post transform can strip server-only exports. `@prefresh/vite`
 * filters on ids ending in `.tsx`, so it skipped exactly those modules: no
 * `import.meta.hot.accept` was injected, and with no self-accepting boundary
 * every route edit escalated to a full page reload.
 */
describe("Fast Refresh for route and shell modules", () => {
  let server: ViteDevServer;

  beforeAll(async () => {
    server = await createViteServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      plugins: [compiledRouteFormat(), pracht({ additionalExtensions: [".custom"] })],
      optimizeDeps: { noDiscovery: true },
      root: FIXTURE_ROOT,
      // No watcher: the test only transforms modules, and a live watcher keeps
      // the process alive past `close()`.
      server: { middlewareMode: true, watch: null },
    });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it("injects a self-accepting Fast Refresh boundary into the client route module", async () => {
    const result = await server.transformRequest("/src/routes/home.tsx?pracht-client");

    expect(result?.code).toContain("import.meta.hot.accept");
    expect(result?.code).toContain("$RefreshReg$");
  });

  it("does the same for shells", async () => {
    const result = await server.transformRequest("/src/shells/public.tsx?pracht-client");

    expect(result?.code).toContain("import.meta.hot.accept");
  });

  it("injects Fast Refresh after an MDX companion compiles the client module", async () => {
    const result = await server.transformRequest("/src/routes/post.mdx?pracht-client");

    expect(result?.code).toContain("import.meta.hot.accept");
    expect(result?.code).toContain("$RefreshReg$");
    expect(result?.code).not.toContain('greeting: "mdx server"');
  });

  it("injects Fast Refresh into bare configured route formats", async () => {
    const result = await server.transformRequest("/src/routes/custom.custom");

    expect(result?.code).toContain("import.meta.hot.accept");
    expect(result?.code).toContain("$RefreshReg$");
    expect(result?.code).not.toContain('greeting: "custom server"');
  });

  // The server-only exports are still gone: Fast Refresh must not be bought by
  // shipping the loader to the browser.
  it("keeps stripping server-only exports from the client module", async () => {
    const result = await server.transformRequest("/src/routes/home.tsx?pracht-client");

    expect(result?.code).not.toContain('greeting: "hello"');
  });

  it("leaves the SSR module without a refresh runtime", async () => {
    const result = await server.transformRequest("/src/routes/home.tsx", { ssr: true });

    expect(result?.code).not.toContain("$RefreshReg$");
    expect(result?.code).toContain('greeting: "hello"');
  });

  /**
   * One file under `src/routes` reaches the browser as two module instances
   * whenever a sibling route imports it directly: the glob loads
   * `…/home.tsx?pracht-client`, the sibling loads `…/home.tsx`. They are
   * different function objects in different trees.
   *
   * Handing prefresh the query-stripped id made both register under one key.
   * `@prefresh/core` reads a second `register()` for a known key with a
   * different type as a pending component *replacement*, so a page that had
   * merely loaded both copies already carried queued updates it never asked
   * for — and the next unrelated Fast Refresh flushed them, running every
   * effect cleanup and clearing the hook dependency arrays of a component
   * nobody had edited. Asserting the two keys differ is not enough on its own;
   * the control is that the real registry stays quiet.
   */
  it("keeps the two copies of a route module on separate registration keys", async () => {
    const client = await server.transformRequest("/src/routes/home.tsx?pracht-client");
    const bare = await server.transformRequest("/src/routes/home.tsx");
    const clientKey = refreshRegistrationKey(client?.code);
    const bareKey = refreshRegistrationKey(bare?.code);

    expect(clientKey).toBeTruthy();
    expect(bareKey).toBeTruthy();

    // The control, run against the real runtime: both copies registered, zero
    // edits, and prefresh has nothing pending to flush. This is the assertion
    // that matters — "the keys differ" below only explains why it holds.
    const prefresh = await loadPrefreshRuntime();
    prefresh.flush();
    prefresh.register(function Component() {}, `${bareKey} Component`);
    prefresh.register(function Component() {}, `${clientKey} Component`);

    expect(prefresh.getPendingUpdates()).toEqual([]);
    expect(clientKey).not.toBe(bareKey);
  });
});

/** Stand-in for the companion compiler every non-JS route format requires. */
function compiledRouteFormat(): Plugin {
  return {
    name: "test:compiled-route-format",
    enforce: "pre",
    transform(_code, id) {
      const path = id.split("?", 1)[0];
      if (!path.endsWith(".mdx") && !path.endsWith(".custom")) return null;
      const label = path.endsWith(".mdx") ? "mdx" : "custom";
      return [
        'import { h } from "preact";',
        `export function loader() { return { greeting: "${label} server" }; }`,
        `export function Component() { return h("main", null, "${label}"); }`,
      ].join("\n");
    },
  };
}

/** The id prefresh baked into the module's `$RefreshReg$`. */
function refreshRegistrationKey(code: string | undefined): string | undefined {
  return /__PREFRESH__\.register\(type, "([^"]+)" \+ " " \+ id\)/.exec(code ?? "")?.[1];
}

interface PrefreshRuntime {
  flush(): void;
  getPendingUpdates(): unknown[];
  register(type: unknown, id: string): void;
}

/**
 * `@prefresh/core` is a transitive dependency (through `@prefresh/vite`) and
 * expects a browser global, so resolve it the way the plugin itself does and
 * give it a `self` before importing.
 */
async function loadPrefreshRuntime(): Promise<PrefreshRuntime> {
  const requireFromTest = createRequire(import.meta.url);
  const requireFromPrefreshVite = createRequire(requireFromTest.resolve("@prefresh/vite"));
  const globals = globalThis as { self?: unknown; __PREFRESH__?: PrefreshRuntime };
  globals.self ??= globalThis;
  await import(pathToFileURL(requireFromPrefreshVite.resolve("@prefresh/core")).href);
  return globals.__PREFRESH__ as PrefreshRuntime;
}
