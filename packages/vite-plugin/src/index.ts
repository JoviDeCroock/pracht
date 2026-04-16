import preact from "@preact/preset-vite";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Connect, Plugin, ViteDevServer } from "vite";
import {
  PRACHT_CLIENT_MODULE_QUERY,
  isPrachtClientModuleId,
  stripPrachtClientModuleQuery,
  stripServerOnlyExportsForClient,
} from "./client-module-transform.ts";

import { generatePagesManifestSource, scanPagesDirectory } from "./pages-router.ts";

export const PRACHT_CLIENT_MODULE_ID = "virtual:pracht/client";
export const PRACHT_SERVER_MODULE_ID = "virtual:pracht/server";

// Browser-safe path alias — the colon in "virtual:" is parsed as a protocol
// scheme by browsers, so we serve the client module from a plain path.
const CLIENT_BROWSER_PATH = "/@pracht/client.js";

// Vite 8's SSR build prepends the project root to entry IDs before calling
// resolveId, so we may receive "/abs/path/virtual:pracht/server" instead of
// just "virtual:pracht/server".  These helpers match both forms.
function isClientModule(id: string): boolean {
  return (
    id === PRACHT_CLIENT_MODULE_ID ||
    id === CLIENT_BROWSER_PATH ||
    id.endsWith(PRACHT_CLIENT_MODULE_ID)
  );
}

function isServerModule(id: string): boolean {
  return id === PRACHT_SERVER_MODULE_ID || id.endsWith(PRACHT_SERVER_MODULE_ID);
}

/**
 * An adapter object that bridges pracht's platform-agnostic core to a specific
 * deployment target.  Built-in adapters are provided by `@pracht/adapter-node`,
 * `@pracht/adapter-cloudflare`, and `@pracht/adapter-vercel`.  You can also
 * supply a custom adapter that conforms to this interface.
 */
export interface PrachtAdapter {
  /** A short identifier used at build time (e.g. "node", "cloudflare", "vercel"). */
  id: string;
  /**
   * Extra import statements that must appear at the top of the generated
   * `virtual:pracht/server` module.  Return an empty string if none are needed.
   */
  serverImports: string;
  /**
   * Returns the JavaScript source code appended to the generated
   * `virtual:pracht/server` module.  This is where the adapter wires up its
   * request handler or default export.
   */
  createServerEntryModule(): string;
  /**
   * Additional Vite plugins the adapter needs (e.g. `@cloudflare/vite-plugin`).
   * Returned plugins are appended to the plugin array returned by `pracht()`.
   */
  vitePlugins?(): Plugin[] | Promise<Plugin[]>;
  /**
   * If true, the adapter owns dev-server request handling and the vite-plugin
   * will not install its own SSR middleware. Used when the adapter contributes
   * a Vite plugin that runs the dev server in a platform-specific runtime
   * (e.g. Cloudflare workerd via `@cloudflare/vite-plugin`).
   */
  ownsDevServer?: boolean;
}

function createDefaultNodeAdapter(): PrachtAdapter {
  return {
    id: "node",
    serverImports: 'import { resolveApp, resolveApiRoutes } from "@pracht/core";',
    createServerEntryModule() {
      return [
        'import { existsSync, readFileSync } from "node:fs";',
        'import { createServer } from "node:http";',
        'import { dirname, resolve } from "node:path";',
        'import { fileURLToPath, pathToFileURL } from "node:url";',
        'import { createNodeRequestHandler } from "@pracht/adapter-node";',
        "",
        "const serverDir = dirname(fileURLToPath(import.meta.url));",
        'const staticDir = resolve(serverDir, "../client");',
        'const isgManifestPath = resolve(serverDir, "isg-manifest.json");',
        "const isgManifest = existsSync(isgManifestPath)",
        '  ? JSON.parse(readFileSync(isgManifestPath, "utf-8"))',
        "  : {};",
        "",
        "export const handler = createNodeRequestHandler({",
        "  app: resolvedApp,",
        "  registry,",
        "  staticDir,",
        "  isgManifest,",
        "  apiRoutes,",
        "  clientEntryUrl: clientEntryUrl ?? undefined,",
        "  cssManifest,",
        "  jsManifest,",
        "});",
        "",
        "const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;",
        "if (entryHref && import.meta.url === entryHref) {",
        "  const server = createServer(handler);",
        "  const port = Number(process.env.PORT ?? 3000);",
        "  server.listen(port, () => {",
        "    console.log(`pracht node server listening on http://localhost:${port}`);",
        "  });",
        "}",
        "",
      ].join("\n");
    },
  };
}

export type RenderMode = "spa" | "ssr" | "ssg" | "isg";

export interface PrachtPluginOptions {
  appFile?: string;
  routesDir?: string;
  shellsDir?: string;
  middlewareDir?: string;
  apiDir?: string;
  serverDir?: string;
  adapter?: PrachtAdapter;
  /** Enable file-system pages routing by pointing to the pages directory (e.g. "/src/pages"). */
  pagesDir?: string;
  /** Default render mode for pages when RENDER_MODE is not exported. Defaults to "ssr". */
  pagesDefaultRender?: RenderMode;
}

type ResolvedPrachtPluginOptions = Required<PrachtPluginOptions>;

const DEFAULTS: ResolvedPrachtPluginOptions = {
  appFile: "/src/routes.ts",
  middlewareDir: "/src/middleware",
  routesDir: "/src/routes",
  shellsDir: "/src/shells",
  apiDir: "/src/api",
  serverDir: "/src/server",
  adapter: createDefaultNodeAdapter(),
  pagesDir: "",
  pagesDefaultRender: "ssr",
};

export async function pracht(options: PrachtPluginOptions = {}): Promise<Plugin[]> {
  const resolved = resolveOptions(options);
  const isPagesMode = !!resolved.pagesDir;
  let root = process.cwd();

  if (isPagesMode && options.appFile) {
    console.warn(
      "[pracht] Both `pagesDir` and `appFile` are set. `pagesDir` takes precedence — `appFile` will be ignored.",
    );
  }

  let isBuild = false;

  const prachtPlugin: Plugin = {
    name: "pracht",
    enforce: "pre",

    config(_config, env) {
      const isEdge = resolved.adapter.id === "vercel" || resolved.adapter.id === "cloudflare";
      const isSSRBuild = env.isSsrBuild;

      return {
        appType: "custom" as const,
        build: {
          rollupOptions: {
            output: {
              manualChunks(id: string) {
                if (
                  id.includes("node_modules/preact") ||
                  id.includes("node_modules/preact-suspense")
                ) {
                  return "vendor";
                }
              },
            },
          },
        },
        ...(isEdge && isSSRBuild
          ? {
              ssr: {
                noExternal: true,
              },
            }
          : {}),
      };
    },

    configResolved(config) {
      root = config.root;
      isBuild = config.command === "build";
    },

    resolveId(id) {
      if (isClientModule(id)) return PRACHT_CLIENT_MODULE_ID;
      if (isServerModule(id)) return PRACHT_SERVER_MODULE_ID;
      return null;
    },

    load(id) {
      if (isClientModule(id)) {
        return createPrachtClientModuleSource(resolved, { root });
      }
      if (isServerModule(id)) {
        return createPrachtServerModuleSource(resolved, { root, isBuild });
      }
      return null;
    },

    transform(code, id) {
      if (isPrachtClientModuleId(id)) {
        return { code: stripServerOnlyExportsForClient(code), map: null };
      }

      // Transform () => import("./path") to "./path" in the app manifest file.
      // This lets users write import() for IDE click-to-navigate while keeping
      // the framework's string-based file resolution intact.
      const appFileAbs = resolve(root, resolved.appFile.slice(1));
      if (id !== appFileAbs) return null;

      const transformed = code.replace(/\(\)\s*=>\s*import\(\s*(['"])([^'"]+)\1\s*\)/g, "$1$2$1");
      if (transformed === code) return null;
      return { code: transformed, map: null };
    },

    configureServer(server) {
      // Watch pages directory for file add/unlink → restart (new routes need new globs)
      if (isPagesMode) {
        const abs = resolve(root, resolved.pagesDir.slice(1));
        server.watcher.on("add", (f: string) => {
          if (f.startsWith(abs)) server.restart();
        });
        server.watcher.on("unlink", (f: string) => {
          if (f.startsWith(abs)) server.restart();
        });
      }

      if (resolved.adapter.ownsDevServer) return;
      return () => {
        server.middlewares.use(createDevSSRMiddleware(server, resolved));
      };
    },

    handleHotUpdate({ file, server }) {
      const root = server.config.root;
      const relative = file.startsWith(root) ? file.slice(root.length) : file;

      // Pages mode: edits to page files invalidate virtual modules
      if (isPagesMode && relative.startsWith(resolved.pagesDir)) {
        const clientMod = server.moduleGraph.getModuleById(PRACHT_CLIENT_MODULE_ID);
        const serverMod = server.moduleGraph.getModuleById(PRACHT_SERVER_MODULE_ID);
        if (clientMod) server.moduleGraph.invalidateModule(clientMod);
        if (serverMod) server.moduleGraph.invalidateModule(serverMod);
        return;
      }

      // App manifest changed — restart server (route definitions may have changed)
      if (!isPagesMode && relative === resolved.appFile) {
        server.restart();
        return [];
      }

      // Route/shell/middleware/API file changed — invalidate server module
      // so the registry re-evaluates on next request.
      const dirs = [
        resolved.routesDir,
        resolved.shellsDir,
        resolved.middlewareDir,
        resolved.apiDir,
        resolved.serverDir,
      ];
      if (dirs.some((dir) => relative.startsWith(dir))) {
        const serverMod = server.moduleGraph.getModuleById(PRACHT_SERVER_MODULE_ID);
        if (serverMod) server.moduleGraph.invalidateModule(serverMod);
        // Don't return [] — let Vite's default HMR handle the component update
      }
    },
  };

  const plugins: Plugin[] = [...preact(), prachtPlugin];

  const adapterPlugins = await resolved.adapter.vitePlugins?.();
  if (adapterPlugins?.length) {
    plugins.push(...adapterPlugins);
  }

  return plugins;
}

// ---------------------------------------------------------------------------
// Virtual module source generators
// ---------------------------------------------------------------------------

export function createPrachtClientModuleSource(
  options: PrachtPluginOptions = {},
  buildOptions: { root?: string } = {},
): string {
  const resolved = resolveOptions(options);
  const isPagesMode = !!resolved.pagesDir;

  const appImport = isPagesMode
    ? generatePagesAppInlineSource(resolved, buildOptions.root)
    : `import { app } from ${JSON.stringify(resolved.appFile)};`;

  const routeGlob = isPagesMode
    ? `${resolved.pagesDir}/**/*.{ts,tsx,js,jsx,md,mdx}`
    : `${resolved.routesDir}/**/*.{ts,tsx,js,jsx,md,mdx}`;

  const shellGlob = isPagesMode
    ? `${resolved.pagesDir}/**/_app.{ts,tsx,js,jsx}`
    : `${resolved.shellsDir}/**/*.{ts,tsx,js,jsx,md,mdx}`;

  return [
    'import { resolveApp, initClientRouter, readHydrationState } from "@pracht/core";',
    appImport,
    "",
    `const routeModules = import.meta.glob(${JSON.stringify(routeGlob)}, { query: ${JSON.stringify(PRACHT_CLIENT_MODULE_QUERY)} });`,
    `const shellModules = import.meta.glob(${JSON.stringify(shellGlob)}, { query: ${JSON.stringify(PRACHT_CLIENT_MODULE_QUERY)} });`,
    "",
    "const resolvedApp = resolveApp(app);",
    "",
    "function normalizeModuleKey(key) {",
    '  return key.split("?")[0];',
    "}",
    "",
    "function findModuleKey(modules, file) {",
    "  if (file in modules) return file;",
    '  const suffix = file.replace(/^\\.\\//,"");',
    "  for (const key of Object.keys(modules)) {",
    "    const normalizedKey = normalizeModuleKey(key);",
    '    if (normalizedKey.endsWith("/" + suffix) || normalizedKey.endsWith(suffix)) return key;',
    "  }",
    "  return null;",
    "}",
    "",
    "const state = readHydrationState();",
    'const root = document.getElementById("pracht-root");',
    "if (state && root) {",
    "  initClientRouter({",
    "    app: resolvedApp,",
    "    routeModules,",
    "    shellModules,",
    "    initialState: state,",
    "    root,",
    "    findModuleKey,",
    "  });",
    "}",
    "",
  ].join("\n");
}

export function createPrachtServerModuleSource(
  options: PrachtPluginOptions = {},
  buildOptions: {
    root?: string;
    isBuild?: boolean;
  } = {},
): string {
  const resolved = resolveOptions(options);
  const isPagesMode = !!resolved.pagesDir;
  const registrySource = createPrachtRegistryModuleSource(resolved);
  const clientBuild = buildOptions.isBuild
    ? readClientBuildAssets(buildOptions.root)
    : { clientEntryUrl: null, cssManifest: {}, jsManifest: {} };
  const adapter = resolved.adapter;

  // The adapter tells us what extra imports it needs (e.g. handlePrachtRequest).
  // Always import prerenderApp so the CLI uses the same bundled copy of
  // @pracht/core (and therefore the same Preact context instances) as the
  // route/shell modules — avoids dual-copy issues during SSG prerendering.
  const prachtImports = adapter?.serverImports
    ? adapter.serverImports + '\nimport { prerenderApp } from "@pracht/core";'
    : 'import { resolveApp, resolveApiRoutes, prerenderApp } from "@pracht/core";';

  const appImport = isPagesMode
    ? generatePagesAppInlineSource(resolved, buildOptions.root)
    : `import { app } from ${JSON.stringify(resolved.appFile)};`;

  const source = [
    prachtImports,
    appImport,
    "",
    registrySource,
    "",
    "export const resolvedApp = resolveApp(app);",
    `export const apiRoutes = resolveApiRoutes(Object.keys(apiModules), ${JSON.stringify(resolved.apiDir)});`,
    `export const buildTarget = ${JSON.stringify(adapter?.id ?? "node")};`,
    `export const clientEntryUrl = ${JSON.stringify(clientBuild.clientEntryUrl ?? CLIENT_BROWSER_PATH)};`,
    `export const cssManifest = ${JSON.stringify(clientBuild.cssManifest)};`,
    `export const jsManifest = ${JSON.stringify(clientBuild.jsManifest)};`,
    "export { prerenderApp };",
    "",
  ];

  if (adapter) {
    source.push(adapter.createServerEntryModule());
  }

  return source.join("\n");
}

export function createPrachtRegistryModuleSource(options: PrachtPluginOptions = {}): string {
  const resolved = resolveOptions(options);
  const isPagesMode = !!resolved.pagesDir;

  const routeGlob = isPagesMode
    ? `${resolved.pagesDir}/**/*.{ts,tsx,js,jsx,md,mdx}`
    : `${resolved.routesDir}/**/*.{ts,tsx,js,jsx,md,mdx}`;

  const shellGlob = isPagesMode
    ? `${resolved.pagesDir}/**/_app.{ts,tsx,js,jsx}`
    : `${resolved.shellsDir}/**/*.{ts,tsx,js,jsx,md,mdx}`;

  return [
    `export const routeModules = import.meta.glob(${JSON.stringify(routeGlob)});`,
    `export const shellModules = import.meta.glob(${JSON.stringify(shellGlob)});`,
    `export const middlewareModules = import.meta.glob(${JSON.stringify(`${resolved.middlewareDir}/**/*.{ts,tsx,js,jsx}`)});`,
    `export const apiModules = import.meta.glob(${JSON.stringify(`${resolved.apiDir}/**/*.{ts,js,tsx,jsx}`)});`,
    `export const dataModules = import.meta.glob(${JSON.stringify(`${resolved.serverDir}/**/*.{ts,js,tsx,jsx}`)});`,
    "",
    "export const registry = {",
    "  routeModules,",
    "  shellModules,",
    "  middlewareModules,",
    "  apiModules,",
    "  dataModules,",
    "};",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Pages mode: inline app source generation
// ---------------------------------------------------------------------------

function generatePagesAppInlineSource(
  options: ResolvedPrachtPluginOptions,
  root = process.cwd(),
): string {
  const absPagesDir = resolve(root, options.pagesDir.slice(1));
  const pages = scanPagesDirectory(absPagesDir);
  const source = generatePagesManifestSource(pages, {
    pagesDir: absPagesDir,
    pagesDefaultRender: options.pagesDefaultRender,
    pagesDirPrefix: options.pagesDir,
  });
  return source;
}

// ---------------------------------------------------------------------------
// Dev SSR middleware
// ---------------------------------------------------------------------------

function createDevSSRMiddleware(
  server: ViteDevServer,
  _pluginOptions: ResolvedPrachtPluginOptions,
): Connect.NextHandleFunction {
  return async (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const url = req.url ?? "/";
    const pathname = new URL(url, "http://localhost").pathname;

    // Let Vite handle assets by pathname. Query params may contain dotted
    // domains or tokens, but they should not opt the route out of SSR.
    if (pathname.includes(".") || pathname.startsWith("/node_modules/")) {
      return next();
    }

    try {
      // Load the framework and server module through Vite's SSR pipeline
      const [framework, serverMod] = await Promise.all([
        server.ssrLoadModule("@pracht/core"),
        server.ssrLoadModule(PRACHT_SERVER_MODULE_ID),
      ]);

      let webRequest: Request;
      try {
        webRequest = await nodeToWebRequest(req);
      } catch (err) {
        if (err instanceof Error && err.message === "Request body too large") {
          res.statusCode = 413;
          res.end("Payload Too Large");
          return;
        }
        throw err;
      }
      const response = await framework.handlePrachtRequest({
        app: serverMod.resolvedApp,
        registry: serverMod.registry,
        request: webRequest,
        debugErrors: true,
        clientEntryUrl: CLIENT_BROWSER_PATH,
        apiRoutes: serverMod.apiRoutes,
      });

      // If the framework returned 404, fall through to Vite's default handling
      if (response.status === 404) {
        return next();
      }

      const contentType = response.headers.get("content-type") ?? "text/html";
      let body = await response.text();

      // Only transform HTML responses (inject Vite HMR client etc.)
      if (contentType.includes("text/html")) {
        body = await server.transformIndexHtml(url, body);
      }

      res.statusCode = response.status;
      response.headers.forEach((value: string, key: string) => {
        res.setHeader(key, value);
      });
      res.end(body);
    } catch (error: unknown) {
      if (error instanceof Error) {
        server.ssrFixStacktrace(error);
      }

      // For route-state JSON requests, return a JSON error
      const isRouteState = req.headers["x-pracht-route-state-request"] === "1";
      if (isRouteState) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: {
              message: error instanceof Error ? error.message : String(error),
              name: error instanceof Error ? error.name : "Error",
              status: 500,
            },
          }),
        );
        return;
      }

      // Render the pracht error overlay for HTML requests
      try {
        const { buildErrorOverlayHtml } = await server.ssrLoadModule("pracht/error-overlay");
        let html = buildErrorOverlayHtml({
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        html = await server.transformIndexHtml(url, html);
        res.statusCode = 500;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(html);
      } catch {
        // If overlay itself fails, fall through to Vite's default handler
        next(error);
      }
    }
  };
}

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

async function nodeToWebRequest(req: IncomingMessage): Promise<Request> {
  // Dev server is always a direct connection — never trust forwarded headers.
  // Protocol is always plain HTTP (Vite's dev server does not use TLS), and
  // host comes from the standard Host header which is safe for direct clients.
  const protocol = "http";
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `${protocol}://${host}`);
  const method = req.method ?? "GET";

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const init: RequestInit = { method, headers };

  if (!BODYLESS_METHODS.has(method.toUpperCase())) {
    const MAX_BODY_SIZE = 1024 * 1024; // 1 MB
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    for await (const chunk of req) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalSize += buf.byteLength;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        throw new Error("Request body too large");
      }
      chunks.push(buf);
    }
    const body = Buffer.concat(chunks);
    if (body.byteLength > 0) {
      init.body = body;
    }
  }

  return new Request(url, init);
}

function resolveOptions(options: PrachtPluginOptions): ResolvedPrachtPluginOptions {
  return {
    ...DEFAULTS,
    ...options,
  };
}

function readClientBuildAssets(root = process.cwd()): {
  clientEntryUrl: string | null;
  cssManifest: Record<string, string[]>;
  jsManifest: Record<string, string[]>;
} {
  const manifestPath = ["dist/client/.vite/manifest.json", "dist/.vite/manifest.json"]
    .map((candidate) => resolve(root, candidate))
    .find((candidate) => existsSync(candidate));
  if (!manifestPath) {
    return { clientEntryUrl: null, cssManifest: {}, jsManifest: {} };
  }

  const rawManifest = readFileSync(manifestPath, "utf-8");
  const manifest = JSON.parse(rawManifest) as Record<string, ViteManifestEntry>;
  const clientEntry = manifest[PRACHT_CLIENT_MODULE_ID];

  // Walk static imports transitively (not dynamicImports — those belong to
  // other shells/routes loaded separately). Returns both CSS and JS deps.
  function collectTransitiveDeps(key: string): { css: string[]; js: string[] } {
    const css = new Set<string>();
    const js = new Set<string>();
    const visited = new Set<string>();

    function collect(k: string): void {
      if (visited.has(k)) return;
      visited.add(k);
      const entry = manifest[k];
      if (!entry) return;
      for (const c of entry.css ?? []) css.add(c);
      js.add(entry.file);
      for (const imp of entry.imports ?? []) collect(imp);
    }

    collect(key);
    return { css: [...css], js: [...js] };
  }

  const cssManifest: Record<string, string[]> = {};
  const jsManifest: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(manifest)) {
    if (!entry.src) continue;
    const deps = collectTransitiveDeps(key);
    const manifestKey = stripPrachtClientModuleQuery(entry.src);
    if (deps.css.length > 0) {
      cssManifest[manifestKey] = deps.css.map((f) => `/${f}`);
    }
    if (deps.js.length > 0) {
      jsManifest[manifestKey] = deps.js.map((f) => `/${f}`);
    }
  }

  return {
    clientEntryUrl: clientEntry ? `/${clientEntry.file}` : null,
    cssManifest,
    jsManifest,
  };
}

interface ViteManifestEntry {
  file: string;
  src?: string;
  css?: string[];
  imports?: string[];
  dynamicImports?: string[];
}
