import { readFileSync } from "node:fs";
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
    server = await createFixtureServer();
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

/**
 * Vite's own Oxc pass registers only a file that is JSX or imports the JSX
 * runtime. Pracht registers every script module itself, so the modules a
 * JSX-only pass would skip are still tracked.
 */
describe("Fast Refresh for plain modules", () => {
  let server: ViteDevServer;

  beforeAll(async () => {
    server = await createFixtureServer();
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it("signs a custom hook in a .ts file", async () => {
    const result = await server.transformRequest("/src/lib/use-tally.ts");

    expect(result?.code).toContain("$RefreshSig$()");
    expect(result?.code).toContain("__PREFRESH__");
  });

  it("registers a component written with h() in a .ts file", async () => {
    const result = await server.transformRequest("/src/lib/legacy.ts");

    expect(result?.code).toContain('$RefreshReg$(_c, "Legacy")');
    expect(result?.code).toContain("import.meta.hot.accept");
  });

  it("keeps createContext() on a stable key and registers the module", async () => {
    const result = await server.transformRequest("/src/lib/theme.tsx");

    expect(result?.code).toMatch(/createContext\[`[0-9a-f]{16}\$Theme1`\]/);
    expect(result?.code).toContain('$RefreshReg$(_c, "ThemeLabel")');
    expect(result?.code).toContain("import.meta.hot.accept");
  });

  // Keeping the context stable repeats its multi-line argument, which moves
  // every line below it. The map has to follow.
  it("maps lines below a rewritten createContext() back to their source", async () => {
    const result = await server.transformRequest("/src/lib/theme.tsx");
    const source = readFileSync(resolve(FIXTURE_ROOT, "src/lib/theme.tsx"), "utf-8").split("\n");
    const generated = result!.code.split("\n");

    const sourceLine = source.findIndex((line) => line.includes("THEME_MARKER"));
    const generatedLine = generated.findIndex((line) => line.includes("THEME_MARKER"));
    expect(generatedLine).not.toBe(sourceLine);
    expect(originalLines(result!.map as { mappings: string }, generatedLine)).toContain(sourceLine);
  });

  it("still registers a component whose module mentions the refresh calls in a string", async () => {
    const result = await server.transformRequest("/src/lib/snippet.tsx");

    expect(result?.code).toContain('$RefreshReg$(_c, "Snippet")');
    expect(result?.code).toContain("import.meta.hot.accept");
  });

  it("does not wrap a module that only mentions the refresh calls in a string", async () => {
    const result = await server.transformRequest("/src/lib/snippet-only.ts");

    expect(result?.code).not.toContain("__PREFRESH__");
    expect(result?.code).not.toContain("import.meta.hot.accept");
  });

  it("leaves createContext() alone in the SSR module", async () => {
    const result = await server.transformRequest("/src/lib/theme.tsx", { ssr: true });

    expect(result?.code).not.toContain("createContext[");
    expect(result?.code).not.toContain("$RefreshReg$");
  });

  // The stages are taken as functions. Registered with Vite they would also
  // run their Babel fallback and rewrite createContext() for SSR.
  it("registers none of @prefresh/vite's plugins with Vite", () => {
    const names = server.config.plugins.map((plugin) => plugin.name);

    expect(names).toContain("pracht:fast-refresh");
    expect(names.filter((name) => name.startsWith("prefresh"))).toEqual([]);
  });
});

/**
 * Without the HMR client nothing defines `$RefreshReg$`, so a module that
 * called it would throw while the page hydrates. Another plugin can turn HMR
 * off from its own `config` hook, after pracht's has run.
 */
describe("Fast Refresh with HMR turned off by a later plugin", () => {
  let server: ViteDevServer;

  beforeAll(async () => {
    server = await createFixtureServer([
      { name: "test:late-no-hmr", config: () => ({ server: { hmr: false } }) },
    ]);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it.each(["/src/routes/home.tsx?pracht-client", "/src/lib/legacy.ts", "/src/lib/theme.tsx"])(
    "emits no refresh calls in %s",
    async (url) => {
      const result = await server.transformRequest(url);

      expect(result?.code).not.toContain("$RefreshReg$");
      expect(result?.code).not.toContain("$RefreshSig$");
      expect(result?.code).not.toContain("createContext[");
    },
  );
});

function createFixtureServer(extraPlugins: Plugin[] = []): Promise<ViteDevServer> {
  return createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [
      compiledRouteFormat(),
      pracht({ additionalExtensions: [".custom"] }),
      ...extraPlugins,
    ],
    optimizeDeps: { noDiscovery: true },
    root: FIXTURE_ROOT,
    // No watcher: the test only transforms modules, and a live watcher keeps
    // the process alive past `close()`.
    server: { middlewareMode: true, watch: null },
  });
}

/** The zero-based source lines a generated line maps to. */
function originalLines(map: { mappings: string }, generatedLine: number): number[] {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lines: number[] = [];
  let sourceLine = 0;
  map.mappings.split(";").forEach((line, index) => {
    for (const segment of line.split(",")) {
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const char of segment) {
        const digit = alphabet.indexOf(char);
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
          continue;
        }
        fields.push(value & 1 ? -(value >> 1) : value >> 1);
        value = 0;
        shift = 0;
      }
      if (fields.length < 4) continue;
      sourceLine += fields[2];
      if (index === generatedLine) lines.push(sourceLine);
    }
  });
  return lines;
}

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
