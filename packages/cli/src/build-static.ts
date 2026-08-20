import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
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
  renderStaticNotFoundHtml?: () => Promise<unknown>;
  renderStaticFallbackHtml?: (notFoundState?: StaticNotFoundState) => unknown | Promise<unknown>;
}

interface StaticNotFoundState {
  data?: unknown;
  error?: unknown;
}

export function isStaticExportBuild(serverMod: { staticTarget?: unknown }): boolean {
  return serverMod.staticTarget === true;
}

interface CapabilityModuleView {
  default?: {
    expose?: { http?: unknown; mcp?: boolean; webmcp?: boolean } | null;
  };
}

const SERVERFUL_ADAPTERS =
  "use @pracht/adapter-node, @pracht/adapter-cloudflare, or @pracht/adapter-vercel instead";

/** For problems about API routes and capabilities, where render modes do not apply. */
const SERVERFUL_ADAPTER_HINT = `${SERVERFUL_ADAPTERS}.`;

/** For problems about routes, which have the additional per-route escape hatch. */
const SERVERFUL_ROUTE_HINT =
  `${SERVERFUL_ADAPTERS}, ` +
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

function portableOutputName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * Find an existing output whose path is equivalent on portable,
 * case-insensitive filesystems. Walk one component at a time so a file that
 * occupies a generated directory prefix is reported as a conflict too.
 */
function findPortableOutputConflict(root: string, filePath: string): string | null {
  const relativePath = relative(root, filePath);
  const targetParts = relativePath.split(sep);
  const existingParts: string[] = [];
  let currentDir = root;

  for (let index = 0; index < targetParts.length; index += 1) {
    let entries: Dirent[];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return existingParts.length > 0 ? existingParts.join("/") : null;
    }

    const targetName = portableOutputName(targetParts[index]);
    const existing = entries.find((entry) => portableOutputName(entry.name) === targetName);
    if (!existing) return null;

    existingParts.push(existing.name);
    if (index === targetParts.length - 1 || !existing.isDirectory()) {
      return existingParts.join("/");
    }
    currentDir = resolve(currentDir, existing.name);
  }

  return null;
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
        `  For SSR/ISG ${SERVERFUL_ROUTE_HINT}`,
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

  const spaWithNonFullHydration = routes.filter(
    (route) =>
      route.render === "spa" && route.hydration !== undefined && route.hydration !== "full",
  );
  if (spaWithNonFullHydration.length > 0) {
    problems.push(
      `these SPA routes use non-full hydration, but SPA components render entirely in the browser:\n` +
        spaWithNonFullHydration
          .map((route) => `    - ${route.path} (hydration: "${route.hydration}")`)
          .join("\n") +
        '\n  Static SPA routes must use full hydration. Remove the hydration option (or set it to "full"), change the route to SSG, or use a serverful adapter.',
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

  if (
    serverMod.staticTarget === true &&
    notFound &&
    typeof serverMod.renderStaticNotFoundHtml !== "function"
  ) {
    problems.push(
      "the generated server entry cannot render 404.html because it does not export " +
        "renderStaticNotFoundHtml(). Reuse staticAdapter() or createStaticServerEntryModule() " +
        "when building a custom static target.",
    );
  }
  if (
    serverMod.staticTarget === true &&
    serverMod.staticExportConfig?.fallback &&
    typeof serverMod.renderStaticFallbackHtml !== "function"
  ) {
    problems.push(
      `the generated server entry cannot render ${serverMod.staticExportConfig.fallback} because it does not export ` +
        "renderStaticFallbackHtml(). Reuse staticAdapter() or createStaticServerEntryModule() " +
        "when building a custom static target.",
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

/**
 * Percent-decode a route path into the filesystem path a static host looks up.
 *
 * A browser asked for `/posts/café` sends `/posts/caf%C3%A9`, and essentially
 * every static host (nginx, Apache, S3, GitHub Pages, Netlify, Caddy) decodes
 * the request before the filesystem lookup. Writing the encoded form would
 * therefore produce a directory literally named `caf%C3%A9` that no ordinary
 * link can reach — a page that builds green and 404s in production.
 *
 * Decoding happens per segment and is re-validated, because a decoded `%2F`
 * would smuggle in a path separator and a decoded `%5Fpracht` would slip past
 * the reserved-namespace check. Malformed escapes fail the build rather than
 * silently falling back to the unreachable literal form.
 */
export function decodeStaticOutputPath(routePath: string): string {
  if (!routePath.includes("%")) return routePath;

  return routePath
    .split("/")
    .map((segment) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        throw new Error(
          `Static export cannot write prerendered page ${JSON.stringify(routePath)} because segment ` +
            `${JSON.stringify(segment)} is not valid percent-encoding. ` +
            "Fix the route path or getStaticPaths() param.",
        );
      }
      if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
        throw new Error(
          `Static export cannot write prerendered page ${JSON.stringify(routePath)} because segment ` +
            `${JSON.stringify(segment)} decodes to a path separator. ` +
            "Fix the route path or getStaticPaths() param.",
        );
      }
      if (decoded === "." || decoded === "..") {
        throw new Error(
          `Static export cannot write prerendered page ${JSON.stringify(routePath)} because segment ` +
            `${JSON.stringify(segment)} decodes to a relative path segment. ` +
            "Fix the route path or getStaticPaths() param.",
        );
      }
      return decoded;
    })
    .join("/");
}

/**
 * Best-effort decode used by the guards that must catch both the encoded and
 * decoded spelling of a reserved name. It never throws: `decodeStaticOutputPath`
 * owns rejecting malformed escapes, and these guards only widen their match.
 */
function decodeOutputSegmentLenient(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Static-export variant of `resolvePrerenderOutputPath`.
 *
 * Only static exports decode: a static host resolves the request itself, so
 * the file has to sit at the decoded path. The serverful adapters keep the
 * encoded form because their own static lookup (`resolveStaticFile`) matches
 * against the raw `url.pathname` — decoding here would 404 their SSG pages.
 */
export function resolveStaticExportOutputPath(clientDir: string, routePath: string): string {
  return resolvePrerenderOutputPath(clientDir, decodeStaticOutputPath(routePath));
}

export function resolvePrerenderOutputPath(clientDir: string, routePath: string): string {
  if (routePath.includes("\0")) {
    throw new Error(`Refusing to write prerendered route "${routePath}" with a NUL byte.`);
  }

  const root = resolve(clientDir);
  const filePath =
    routePath === "/" ? resolve(root, "index.html") : resolve(root, `.${routePath}`, "index.html");
  const relativePath = relative(root, filePath);

  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `Refusing to write prerendered route "${routePath}" outside dist/client (${filePath}).`,
    );
  }

  return filePath;
}

export interface StaticArtifactsResult {
  stateFileCount: number;
  wrote404: boolean;
  fallbackFile: string | null;
}

function readStaticNotFoundState(html: string): StaticNotFoundState {
  const match = /<script id="pracht-state" type="application\/json">([\s\S]*?)<\/script>/.exec(
    html,
  );
  if (!match) {
    throw new Error(
      "Static export expected the full-hydration notFound page to contain serialized route state.",
    );
  }

  const state = JSON.parse(match[1]) as StaticNotFoundState;
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Static export expected the notFound route state to be a JSON object.");
  }
  return { data: state.data, error: state.error };
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
  const firstSegment = path.split("/").filter(Boolean)[0];
  if (firstSegment === undefined) return false;
  // Pages are written to the decoded path, so `/%5Fpracht/…` lands in the
  // reserved namespace just as `/_pracht/…` does. Check both spellings.
  return (
    firstSegment.toLowerCase() === "_pracht" ||
    decodeOutputSegmentLenient(firstSegment).toLowerCase() === "_pracht"
  );
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
    const rawSegment = page.path.split("/").filter(Boolean)[0];
    if (!rawSegment) continue;
    // Pages are written to the decoded path, so `/404%2Ehtml` occupies the
    // same file as `/404.html` — compare both spellings.
    const firstSegment = rawSegment.toLowerCase();
    const decodedSegment = decodeOutputSegmentLenient(rawSegment).toLowerCase();
    for (const fixedFile of fixedFiles) {
      if (firstSegment === fixedFile.toLowerCase() || decodedSegment === fixedFile.toLowerCase()) {
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

function assertNoPrerenderedPageOutputCollisions(pages: Array<{ path: string }>): void {
  const virtualClientDir = resolve(sep, "__pracht_static_output__");
  const outputs = pages.map((page) => {
    const outputPath = resolveStaticExportOutputPath(virtualClientDir, page.path);
    const relativeOutputPath = relative(virtualClientDir, outputPath);
    return {
      pagePath: page.path,
      relativeOutputPath,
      normalizedParts: relativeOutputPath
        .split(sep)
        .map((part) => normalizePortableOutputPart(part, page.path)),
    };
  });
  const collisions: string[] = [];

  outputs.sort((left, right) => {
    const sharedLength = Math.min(left.normalizedParts.length, right.normalizedParts.length);
    for (let index = 0; index < sharedLength; index += 1) {
      if (left.normalizedParts[index] < right.normalizedParts[index]) return -1;
      if (left.normalizedParts[index] > right.normalizedParts[index]) return 1;
    }
    return left.normalizedParts.length - right.normalizedParts.length;
  });

  for (let index = 1; index < outputs.length; index += 1) {
    const shorter = outputs[index - 1];
    const longer = outputs[index];
    const sameOutput =
      shorter.normalizedParts.length === longer.normalizedParts.length &&
      shorter.normalizedParts.every(
        (part, partIndex) => part === longer.normalizedParts[partIndex],
      );
    if (sameOutput) {
      collisions.push(
        `    - ${shorter.pagePath} and ${longer.pagePath} map to the same case-insensitive output path ` +
          `dist/client/${shorter.normalizedParts.join("/")}`,
      );
      continue;
    }

    const fileDirectoryConflict = shorter.normalizedParts.every(
      (part, partIndex) => part === longer.normalizedParts[partIndex],
    );
    if (fileDirectoryConflict) {
      collisions.push(
        `    - ${shorter.pagePath} and ${longer.pagePath} require ` +
          `dist/client/${shorter.relativeOutputPath.split(sep).join("/")} to be both a file and a directory`,
      );
    }
  }

  if (collisions.length > 0) {
    throw new Error(
      "Static export cannot write prerendered pages because their output paths collide:\n" +
        collisions.join("\n") +
        "\nChange the route paths or getStaticPaths() output so every page has a distinct, portable filesystem path.",
    );
  }
}

const WINDOWS_RESERVED_OUTPUT_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_INVALID_OUTPUT_CHARACTERS = '<>:"\\|?*';
const PORTABLE_OUTPUT_COMPONENT_MAX_LENGTH = 255;

function normalizePortableOutputPart(part: string, pagePath: string): string {
  const normalized = part.normalize("NFC");
  if (
    normalized.length > PORTABLE_OUTPUT_COMPONENT_MAX_LENGTH ||
    Buffer.byteLength(normalized, "utf-8") > PORTABLE_OUTPUT_COMPONENT_MAX_LENGTH
  ) {
    throw new Error(
      `Static export cannot write prerendered page ${JSON.stringify(pagePath)} because output component ` +
        `${JSON.stringify(part)} exceeds the portable 255-byte/code-unit filename limit. ` +
        "Use shorter route segments or getStaticPaths() params.",
    );
  }
  const hasInvalidWindowsCharacter = [...normalized].some(
    (character) =>
      WINDOWS_INVALID_OUTPUT_CHARACTERS.includes(character) || character.charCodeAt(0) < 32,
  );
  if (
    hasInvalidWindowsCharacter ||
    /[ .]$/.test(normalized) ||
    WINDOWS_RESERVED_OUTPUT_NAME_RE.test(normalized)
  ) {
    throw new Error(
      `Static export cannot write prerendered page ${JSON.stringify(pagePath)} because output component ` +
        `${JSON.stringify(part)} is not a portable Windows filename. ` +
        "Avoid reserved device names, trailing dots/spaces, and Windows-invalid filename characters.",
    );
  }

  return normalized.toLowerCase();
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

  assertNoPrerenderedPageOutputCollisions(pages);

  const configuredFallback = serverMod.staticExportConfig?.fallback ?? null;
  const fixedFiles = [
    ...(serverMod.resolvedApp?.notFound ? ["404.html"] : []),
    ...(configuredFallback ? [configuredFallback] : []),
  ];
  assertNoFixedArtifactRouteCollisions(pages, fixedFiles);
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
  if (serverMod.resolvedApp?.notFound && typeof serverMod.renderStaticNotFoundHtml !== "function") {
    throw new Error(
      "Static export cannot emit 404.html because the static adapter's generated server entry " +
        "does not export renderStaticNotFoundHtml(). Reuse staticAdapter() or " +
        "createStaticServerEntryModule() when building a custom static target.",
    );
  }
  if (configuredFallback && typeof serverMod.renderStaticFallbackHtml !== "function") {
    throw new Error(
      `Static export cannot emit ${configuredFallback} because the static adapter's generated server entry ` +
        "does not export renderStaticFallbackHtml(). Reuse staticAdapter() or " +
        "createStaticServerEntryModule() when building a custom static target.",
    );
  }

  let notFoundHtml: string | null | undefined;
  let notFoundState: StaticNotFoundState | undefined;
  if (typeof serverMod.renderStaticNotFoundHtml === "function") {
    const renderedNotFoundHtml = await serverMod.renderStaticNotFoundHtml();
    if (renderedNotFoundHtml === null && serverMod.resolvedApp?.notFound) {
      throw new Error(
        "Static export renderStaticNotFoundHtml() must return an HTML string when the app declares a notFound page, received null.",
      );
    }
    if (renderedNotFoundHtml !== null && typeof renderedNotFoundHtml !== "string") {
      throw new Error(
        "Static export renderStaticNotFoundHtml() must return an HTML string or null, " +
          `received ${typeof renderedNotFoundHtml}.`,
      );
    }
    notFoundHtml = renderedNotFoundHtml;
    if (typeof notFoundHtml === "string" && configuredFallback) {
      notFoundState = readStaticNotFoundState(notFoundHtml);
    }
  }

  let fallbackHtml: string | undefined;
  if (configuredFallback && typeof serverMod.renderStaticFallbackHtml === "function") {
    const renderedFallbackHtml = await serverMod.renderStaticFallbackHtml(notFoundState);
    if (typeof renderedFallbackHtml !== "string") {
      throw new Error(
        `Static export renderStaticFallbackHtml() must return an HTML string for ${configuredFallback}, ` +
          `received ${typeof renderedFallbackHtml}.`,
      );
    }
    fallbackHtml = renderedFallbackHtml;
  }

  const fixedOutputs = [
    ...(typeof notFoundHtml === "string" ? ["404.html"] : []),
    ...(configuredFallback && typeof fallbackHtml === "string" ? [configuredFallback] : []),
  ];
  const existingClientEntries = new Map(
    readdirSync(clientDir).map((entry) => [portableOutputName(entry), entry]),
  );
  const existingFixedOutputs = fixedOutputs.flatMap((fileName) => {
    const existingFileName = existingClientEntries.get(portableOutputName(fileName));
    return existingFileName ? [{ existingFileName, fileName }] : [];
  });
  if (existingFixedOutputs.length > 0) {
    throw new Error(
      "Static export fixed artifact output conflicts with existing files copied from public/ or emitted by Vite:\n" +
        existingFixedOutputs
          .map(
            ({ existingFileName, fileName }) =>
              `    - generated ${fileName} conflicts with existing ${existingFileName}`,
          )
          .join("\n") +
        "\nRemove or rename the conflicting files before building the static export.",
    );
  }

  const stateOutputs = pages.flatMap((page) =>
    typeof page.routeState === "string"
      ? [
          {
            filePath: resolveRouteStateOutputPath(clientDir, page.path),
            routePath: page.path,
            routeState: page.routeState,
          },
        ]
      : [],
  );
  const existingStateOutputs = stateOutputs.flatMap(({ filePath, routePath }) => {
    const existingPath = findPortableOutputConflict(clientDir, filePath);
    return existingPath ? [{ existingPath, routePath }] : [];
  });
  if (existingStateOutputs.length > 0) {
    throw new Error(
      "Static export route-state output conflicts with existing files copied from public/ or emitted by Vite:\n" +
        existingStateOutputs
          .map(
            ({ existingPath, routePath }) => `    - ${routePath} would overwrite ${existingPath}`,
          )
          .join("\n") +
        "\nRemove the conflicting files from the reserved public/_pracht/state/ namespace.",
    );
  }

  let stateFileCount = 0;
  for (const { filePath, routeState } of stateOutputs) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, routeState, "utf-8");
    stateFileCount += 1;
  }
  if (stateFileCount > 0) {
    log(`\n  Route state → dist/client/_pracht/state (${stateFileCount} file(s))\n`);
  }

  const wrote404 = typeof notFoundHtml === "string";
  if (typeof notFoundHtml === "string") {
    writeFileSync(resolve(clientDir, "404.html"), notFoundHtml, "utf-8");
    log("  404.html → dist/client/404.html\n");
  } else if (notFoundHtml === null) {
    log(
      "  No 404.html emitted: the app declares no notFound page. " +
        "Static hosts will serve their own error page for unknown URLs.\n",
    );
  }

  let fallbackFile: string | null = null;
  if (configuredFallback && typeof fallbackHtml === "string") {
    writeFileSync(resolve(clientDir, configuredFallback), fallbackHtml, "utf-8");
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
