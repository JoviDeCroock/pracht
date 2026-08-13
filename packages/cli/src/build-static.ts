import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { buildStaticRouteStateUrl } from "@pracht/core/server";

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
  file?: string;
  hasLoader?: boolean;
  hydration?: string;
  middlewareFiles?: string[];
  path: string;
  render?: string;
  shellFile?: string;
}

interface StaticServerModuleView {
  staticTarget?: boolean;
  buildBase?: string;
  resolvedApp?: {
    routes?: StaticRouteView[];
    notFound?: StaticRouteView;
    capabilities?: Record<string, string>;
  };
  apiRoutes?: Array<{ path: string }>;
  registry?: {
    capabilityModules?: Record<string, () => Promise<unknown>>;
    routeModules?: Record<string, () => Promise<unknown>>;
    shellModules?: Record<string, () => Promise<unknown>>;
  };
  staticExportConfig?: { fallback?: string | null; fallbackHead?: unknown };
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

function resolveRegistryImporter(
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

  // Sub-path deploys (GitHub Pages project sites, an S3 key prefix) would
  // build cleanly and then serve a dead site: prerendered documents reference
  // `/assets/…` and `/_pracht/state/…` from the origin root, so every script
  // and state file 404s under the base. Fail here instead.
  const buildBase = serverMod.buildBase ?? "/";
  if (buildBase !== "/") {
    problems.push(
      `Vite \`base\` is set to ${JSON.stringify(buildBase)}, but static exports emit root-relative asset and route-state URLs:\n` +
        `    - every prerendered page would request /assets/… and /_pracht/state/… from the origin root\n` +
        '  Base paths are not wired through yet. Deploy at an origin root (base: "/"), or use a serverful adapter.',
    );
  }
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
  const reservedRoutes = routes.filter((route) => isReservedStaticOutputPath(route.path));
  if (reservedRoutes.length > 0) {
    problems.push(
      `these routes collide with the reserved /_pracht/ output namespace (route-state files, build metadata):\n` +
        reservedRoutes.map((route) => `    - ${route.path}`).join("\n"),
    );
  }

  if (serverMod.staticExportConfig?.fallback && !serverMod.staticExportConfig.fallbackHead) {
    const dynamicSpaRoutes = routes.filter(
      (route) => hasDynamicSegments(route.path) && isClientRoutableSpaRoute(route),
    );
    const fallbackRenderedRoutes = notFound ? [...dynamicSpaRoutes, notFound] : dynamicSpaRoutes;
    const headRoutes: string[] = [];
    const uninspectableRoutes: string[] = [];
    for (const route of fallbackRenderedRoutes) {
      const moduleTargets = [
        route.file
          ? { file: route.file, modules: serverMod.registry?.routeModules, source: "route" }
          : null,
        route.shellFile
          ? { file: route.shellFile, modules: serverMod.registry?.shellModules, source: "shell" }
          : null,
      ].filter(Boolean) as Array<{
        file: string;
        modules: Record<string, () => Promise<unknown>> | undefined;
        source: string;
      }>;

      for (const target of moduleTargets) {
        const importer = target.modules
          ? resolveRegistryImporter(target.modules, target.file)
          : undefined;
        if (!importer) {
          uninspectableRoutes.push(`    - ${route.path} (${target.source}: ${target.file})`);
          continue;
        }
        try {
          const module = (await importer()) as { head?: unknown };
          if (typeof module.head === "function") {
            headRoutes.push(`    - ${route.path} (${target.source}: ${target.file})`);
          }
        } catch (error) {
          uninspectableRoutes.push(
            `    - ${route.path} (${target.source}: ${target.file}): ${formatUnknownError(error)}`,
          );
        }
      }
    }

    if (uninspectableRoutes.length > 0) {
      problems.push(
        `the SPA fallback metadata could not be validated because these fallback-rendered route modules could not be inspected safely:\n` +
          uninspectableRoutes.join("\n") +
          "\n  Set an explicit shared `fallbackHead`, fix the module registry, or use a serverful adapter.",
      );
    }
    if (headRoutes.length > 0) {
      problems.push(
        `these fallback-rendered routes declare route or shell head metadata, but one static fallback document cannot run URL-specific \`head()\` functions:\n` +
          headRoutes.join("\n") +
          "\n  Set `staticAdapter({ fallback, fallbackHead })` to explicit metadata shared by every rewritten URL, remove the head export, or use a serverful adapter.",
      );
    }
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
    const importer = resolveRegistryImporter(capabilityModules, file);
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
 * Mirrors the client's opaque `buildStaticRouteStateUrl()` scheme and applies
 * the same traversal guards as `resolvePrerenderOutputPath`.
 */
export function resolveRouteStateOutputPath(clientDir: string, routePath: string): string {
  if (routePath.includes("\0") || routePath.includes("\\")) {
    throw new Error(`Refusing to write route state for unsafe path ${JSON.stringify(routePath)}.`);
  }

  const stateRoot = resolve(clientDir, "_pracht/state");
  const stateUrl = buildStaticRouteStateUrl(routePath);
  const filePath = resolve(clientDir, `.${stateUrl}`);
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
 * A root splat (`/*`, `/:rest*`) matches every URL, so a fallback document
 * always resolves to that route — there is no unmatched URL left to render
 * blank. A single dynamic segment (`/:slug`) only covers one path depth.
 */
function matchesEveryPath(routePath: string): boolean {
  return routePath === "/*" || /^\/:[^/]+\*$/.test(routePath);
}

function hasDynamicSegments(routePath: string): boolean {
  return routePath.split("/").some((segment) => segment === "*" || segment.startsWith(":"));
}

function isClientRoutableSpaRoute(route: StaticRouteView): boolean {
  return route.render === "spa" && route.hydration !== "islands" && route.hydration !== "none";
}

function isReservedStaticOutputPath(path: string): boolean {
  return path.split("/").filter(Boolean)[0]?.toLowerCase() === "_pracht";
}

/**
 * A SPA catch-all only covers every fallback URL when no earlier dynamic
 * route can win matching while being impossible to render client-side. Exact
 * SSG routes are safe because their prerendered files prevent the host rewrite
 * from reaching the fallback document in the first place.
 */
function hasUnshadowedClientRoutableSpaCatchAll(routes: StaticRouteView[]): boolean {
  const catchAllIndex = routes.findIndex(
    (route) => isClientRoutableSpaRoute(route) && matchesEveryPath(route.path),
  );
  if (catchAllIndex === -1) return false;

  return routes
    .slice(0, catchAllIndex)
    .every((route) => !hasDynamicSegments(route.path) || isClientRoutableSpaRoute(route));
}

function assertNoFixedArtifactRouteCollisions(
  pages: Array<{ path: string }>,
  fixedFiles: string[],
): void {
  const collisions: string[] = [];
  for (const page of pages) {
    const firstSegment = page.path.split("/").filter(Boolean)[0]?.toLowerCase();
    if (!firstSegment) continue;
    for (const fixedFile of fixedFiles) {
      if (firstSegment === fixedFile.toLowerCase()) {
        collisions.push(`    - ${page.path} conflicts with dist/client/${fixedFile}`);
      }
    }
  }

  if (collisions.length > 0) {
    throw new Error(
      "Static export cannot write its fixed fallback artifacts because prerendered route directories use the same paths:\n" +
        collisions.join("\n") +
        "\nRename the route or choose a different staticAdapter({ fallback }) file.",
    );
  }
}

/**
 * Validate every concrete path returned by prerendering before the CLI writes
 * any page. Dynamic getStaticPaths() values are not visible in the route
 * manifest, so they must be checked at this boundary as well.
 */
export function validateStaticExportOutputPaths(
  pages: Array<{ path: string }>,
  serverMod: StaticServerModuleView,
): void {
  const reservedPaths = pages.filter((page) => isReservedStaticOutputPath(page.path));
  if (reservedPaths.length > 0) {
    throw new Error(
      "Static export cannot write prerendered pages under the reserved /_pracht/ output namespace:\n" +
        reservedPaths.map((page) => `    - ${page.path}`).join("\n") +
        "\nChange getStaticPaths() so it does not emit framework-owned paths.",
    );
  }

  const configuredFallback = serverMod.staticExportConfig?.fallback ?? null;
  const fixedFiles = [
    ...(serverMod.resolvedApp?.notFound ? ["404.html"] : []),
    ...(configuredFallback ? [configuredFallback] : []),
  ];
  assertNoFixedArtifactRouteCollisions(pages, fixedFiles);
}

/**
 * Prerender output keeps the percent-encoded form of dynamic params
 * (`/posts/café` → a directory literally named `caf%C3%A9`). Hosts that
 * decode the URL before the filesystem lookup — most of them — never find
 * those files, and the failure only shows up after deploying.
 */
function findPercentEncodedPaths(pages: Array<{ path: string }>): string[] {
  return pages.map((page) => page.path).filter((path) => /%[0-9A-Fa-f]{2}/.test(path));
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
  const configuredFallback = serverMod.staticExportConfig?.fallback ?? null;
  validateStaticExportOutputPaths(pages, serverMod);

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

  const percentEncodedPaths = findPercentEncodedPaths(pages);
  if (percentEncodedPaths.length > 0) {
    log(
      "\n  Warning: these prerendered paths contain percent-encoded characters, so their\n" +
        "  output directories are named literally (for example caf%C3%A9):\n" +
        percentEncodedPaths.map((path) => `    - ${path}`).join("\n") +
        "\n  Hosts that decode URLs before the filesystem lookup (most do) will answer 404\n" +
        "  for them. Prefer ASCII-safe getStaticPaths() params on static exports.\n",
    );
  }

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

    // The fallback document renders whatever the client router resolves from
    // `window.location`. With no notFound page and no unshadowed,
    // client-routable SPA catch-all, that resolves to nothing: the visitor
    // gets a blank page, and the host's rewrite means it answers 200 instead
    // of 404.
    const hasCatchAllRoute = hasUnshadowedClientRoutableSpaCatchAll(
      serverMod.resolvedApp?.routes ?? [],
    );
    if (!wrote404 && !hasCatchAllRoute) {
      log(
        `\n  Warning: ${configuredFallback} is emitted but the app declares no notFound page,\n` +
          "  and no unshadowed client-routable SPA catch-all matches every URL. Behind the host rewrite, unknown URLs render an\n" +
          "  empty document with status 200. Add defineApp({ notFound }) so they render a real\n" +
          "  page, or drop the `fallback` option so unknown URLs keep the host's 404.\n",
      );
    }
  }

  return { stateFileCount, wrote404, fallbackFile };
}
