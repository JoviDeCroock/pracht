import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import preact from "@preact/preset-vite";
import type { Connect, Plugin, ViteDevServer } from "vite";

import { createCloudflareServerEntryModule } from "@viact/adapter-cloudflare";
import { createNodeServerEntryModule } from "@viact/adapter-node";
import { createVercelServerEntryModule } from "@viact/adapter-vercel";

export const VIACT_CLIENT_MODULE_ID = "virtual:viact/client";
export const VIACT_SERVER_MODULE_ID = "virtual:viact/server";

// Browser-safe path alias — the colon in "virtual:" is parsed as a protocol
// scheme by browsers, so we serve the client module from a plain path.
const CLIENT_BROWSER_PATH = "/@viact/client.js";

// Vite 8's SSR build prepends the project root to entry IDs before calling
// resolveId, so we may receive "/abs/path/virtual:viact/server" instead of
// just "virtual:viact/server".  These helpers match both forms.
function isClientModule(id: string): boolean {
  return (
    id === VIACT_CLIENT_MODULE_ID ||
    id === CLIENT_BROWSER_PATH ||
    id.endsWith(VIACT_CLIENT_MODULE_ID)
  );
}

function isServerModule(id: string): boolean {
  return id === VIACT_SERVER_MODULE_ID || id.endsWith(VIACT_SERVER_MODULE_ID);
}

export interface ViactPluginOptions {
  appFile?: string;
  routesDir?: string;
  shellsDir?: string;
  middlewareDir?: string;
  apiDir?: string;
  serverDir?: string;
  adapter?: ViactAdapter;
  cloudflareAssetsBinding?: string;
  vercelFunctionName?: string;
  vercelRegions?: string | string[];
}

export type ViactAdapter = "node" | "cloudflare" | "vercel";

type ResolvedViactPluginOptions = Omit<Required<ViactPluginOptions>, "vercelRegions"> & {
  vercelRegions: string | string[] | undefined;
};

const DEFAULTS: ResolvedViactPluginOptions = {
  appFile: "/src/routes.ts",
  middlewareDir: "/src/middleware",
  routesDir: "/src/routes",
  shellsDir: "/src/shells",
  apiDir: "/src/api",
  serverDir: "/src/server",
  adapter: "node",
  cloudflareAssetsBinding: "ASSETS",
  vercelFunctionName: "render",
  vercelRegions: undefined as string | string[] | undefined,
};

export function viact(options: ViactPluginOptions = {}): Plugin[] {
  const resolved = resolveOptions(options);
  let root = process.cwd();

  const viactPlugin: Plugin = {
    name: "viact",
    enforce: "pre",

    config() {
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
      };
    },

    configResolved(config) {
      root = config.root;
    },

    resolveId(id) {
      if (isClientModule(id)) return VIACT_CLIENT_MODULE_ID;
      if (isServerModule(id)) return VIACT_SERVER_MODULE_ID;
      return null;
    },

    load(id) {
      if (isClientModule(id)) {
        return createViactClientModuleSource(resolved);
      }
      if (isServerModule(id)) {
        return createViactServerModuleSource(resolved, { root });
      }
      return null;
    },

    configureServer(server) {
      return () => {
        server.middlewares.use(createDevSSRMiddleware(server, resolved));
      };
    },

    handleHotUpdate({ file, server }) {
      const root = server.config.root;
      const relative = file.startsWith(root) ? file.slice(root.length) : file;

      // App manifest changed — restart server (route definitions may have changed)
      if (relative === resolved.appFile) {
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
        const serverMod = server.moduleGraph.getModuleById(VIACT_SERVER_MODULE_ID);
        if (serverMod) server.moduleGraph.invalidateModule(serverMod);
        // Don't return [] — let Vite's default HMR handle the component update
      }
    },
  };

  return [...preact(), viactPlugin];
}

// ---------------------------------------------------------------------------
// Virtual module source generators
// ---------------------------------------------------------------------------

export function createViactClientModuleSource(options: ViactPluginOptions = {}): string {
  const resolved = resolveOptions(options);

  return [
    'import { resolveApp, initClientRouter, readHydrationState } from "viact";',
    `import { app } from ${JSON.stringify(resolved.appFile)};`,
    "",
    `const routeModules = import.meta.glob(${JSON.stringify(`${resolved.routesDir}/**/*.{ts,tsx,js,jsx,md,mdx}`)});`,
    `const shellModules = import.meta.glob(${JSON.stringify(`${resolved.shellsDir}/**/*.{ts,tsx,js,jsx,md,mdx}`)});`,
    "",
    "const resolvedApp = resolveApp(app);",
    "",
    "function findModuleKey(modules, file) {",
    "  if (file in modules) return file;",
    '  const suffix = file.replace(/^\\.\\//,"");',
    "  for (const key of Object.keys(modules)) {",
    '    if (key.endsWith("/" + suffix) || key.endsWith(suffix)) return key;',
    "  }",
    "  return null;",
    "}",
    "",
    "const state = readHydrationState();",
    'const root = document.getElementById("viact-root");',
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

export function createViactServerModuleSource(
  options: ViactPluginOptions = {},
  buildOptions: {
    root?: string;
  } = {},
): string {
  const resolved = resolveOptions(options);
  const registrySource = createViactRegistryModuleSource(resolved);
  const clientBuild = readClientBuildAssets(buildOptions.root);
  const viactImport =
    resolved.adapter === "cloudflare" || resolved.adapter === "vercel"
      ? 'import { handleViactRequest, resolveApp, resolveApiRoutes } from "viact";'
      : 'import { resolveApp, resolveApiRoutes } from "viact";';

  const source = [
    viactImport,
    `import { app } from ${JSON.stringify(resolved.appFile)};`,
    "",
    registrySource,
    "",
    "export const resolvedApp = resolveApp(app);",
    `export const apiRoutes = resolveApiRoutes(Object.keys(apiModules), ${JSON.stringify(resolved.apiDir)});`,
    `export const buildTarget = ${JSON.stringify(resolved.adapter)};`,
    `export const clientEntryUrl = ${JSON.stringify(clientBuild.clientEntryUrl)};`,
    `export const cssManifest = ${JSON.stringify(clientBuild.cssManifest)};`,
    `export const jsManifest = ${JSON.stringify(clientBuild.jsManifest)};`,
    "",
  ];

  if (resolved.adapter === "cloudflare") {
    source.push(
      createCloudflareServerEntryModule({
        assetsBinding: resolved.cloudflareAssetsBinding,
      }),
    );
  }

  if (resolved.adapter === "node") {
    source.push(createNodeServerEntryModule());
  }

  if (resolved.adapter === "vercel") {
    source.push(
      createVercelServerEntryModule({
        functionName: resolved.vercelFunctionName,
        regions: resolved.vercelRegions,
      }),
    );
  }

  return source.join("\n");
}

export function createViactRegistryModuleSource(options: ViactPluginOptions = {}): string {
  const resolved = resolveOptions(options);

  return [
    `export const routeModules = import.meta.glob(${JSON.stringify(`${resolved.routesDir}/**/*.{ts,tsx,js,jsx,md}`)});`,
    `export const shellModules = import.meta.glob(${JSON.stringify(`${resolved.shellsDir}/**/*.{ts,tsx,js,jsx,md}`)});`,
    `export const middlewareModules = import.meta.glob(${JSON.stringify(`${resolved.middlewareDir}/**/*.{ts,tsx,js,jsx,md}`)});`,
    `export const apiModules = import.meta.glob(${JSON.stringify(`${resolved.apiDir}/**/*.{ts,js}`)});`,
    `export const dataModules = import.meta.glob(${JSON.stringify(`${resolved.serverDir}/**/*.{ts,js}`)});`,
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
// Dev SSR middleware
// ---------------------------------------------------------------------------

function createDevSSRMiddleware(
  server: ViteDevServer,
  _pluginOptions: ResolvedViactPluginOptions,
): Connect.NextHandleFunction {
  return async (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const url = req.url ?? "/";

    // Let Vite handle assets (have file extensions) and node_modules.
    // Page routes are clean URLs without dots.
    if (url.includes(".") || url.startsWith("/node_modules/")) {
      return next();
    }

    try {
      // Load the framework and server module through Vite's SSR pipeline
      const [framework, serverMod] = await Promise.all([
        server.ssrLoadModule("viact"),
        server.ssrLoadModule(VIACT_SERVER_MODULE_ID),
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
      const response = await framework.handleViactRequest({
        app: serverMod.resolvedApp,
        registry: serverMod.registry,
        request: webRequest,
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
      const isRouteState = req.headers["x-viact-route-state-request"] === "1";
      if (isRouteState) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : String(error),
            name: error instanceof Error ? error.name : "Error",
            status: 500,
          },
        }));
        return;
      }

      // Render the viact error overlay for HTML requests
      try {
        const { buildErrorOverlayHtml } = await server.ssrLoadModule("viact/error-overlay");
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
  const protocol =
    (Array.isArray(req.headers["x-forwarded-proto"])
      ? req.headers["x-forwarded-proto"][0]
      : req.headers["x-forwarded-proto"]) ?? "http";
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

function resolveOptions(options: ViactPluginOptions): ResolvedViactPluginOptions {
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
  const manifestPath = resolve(root, "dist/client/.vite/manifest.json");
  if (!existsSync(manifestPath)) {
    return { clientEntryUrl: null, cssManifest: {}, jsManifest: {} };
  }

  const rawManifest = readFileSync(manifestPath, "utf-8");
  const manifest = JSON.parse(rawManifest) as Record<string, ViteManifestEntry>;
  const clientEntry = manifest[VIACT_CLIENT_MODULE_ID];

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
    if (deps.css.length > 0) {
      cssManifest[key] = deps.css.map((f) => `/${f}`);
    }
    if (deps.js.length > 0) {
      jsManifest[key] = deps.js.map((f) => `/${f}`);
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
