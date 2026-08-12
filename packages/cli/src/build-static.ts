import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Static-export (`@pracht/adapter-static`) build pipeline: fail-closed
 * validation of everything a serverless static host cannot run, plus the
 * extra artifacts a static deploy needs (route-state JSON files, `404.html`,
 * the optional SPA fallback document).
 *
 * The shapes below are structural views of the built `dist/server/server.js`
 * module — the CLI reads the bundle the app's own build produced, exactly
 * like the Vercel/Cloudflare branches in `build.ts` do.
 */

interface StaticRouteView {
  hasLoader?: boolean;
  hydration?: string;
  middlewareFiles?: string[];
  path: string;
  render?: string;
}

interface StaticServerModuleView {
  staticTarget?: boolean;
  resolvedApp?: {
    routes?: StaticRouteView[];
    notFound?: StaticRouteView;
    capabilities?: Record<string, string>;
  };
  apiRoutes?: Array<{ path: string }>;
  registry?: {
    capabilityModules?: Record<string, () => Promise<unknown>>;
  };
  staticExportConfig?: { fallback?: string | null };
  renderStaticNotFoundHtml?: () => Promise<string | null>;
  renderStaticFallbackHtml?: (notFoundData?: unknown) => string | Promise<string>;
}

export function isStaticExportBuild(serverMod: { staticTarget?: unknown }): boolean {
  return serverMod.staticTarget === true;
}

interface CapabilityModuleView {
  default?: {
    expose?: { http?: unknown; mcp?: boolean; webmcp?: boolean } | null;
  };
}

const SERVERFUL_ADAPTER_HINT =
  "use @pracht/adapter-node, @pracht/adapter-cloudflare, or @pracht/adapter-vercel instead, " +
  'or change the route to render: "ssg" (or loaderless "spa" for client-only pages).';

function normalizeModulePath(path: string): string {
  return path.replace(/^\.?\//, "");
}

function resolveCapabilityImporter(
  modules: Record<string, () => Promise<unknown>>,
  file: string,
): (() => Promise<unknown>) | undefined {
  if (file in modules) return modules[file];

  const normalizedFile = normalizeModulePath(file);
  for (const [registeredFile, importer] of Object.entries(modules)) {
    const normalizedRegisteredFile = normalizeModulePath(registeredFile);
    if (
      normalizedRegisteredFile === normalizedFile ||
      normalizedRegisteredFile.endsWith(`/${normalizedFile}`)
    ) {
      return importer;
    }
  }

  return undefined;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Throw a single aggregated error when the app needs a server at runtime.
 * Called before prerendering so a doomed static build fails fast, with every
 * problem listed at once.
 */
export async function validateStaticExport(serverMod: StaticServerModuleView): Promise<void> {
  const problems: string[] = [];

  const routes = serverMod.resolvedApp?.routes ?? [];
  const notFound = serverMod.resolvedApp?.notFound;
  const pageRoutes = notFound ? [...routes, notFound] : routes;
  const serverRendered = routes.filter((route) => route.render !== "ssg" && route.render !== "spa");
  if (serverRendered.length > 0) {
    const listed = serverRendered
      .map((route) => `    - ${route.path} (render: "${route.render ?? "ssr"}")`)
      .join("\n");
    problems.push(
      `these routes render on a server at request time, but a static export has no server:\n${listed}\n` +
        `  For SSR/ISG ${SERVERFUL_ADAPTER_HINT}`,
    );
  }

  const spaWithLoaders = routes.filter(
    (route) => route.render === "spa" && route.hasLoader !== false,
  );
  if (spaWithLoaders.length > 0) {
    problems.push(
      `these SPA routes declare (or may declare) server loaders, but a static host cannot run them at request time:\n` +
        spaWithLoaders.map((route) => `    - ${route.path}`).join("\n") +
        "\n  Static SPA routes must be loaderless. Fetch live data from the browser, change the route to SSG for build-time data, or use a serverful adapter.",
    );
  }

  const routesWithMiddleware = pageRoutes.filter(
    (route) => (route.middlewareFiles?.length ?? 0) > 0,
  );
  if (routesWithMiddleware.length > 0) {
    problems.push(
      `these routes use request middleware, but a static host has no request runtime to enforce it:\n` +
        routesWithMiddleware
          .map(
            (route) =>
              `    - ${route.path} (${route.middlewareFiles?.length ?? 0} middleware module(s))`,
          )
          .join("\n") +
        "\n  Remove the route middleware or use a serverful adapter. Build-time-only transformations belong in loaders or build tooling.",
    );
  }

  if (notFound && notFound.hydration !== undefined && notFound.hydration !== "full") {
    problems.push(
      `the notFound page uses hydration: "${notFound.hydration}", but a static host serves one prebuilt 404.html for every unknown URL:\n` +
        "    - notFound\n" +
        '  Static notFound pages must use full hydration so the client router can adopt the visitor\'s real URL. Remove the hydration option (or set it to "full"), or use a serverful adapter.',
    );
  }

  // Reserved output namespace: the build writes framework metadata and the
  // serialized route-state tree under dist/client/_pracht/.
  const reservedRoutes = routes.filter(
    (route) => route.path === "/_pracht" || route.path.startsWith("/_pracht/"),
  );
  if (reservedRoutes.length > 0) {
    problems.push(
      `these routes collide with the reserved /_pracht/ output namespace (route-state files, build metadata):\n` +
        reservedRoutes.map((route) => `    - ${route.path}`).join("\n"),
    );
  }

  const apiRoutes = serverMod.apiRoutes ?? [];
  if (apiRoutes.length > 0) {
    problems.push(
      `API routes need a server to answer requests, but a static export has none:\n` +
        apiRoutes.map((route) => `    - ${route.path}`).join("\n") +
        `\n  Remove them or ${SERVERFUL_ADAPTER_HINT}`,
    );
  }

  const capabilityModules = serverMod.registry?.capabilityModules ?? {};
  const registeredCapabilities = serverMod.resolvedApp?.capabilities ?? {};
  const exposedCapabilities: string[] = [];
  const invalidCapabilities: string[] = [];
  for (const [name, file] of Object.entries(registeredCapabilities)) {
    const importer = resolveCapabilityImporter(capabilityModules, file);
    if (!importer) {
      invalidCapabilities.push(`    - ${name} (${file}): registered module was not found`);
      continue;
    }

    let capabilityModule: CapabilityModuleView | undefined;
    try {
      capabilityModule = (await importer()) as CapabilityModuleView;
    } catch (error) {
      invalidCapabilities.push(`    - ${name} (${file}): ${formatUnknownError(error)}`);
      continue;
    }
    if (!capabilityModule?.default || typeof capabilityModule.default !== "object") {
      invalidCapabilities.push(`    - ${name} (${file}): module has no default capability export`);
      continue;
    }
    const expose = capabilityModule?.default?.expose;
    if (expose && (expose.http || expose.mcp || expose.webmcp)) {
      const surfaces = [
        expose.http ? "http" : null,
        expose.mcp ? "mcp" : null,
        expose.webmcp ? "webmcp" : null,
      ]
        .filter(Boolean)
        .join(", ");
      exposedCapabilities.push(`    - ${name} (${file}; expose: ${surfaces})`);
    }
  }
  if (invalidCapabilities.length > 0) {
    problems.push(
      `these registered capabilities could not be loaded, so their network exposure cannot be validated safely:\n` +
        invalidCapabilities.join("\n"),
    );
  }
  if (exposedCapabilities.length > 0) {
    problems.push(
      `these capabilities are exposed over the network (HTTP/MCP/WebMCP), which needs a server:\n` +
        exposedCapabilities.join("\n") +
        `\n  Drop their \`expose\` config (server-side invokeCapability from build-time loaders still works), or ${SERVERFUL_ADAPTER_HINT}`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Static export (@pracht/adapter-static) cannot build this app:\n\n` +
        problems.map((problem) => `  • ${problem}`).join("\n\n") +
        `\n`,
    );
  }
}

/**
 * Resolve the output path of a route's serialized route-state JSON:
 * `/` → `_pracht/state/index.json`, `/blog/hello` →
 * `_pracht/state/blog/hello/index.json`. Mirrors the client's
 * `buildStaticRouteStateUrl()` and applies the same traversal guards as
 * `resolvePrerenderOutputPath`.
 */
export function resolveRouteStateOutputPath(clientDir: string, routePath: string): string {
  if (routePath.includes("\0") || routePath.includes("\\")) {
    throw new Error(`Refusing to write route state for unsafe path ${JSON.stringify(routePath)}.`);
  }

  const stateRoot = resolve(clientDir, "_pracht/state");
  const trimmed = routePath.replace(/\/+$/, "");
  const filePath =
    trimmed === ""
      ? resolve(stateRoot, "index.json")
      : resolve(stateRoot, `.${trimmed}`, "index.json");
  const relativePath = relative(stateRoot, filePath);

  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `Refusing to write route state for "${routePath}" outside dist/client/_pracht/state (${filePath}).`,
    );
  }

  return filePath;
}

export interface StaticArtifactsResult {
  stateFileCount: number;
  wrote404: boolean;
  fallbackFile: string | null;
}

function readStaticNotFoundData(html: string): unknown {
  const match = /<script id="pracht-state" type="application\/json">([\s\S]*?)<\/script>/.exec(
    html,
  );
  if (!match) {
    throw new Error(
      "Static export expected the full-hydration notFound page to contain serialized route state.",
    );
  }

  const state = JSON.parse(match[1]) as { data?: unknown };
  return state.data;
}

/**
 * Write the static-deploy artifacts next to the prerendered pages:
 * per-route state JSON, `404.html` from the app's notFound page, and the
 * optional SPA fallback document.
 */
export async function writeStaticExportArtifacts(options: {
  clientDir: string;
  pages: Array<{ path: string; routeState?: string }>;
  serverMod: StaticServerModuleView;
  log: (message: string) => void;
}): Promise<StaticArtifactsResult> {
  const { clientDir, pages, serverMod, log } = options;

  let stateFileCount = 0;
  for (const page of pages) {
    if (typeof page.routeState !== "string") continue;
    const filePath = resolveRouteStateOutputPath(clientDir, page.path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, page.routeState, "utf-8");
    stateFileCount += 1;
  }
  if (stateFileCount > 0) {
    log(`\n  Route state → dist/client/_pracht/state (${stateFileCount} file(s))\n`);
  }

  const configuredFallback = serverMod.staticExportConfig?.fallback ?? null;
  let wrote404 = false;
  let notFoundData: unknown;
  if (typeof serverMod.renderStaticNotFoundHtml === "function") {
    const notFoundHtml = await serverMod.renderStaticNotFoundHtml();
    if (notFoundHtml !== null) {
      if (configuredFallback) {
        notFoundData = readStaticNotFoundData(notFoundHtml);
      }
      writeFileSync(resolve(clientDir, "404.html"), notFoundHtml, "utf-8");
      wrote404 = true;
      log("  404.html → dist/client/404.html\n");
    } else {
      log(
        "  No 404.html emitted: the app declares no notFound page. " +
          "Static hosts will serve their own error page for unknown URLs.\n",
      );
    }
  }

  let fallbackFile: string | null = null;
  if (configuredFallback && typeof serverMod.renderStaticFallbackHtml === "function") {
    writeFileSync(
      resolve(clientDir, configuredFallback),
      await serverMod.renderStaticFallbackHtml(notFoundData),
      "utf-8",
    );
    fallbackFile = configuredFallback;
    log(
      `  SPA fallback → dist/client/${configuredFallback} ` +
        "(configure your host to rewrite unmatched URLs to it)\n",
    );
  }

  return { stateFileCount, wrote404, fallbackFile };
}
