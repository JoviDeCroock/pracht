import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { PRACHT_CLIENT_MODULE_QUERY } from "./client-module-query.ts";
import { generatePagesManifestSource, scanPagesDirectory } from "./pages-router.ts";
import {
  CLIENT_BROWSER_PATH,
  ISLANDS_CLIENT_BROWSER_PATH,
  SERVER_ISLANDS_CLIENT_BROWSER_PATH,
  readClientBuildAssets,
} from "./plugin-assets.ts";
import { ROUTE_CSS_CONTENT_TOKEN, ROUTE_CSS_MANIFEST_TOKEN } from "./plugin-server-css.ts";
import {
  resolveOptions,
  type PrachtPluginOptions,
  type ResolvedPrachtPluginOptions,
} from "./plugin-options.ts";
import { createRouteHints, createRouteLoaderHints, type RouteHints } from "./route-loader-hints.ts";
import { fileModuleId, getAnalysisSession, isWithinRoot, moduleIdPath } from "./analysis.ts";
import { findAppRootModule } from "./plugin-app-root.ts";
import { createWebmcpBootstrapSource, hasWebmcpCapabilities } from "./plugin-capabilities.ts";
import {
  DEFAULT_SHELL_EXTENSIONS,
  DEFAULT_ROUTE_EXTENSIONS,
  LEGACY_BARE_ROUTE_EXTENSIONS,
  extensionGlob,
  withAdditionalExtensions,
} from "./route-extensions.ts";
import {
  isNonModuleDirectoryName,
  isNonModuleFile,
  moduleGlob,
  nonModuleExcludes,
} from "./source-files.ts";

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function scanFiles(dir: string, files: string[], extensions: Set<string>): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const abs = join(dir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (!isNonModuleDirectoryName(entry)) scanFiles(abs, files, extensions);
    } else if (extensions.has(extname(entry)) && !isNonModuleFile(entry)) {
      files.push(abs);
    }
  }
}

/**
 * Route modules left out of the client registry: a module whose every ref
 * belongs to a route that provably does not hydrate fully. One module can
 * back a full route and an islands route, and the full route needs it in the
 * browser; a ref whose hydration is unknown, a ref from another position, or
 * a path the manifest merely mentions keeps it in. An incomplete read could
 * be hiding a full route's ref, so it excludes nothing.
 */
function createNonFullHydrationExcludes(
  resolved: ResolvedPrachtPluginOptions,
  root: string = process.cwd(),
): string[] {
  const facts = getAnalysisSession(resolved, root).manifest();
  if (!facts.complete) return [];
  const all = new Map<string, number>();
  const nonFull = new Map<string, number>();
  for (const ref of facts.refs) {
    if (ref.id === null) continue;
    all.set(ref.id, (all.get(ref.id) ?? 0) + 1);
    if (
      (ref.kind === "route" || ref.kind === "not-found") &&
      (ref.hydration === "islands" || ref.hydration === "none")
    ) {
      nonFull.set(ref.id, (nonFull.get(ref.id) ?? 0) + 1);
    }
  }
  return [...nonFull].filter(([id, count]) => (all.get(id) ?? 0) <= count).map(([id]) => `!${id}`);
}

/**
 * The manifest and the local modules it imports, as absolute POSIX paths. An
 * edit to any of them can change what the registries hold, so the dev server
 * treats each like the manifest itself.
 */
export function collectManifestModuleFiles(
  resolved: ResolvedPrachtPluginOptions,
  root: string = process.cwd(),
): string[] {
  if (resolved.pagesDir) return [];
  return [...getAnalysisSession(resolved, root).manifest().files];
}

/**
 * Whether any route may stream its document (`streaming: true`), which is the
 * only way a page's hydration state carries `defer()` values out of band.
 * Answers `true` whenever it cannot tell.
 */
export function appMayStream(resolved: ResolvedPrachtPluginOptions, root: string): boolean {
  return getAnalysisSession(resolved, root).manifest().mayStream;
}

/**
 * The route and shell modules the app manifest names, and whether that answer
 * can be trusted.
 *
 * Refs are plain strings — `"./routes/home.tsx"`, or the specifier of a
 * `() => import("./routes/home.tsx")` — so every string in the manifest, and
 * in the local modules it imports, that resolves to a file under the routes or
 * shells directory is a ref. Reading them this loosely is deliberate: a string
 * that turns out to be something else (a middleware path, a route pattern)
 * resolves to no file there and drops out, and over-collecting only ever keeps
 * a module the app already ships.
 *
 * `complete` is false as soon as a ref could live somewhere the scan cannot
 * see (see `ManifestFacts.complete`). Callers must then leave the registry as it
 * was — dropping a module a route needs breaks navigation to it, which is far
 * worse than shipping one nothing reaches.
 */
export function collectManifestModuleRefs(
  resolved: ResolvedPrachtPluginOptions,
  root: string = process.cwd(),
): { complete: boolean; files: Set<string> } {
  const files = new Set<string>();
  if (resolved.pagesDir) return { complete: false, files };

  const facts = getAnalysisSession(resolved, root).manifest();
  const ownedDirectories = [resolved.routesDir, resolved.shellsDir].map(
    (directory) => `${fileModuleId(root, resolve(root, directory.replace(/^\//, "")))}/`,
  );
  for (const ref of facts.refs) {
    if (ref.id === null || !ownedDirectories.some((directory) => ref.id!.startsWith(directory)))
      continue;
    const file = toPosixPath(moduleIdPath(root, ref.id));
    try {
      if (statSync(file).isFile()) files.add(file);
    } catch {
      // A ref to a file that is not there fails `pracht build`; it cannot be
      // excluded from anything either way.
    }
  }

  return { complete: facts.complete, files };
}

/**
 * Root-absolute paths (`/src/features/a.tsx`) of the modules the manifest
 * names outside the directories the registries glob, by registry.
 *
 * The registries are directory globs, so a route written as
 * `"./features/a.tsx"` used to have no registry entry and failed on every
 * request. Only refs in a ref position count, and only files that exist: a
 * server-only module never reaches the client registry this way.
 */
export interface ExternalManifestModules {
  routes: string[];
  shells: string[];
  middleware: string[];
  loaders: string[];
}

/**
 * Registry entries for named files, keyed like `import.meta.glob` keys them.
 * Explicit imports rather than a glob, so a file name holding glob syntax
 * (`[id].tsx`) is taken literally.
 */
function externalRegistryEntries(
  files: readonly string[],
  specifierOf: (file: string) => string,
): string[] {
  return files.map(
    (file) => `  ${JSON.stringify(file)}: () => import(${JSON.stringify(specifierOf(file))}),`,
  );
}

export function collectExternalManifestModules(
  resolved: ResolvedPrachtPluginOptions,
  root: string = process.cwd(),
): ExternalManifestModules {
  const external: ExternalManifestModules = { routes: [], shells: [], middleware: [], loaders: [] };
  if (resolved.pagesDir) return external;

  const facts = getAnalysisSession(resolved, root).manifest();
  const directoryOf = (directory: string): string =>
    `${fileModuleId(root, resolve(root, directory.replace(/^\//, "")))}/`;
  const registries = {
    routes: { kinds: ["route", "not-found"], globbed: directoryOf(resolved.routesDir) },
    shells: { kinds: ["shell"], globbed: directoryOf(resolved.shellsDir) },
    middleware: { kinds: ["middleware"], globbed: directoryOf(resolved.middlewareDir) },
    loaders: { kinds: ["loader"], globbed: directoryOf(resolved.serverDir) },
  } as const;

  for (const [registry, { kinds, globbed }] of Object.entries(registries) as Array<
    [keyof ExternalManifestModules, (typeof registries)[keyof typeof registries]]
  >) {
    const found = new Set<string>();
    for (const ref of facts.refs) {
      if (ref.id === null || !(kinds as readonly string[]).includes(ref.kind)) continue;
      if (ref.id.startsWith(globbed) || !isWithinRoot(ref.id)) continue;
      try {
        if (!statSync(moduleIdPath(root, ref.id)).isFile()) continue;
      } catch {
        continue;
      }
      found.add(ref.id);
    }
    external[registry] = [...found].sort();
  }

  return external;
}

/**
 * Files sitting in the routes or shells directory that the manifest never
 * names.
 *
 * In manifest mode the client registry is a glob over those directories, so a
 * draft, a scratch copy, or a route deleted from the manifest but left on disk
 * was compiled and published as a client chunk — with its source — for a page
 * no URL reaches. The manifest is the app's route list; the registry follows
 * it.
 *
 * The pages router legitimately owns its directory: there, a file *is* a route.
 */
function createUnreferencedModuleExcludes(
  resolved: ResolvedPrachtPluginOptions,
  root: string = process.cwd(),
  directories: readonly string[],
): string[] {
  const refs = collectManifestModuleRefs(resolved, root);
  if (!refs.complete) return [];

  const extensions = withAdditionalExtensions(
    DEFAULT_ROUTE_EXTENSIONS,
    resolved.additionalExtensions,
  );
  const excludes: string[] = [];
  const rootPrefix = `${toPosixPath(root).replace(/\/$/, "")}/`;

  for (const directory of directories) {
    const files: string[] = [];
    scanFiles(resolve(root, directory.replace(/^\//, "")), files, extensions);
    for (const file of files) {
      const posix = toPosixPath(file);
      if (refs.files.has(posix)) continue;
      excludes.push(`!/${posix.replace(rootPrefix, "")}`);
    }
  }

  return excludes;
}

export function createPrachtClientModuleSource(
  options: PrachtPluginOptions = {},
  buildOptions: { root?: string; routeHints?: VirtualModuleRouteHints } = {},
): string {
  const resolved = resolveOptions(options);
  const isPagesMode = !!resolved.pagesDir;
  // `load()` scans once to record what this entry bakes in; reusing that
  // scan keeps the two from disagreeing and skips a second directory walk.
  const routeHints =
    buildOptions.routeHints ?? createRouteHintsForVirtualModules(resolved, buildOptions.root);
  // An app whose shells export no loader ships no shell hints to the browser.
  // `getStaticPaths()` presence is only read by static-export builds.
  const clientRouteHints = createClientRouteHintTable(
    routeHints,
    resolved.adapter?.staticTarget === true,
  );
  const webmcpEnabled = hasWebmcpCapabilities(resolved, buildOptions.root);
  // Client-side search validation ships only when a route module can export a
  // `search` schema. Dev keeps it regardless, so adding the first schema does
  // not depend on the client entry being regenerated.
  const searchParserOption = routeHintsHaveSearch(routeHints)
    ? "    parseSearch: parseRouteSearch,"
    : "    ...(import.meta.env.DEV ? { parseSearch: parseRouteSearch } : null),";

  const appImport = isPagesMode
    ? generatePagesAppInlineSource(resolved, buildOptions.root, "client")
    : `import { app } from ${JSON.stringify(resolved.appFile)};`;

  // Additional formats are globbed separately without the `?pracht-client`
  // query suffix so their Vite transform plugins can match the bare extension.
  // Pracht's directory-aware post transform still strips server-only exports.
  const bareRouteExtensions = [
    ...withAdditionalExtensions(LEGACY_BARE_ROUTE_EXTENSIONS, resolved.additionalExtensions),
  ];
  const dirPrefix = isPagesMode ? resolved.pagesDir : resolved.routesDir;
  const routeGlob = `${dirPrefix}/**/*.{ts,tsx,js,jsx,md,mdx}`;
  const additionalRouteGlob = `${dirPrefix}/**/*.${extensionGlob(bareRouteExtensions)}`;
  const routeExcludes = [
    ...nonModuleExcludes(dirPrefix),
    ...createNonFullHydrationExcludes(resolved, buildOptions.root),
  ];
  const usesEjectedPagesLayout = isEjectedPagesLayout(resolved, buildOptions.root ?? process.cwd());
  if (isPagesMode || usesEjectedPagesLayout) {
    // Pages middleware is server-only. Keep it out of the client registry in
    // both auto-discovered pages mode and documented ejected layouts, including
    // layouts that move `_app` or `_middleware` to a separate directory.
    // Reserve every underscore-prefixed helper too: otherwise an
    // implementation imported by `_middleware.ts` would still be emitted as
    // an independent route/shell chunk through these broad registries.
    routeExcludes.push(
      ...createUnderscoreReservedExcludes(isPagesMode ? resolved.pagesDir : resolved.routesDir),
    );
  }
  // The manifest is the route list, so the registry carries what it names and
  // nothing else. An ejected pages layout keeps the directory-is-the-route
  // contract even though it reads a manifest, so it is left out.
  const unreferencedExcludes =
    isPagesMode || usesEjectedPagesLayout
      ? []
      : createUnreferencedModuleExcludes(resolved, buildOptions.root, [
          resolved.routesDir,
          resolved.shellsDir,
        ]);
  routeExcludes.push(...unreferencedExcludes);
  const routeGlobPattern = [routeGlob, ...routeExcludes];
  const additionalRouteGlobPattern = [additionalRouteGlob, ...routeExcludes];
  // Modules the manifest names outside the globbed directories get entries of
  // their own; hydration exclusions apply to them like to any route.
  const external = isPagesMode
    ? { routes: [], shells: [] }
    : collectExternalManifestModules(resolved, buildOptions.root);
  const externalGlobs = (files: string[], excludes: string[]): string[] =>
    externalRegistryEntries(
      files.filter((file) => !excludes.includes(`!${file}`)),
      (file) =>
        bareRouteExtensions.includes(extname(file)) ? file : `${file}${PRACHT_CLIENT_MODULE_QUERY}`,
    );

  // Directory-scoped shells: every `_app` in the pages tree is registered, so
  // the glob walks subdirectories. `_reserved/**` helper trees stay excluded —
  // an `_app` inside one is a helper, not a shell.
  const shellGlob = isPagesMode
    ? `${resolved.pagesDir}/**/_app.{ts,tsx,js,jsx}`
    : `${resolved.shellsDir}/**/*.{ts,tsx,js,jsx,md,mdx}`;
  const additionalShellGlob = isPagesMode
    ? `${resolved.pagesDir}/**/_app.${extensionGlob(bareRouteExtensions)}`
    : `${resolved.shellsDir}/**/*.${extensionGlob(bareRouteExtensions)}`;
  const root = buildOptions.root ?? process.cwd();
  const usesEjectedPagesShellLayout =
    usesEjectedPagesLayout &&
    (sameConfigDirectory(resolved.shellsDir, resolved.routesDir, root) ||
      hasRootPagesAppShell(resolved.shellsDir, root, resolved.additionalExtensions));
  // In pages mode the shell glob targets `_app` by name, so it may only
  // exclude reserved *trees* — the full underscore reservation would exclude
  // `_app` itself. The ejected layout's shell glob is the ordinary
  // shells-directory sweep, so it keeps the full reservation and re-adds every
  // `_app` through `ejectedPagesAppShellSources` below.
  const shellExcludes = [
    ...nonModuleExcludes(isPagesMode ? resolved.pagesDir : resolved.shellsDir),
    ...(isPagesMode
      ? createReservedSubtreeExcludes(resolved.pagesDir)
      : usesEjectedPagesShellLayout
        ? createUnderscoreReservedExcludes(resolved.shellsDir)
        : unreferencedExcludes),
  ];
  const shellGlobPattern = [shellGlob, ...shellExcludes];
  const additionalShellGlobPattern = [additionalShellGlob, ...shellExcludes];
  const ejectedPagesAppShellSources = usesEjectedPagesShellLayout
    ? [
        `  ...import.meta.glob(${JSON.stringify([`${resolved.shellsDir}/**/_app.{ts,tsx,js,jsx}`, ...createReservedSubtreeExcludes(resolved.shellsDir)])}, { query: ${JSON.stringify(PRACHT_CLIENT_MODULE_QUERY)} }),`,
        `  ...import.meta.glob(${JSON.stringify([`${resolved.shellsDir}/**/_app.${extensionGlob(bareRouteExtensions)}`, ...createReservedSubtreeExcludes(resolved.shellsDir)])}),`,
      ]
    : [];
  // Base directory for relative manifest refs: the app manifest file's
  // directory (refs like "./routes/home.tsx" are written relative to it).
  const appFilePosix = resolved.appFile.replace(/\\/g, "/").replace(/^\.\//, "");
  const appFileAbs = appFilePosix.startsWith("/") ? appFilePosix : `/${appFilePosix}`;
  const appDir = appFileAbs.replace(/\/[^/]*$/, "") || "/";

  // `defineApp({ root })`: imported eagerly, because the router renders it
  // before the first hydration. Without one, nothing is emitted and the
  // `__PRACHT_APP_ROOT__` define drops the router's root wiring.
  const appRoot = findAppRootModule(resolved, root);

  return [
    'import { resolveApp, initClientRouter, readHydrationState, parseRouteSearch, DEV_ROUTE_DATA_STALE_EVENT, refreshDevRouteData } from "@pracht/core/client";',
    appImport,
    ...(appRoot ? [`import * as rootModule from ${JSON.stringify(appRoot.id)};`] : []),
    "",
    `const APP_DIR = ${JSON.stringify(appDir)};`,
    `const routeHints = ${JSON.stringify(clientRouteHints)};`,
    `const routeModules = {`,
    `  ...import.meta.glob(${JSON.stringify(routeGlobPattern)}, { query: ${JSON.stringify(PRACHT_CLIENT_MODULE_QUERY)} }),`,
    `  ...import.meta.glob(${JSON.stringify(additionalRouteGlobPattern)}),`,
    ...externalGlobs(external.routes, routeExcludes),
    `};`,
    `const shellModules = {`,
    `  ...import.meta.glob(${JSON.stringify(shellGlobPattern)}, { query: ${JSON.stringify(PRACHT_CLIENT_MODULE_QUERY)} }),`,
    `  ...import.meta.glob(${JSON.stringify(additionalShellGlobPattern)}),`,
    ...externalGlobs(external.shells, []),
    ...ejectedPagesAppShellSources,
    `};`,
    "",
    "const resolvedApp = resolveApp(app);",
    "applyRouteHints(resolvedApp, routeHints);",
    "",
    ...createApplyClientRouteHintsSource(
      routeHints.shellLoaders,
      resolved.adapter?.staticTarget === true,
    ),
    "",
    "// Manifest refs are written relative to the app manifest file",
    '// ("./routes/home.tsx") while import.meta.glob keys are root-absolute',
    '// ("/src/routes/home.tsx"). Both sides canonicalize against APP_DIR —',
    "// known at build time — replacing the previous runtime suffix index.",
    "function canonicalModuleKey(path) {",
    '  const raw = path.split("?")[0];',
    '  const joined = raw.startsWith("/") ? raw : APP_DIR + "/" + raw;',
    "  const parts = [];",
    '  for (const segment of joined.split("/")) {',
    '    if (!segment || segment === ".") continue;',
    '    if (segment === "..") parts.pop();',
    "    else parts.push(segment);",
    "  }",
    '  return "/" + parts.join("/");',
    "}",
    "",
    "const moduleKeyIndexes = new WeakMap();",
    "function getModuleKeyIndex(modules) {",
    "  let index = moduleKeyIndexes.get(modules);",
    "  if (index) return index;",
    "  index = new Map();",
    "  for (const key of Object.keys(modules)) index.set(canonicalModuleKey(key), key);",
    "  moduleKeyIndexes.set(modules, index);",
    "  return index;",
    "}",
    "",
    "function findModuleKey(modules, file) {",
    "  if (file in modules) return file;",
    "  const key = getModuleKeyIndex(modules).get(canonicalModuleKey(file));",
    "  if (key != null) return key;",
    "  if (import.meta.env?.DEV) {",
    "    // Dev-only lenient fallback so refs that never canonicalize (written",
    "    // relative to a file other than the app manifest) keep working while",
    "    // the console error tells the author to fix them — production builds",
    "    // resolve strictly and drop this branch.",
    '    const suffix = "/" + file.split("?")[0].replace(/^\\.?\\//, "");',
    "    for (const candidate of Object.keys(modules)) {",
    "      if (canonicalModuleKey(candidate).endsWith(suffix)) {",
    "        console.error(",
    "          `[pracht] Module ref ${JSON.stringify(file)} only resolved by suffix matching ` +",
    "            `against ${JSON.stringify(candidate)}. Write manifest refs relative to the app ` +",
    '            `manifest file (e.g. "./routes/home.tsx") — suffix matching is disabled in ` +',
    "            `production builds.`,",
    "        );",
    "        return candidate;",
    "      }",
    "    }",
    "  }",
    "  return null;",
    "}",
    "",
    ...(webmcpEnabled ? createWebmcpBootstrapSource() : []),
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
    searchParserOption,
    ...(appRoot ? ["    rootModule,"] : []),
    ...(webmcpEnabled ? ["    onRouteChange: syncPrachtWebmcpTools,"] : []),
    "  });",
    "}",
    "",
    "// A route module's loader, head, and getStaticPaths are stripped",
    "// out of the browser copy, so Fast Refresh patching the component in place",
    "// leaves the page holding data the server would no longer send. The dev",
    "// server says when that happened; re-fetching route state is what the full",
    "// page reload used to deliver as a side effect. This entry is the only",
    "// module in the graph with an import.meta.hot of its own — an installed",
    "// @pracht/core is a pre-bundled dependency and has none. Production builds",
    "// replace import.meta.hot with undefined and drop the whole branch.",
    "if (import.meta.hot) {",
    "  import.meta.hot.on(DEV_ROUTE_DATA_STALE_EVENT, refreshDevRouteData);",
    "}",
    "",
  ].join("\n");
}

function sameConfigDirectory(left: string, right: string, root: string): boolean {
  const canonicalize = (value: string): string => {
    const absolute = resolve(root, value.replace(/^[/\\]+/, ""));
    try {
      return realpathSync.native(absolute);
    } catch {
      // Preserve correct `.` / `..` semantics before Vite has created or
      // resolved the configured directory. Existing symlinks take the branch
      // above so two aliases of the same directory still compare equal.
      return absolute;
    }
  };

  return canonicalize(left) === canonicalize(right);
}

function hasRootPagesAppShell(
  directory: string,
  root: string,
  additionalExtensions: readonly string[],
): boolean {
  const absoluteDirectory = resolve(root, directory.replace(/^[/\\]+/, ""));
  const extensions = withAdditionalExtensions(DEFAULT_SHELL_EXTENSIONS, additionalExtensions);

  for (const extension of extensions) {
    try {
      if (statSync(join(absoluteDirectory, `_app${extension}`)).isFile()) return true;
    } catch {
      // Missing candidates are expected while an ejected layout is being
      // migrated between its pages and conventional directories.
    }
  }

  return false;
}

export function isEjectedPagesLayout(resolved: ResolvedPrachtPluginOptions, root: string): boolean {
  if (resolved.pagesDir) return false;
  return getAnalysisSession(resolved, root).manifest().ejectedLayout;
}

function createUnderscoreReservedExcludes(directory: string): string[] {
  return [`!${directory}/**/_*`, ...createReservedSubtreeExcludes(directory)];
}

/**
 * Exclude the contents of underscore-reserved directory trees without
 * excluding underscore-prefixed files themselves. The shell registry needs
 * this narrower form: `_app.tsx` is a reserved *name* that must stay in the
 * registry, while `_components/_app.tsx` is a helper that must not.
 */
function createReservedSubtreeExcludes(directory: string): string[] {
  return [`!${directory}/**/_*/**`];
}

/**
 * Source of `virtual:pracht/islands-client` — the tiny bootstrap loaded by
 * `hydration: "islands"` routes. It deliberately does NOT import the app
 * manifest, the router, or the full client runtime: it only scans the DOM
 * for island markers and hydrates the islands present on the page.
 */
export function createPrachtIslandsClientModuleSource(
  options: PrachtPluginOptions = {},
  buildOptions: { root?: string } = {},
): string {
  const resolved = resolveOptions(options);
  const islandsGlob = moduleGlob(
    resolved.islandsDir,
    `${resolved.islandsDir}/**/*.{ts,tsx,js,jsx}`,
  );
  const webmcpEnabled = hasWebmcpCapabilities(resolved, buildOptions.root);

  // With client-side navigation the page changes under the bootstrap, so the
  // page tools follow each swapped-in document.
  const syncToolsOnNavigate = webmcpEnabled && resolved.client.islandsNavigation;

  return [
    'import { hydrateIslands } from "@pracht/core/islands-client";',
    "",
    `const islandModules = import.meta.glob(${JSON.stringify(islandsGlob)});`,
    "",
    syncToolsOnNavigate
      ? "hydrateIslands({ modules: islandModules, onNavigate: syncPrachtWebmcpToolsFrom });"
      : "hydrateIslands({ modules: islandModules });",
    "",
    // Islands pages skip the full client runtime, so the bootstrap pulls in
    // the WebMCP shim itself when a capability opts in.
    ...(webmcpEnabled
      ? [
          ...createWebmcpBootstrapSource(),
          ...(syncToolsOnNavigate
            ? [
                "function syncPrachtWebmcpToolsFrom(doc) {",
                '  const entry = doc.querySelector("script[data-pracht-webmcp-tools]");',
                '  syncPrachtWebmcpTools(entry?.getAttribute("data-pracht-webmcp-tools")?.split(",").filter(Boolean) ?? []);',
                "}",
                "syncPrachtWebmcpToolsFrom(document);",
              ]
            : [
                'const webmcpEntry = document.querySelector("script[data-pracht-webmcp-tools]");',
                'const webmcpCapabilities = webmcpEntry?.getAttribute("data-pracht-webmcp-tools")?.split(",").filter(Boolean) ?? [];',
                "syncPrachtWebmcpTools(webmcpCapabilities);",
              ]),
          "",
        ]
      : []),
  ].join("\n");
}

/**
 * Source of `virtual:pracht/server-islands-client` — the swap script islands and
 * `hydration: "none"` pages load when they rendered a pending request-time
 * server island. It imports nothing from the app: it fetches each pending server island's
 * HTML and swaps it in.
 */
export function createPrachtServerIslandsClientModuleSource(): string {
  return [
    'import { startServerIslands } from "@pracht/core/server-islands-client";',
    "",
    "startServerIslands();",
    "",
  ].join("\n");
}

const STYLE_IMPORT_RE =
  /^\s*import\s+(["'])([^"']+\.(?:css|scss|sass|less|styl|stylus|pcss|postcss|sss)(?:\?[^"']*)?)\1\s*;?\s*$/gm;

/**
 * What a server island module compiles to in the client bundle: a placeholder
 * component that fills itself from the server island endpoint. The server island's own
 * code — its loader and whatever that imports — never reaches the browser.
 * Bare stylesheet imports are kept so a server island's CSS still ships with the
 * page that renders it.
 */
export function createClientServerIslandModuleSource(
  code: string,
  serverIslandFile: string,
): string {
  const styleImports = [...code.matchAll(STYLE_IMPORT_RE)].map(
    (match) => `import ${JSON.stringify(match[2])};`,
  );
  return [
    ...styleImports,
    'import { createClientServerIsland } from "@pracht/core/server-islands-component";',
    "",
    `export default createClientServerIsland(${JSON.stringify(serverIslandFile)});`,
    "",
  ].join("\n");
}

export function createPrachtServerModuleSource(
  options: PrachtPluginOptions = {},
  buildOptions: {
    root?: string;
    isBuild?: boolean;
    base?: string;
    configuredBase?: string;
  } = {},
): string {
  const resolved = resolveOptions(options);
  const isPagesMode = !!resolved.pagesDir;
  const registrySource = createPrachtRegistryModuleSource(resolved, { root: buildOptions.root });
  const routeHints = createRouteHintsForVirtualModules(resolved, buildOptions.root);
  const routeLoaderHints = routeHints.loader;
  const routeHeadHints = routeHints.head;
  const routeStaticPathsHints = routeHints.staticPaths;
  const clientBuild = buildOptions.isBuild
    ? readClientBuildAssets(buildOptions.root, buildOptions.base ?? "/", resolved.inlineCss)
    : {
        clientEntryUrl: null,
        islandsEntryUrl: null,
        serverIslandsEntryUrl: null,
        cssManifest: {},
        cssContentManifest: {},
        jsManifest: {},
      };
  const adapter = resolved.adapter;
  const llmsTxtConfig = resolveLlmsTxtConfig(resolved, buildOptions.root);
  const islandsBootstrapRequired = hasWebmcpCapabilities(resolved, buildOptions.root);

  // The adapter tells us what extra imports it needs (e.g. handlePrachtRequest).
  // Always import prerenderApp so the CLI uses the same bundled copy of
  // @pracht/core/server (and therefore the same Preact context instances) as the
  // route/shell modules — avoids dual-copy issues during SSG prerendering.
  let prachtImports = adapter?.serverImports
    ? adapter.serverImports +
      '\nimport { prerenderApp, prerenderMarkdown } from "@pracht/core/server";'
    : 'import { resolveApp, resolveApiRoutes, prerenderApp, prerenderMarkdown } from "@pracht/core/server";';
  if (llmsTxtConfig) {
    prachtImports += '\nimport { buildLlmsTxt } from "@pracht/core/server";';
  }

  const appImport = isPagesMode
    ? generatePagesAppInlineSource(resolved, buildOptions.root)
    : `import { app } from ${JSON.stringify(resolved.appFile)};`;

  // In dev the islands bootstrap is served from a stable path; in production
  // builds the hashed entry URL comes from the client build manifest (null
  // when the app has no islands directory).
  const devBase = buildOptions.base ?? "/";
  const withDevBase = (path: string): string =>
    devBase === "/" ? path : `${devBase}${path.slice(1)}`;
  const clientEntryUrl = buildOptions.isBuild
    ? clientBuild.clientEntryUrl
    : withDevBase(CLIENT_BROWSER_PATH);
  const islandsEntryUrl = buildOptions.isBuild
    ? clientBuild.islandsEntryUrl
    : withDevBase(ISLANDS_CLIENT_BROWSER_PATH);
  const islandsGlob = moduleGlob(
    resolved.islandsDir,
    `${resolved.islandsDir}/**/*.{ts,tsx,js,jsx}`,
  );
  const serverIslandsEntryUrl = buildOptions.isBuild
    ? clientBuild.serverIslandsEntryUrl
    : withDevBase(SERVER_ISLANDS_CLIENT_BROWSER_PATH);
  const serverIslandsGlob = moduleGlob(
    resolved.serverIslandsDir,
    `${resolved.serverIslandsDir}/**/*.{ts,tsx,js,jsx}`,
  );
  // A build without a server islands directory never imports the server islands
  // runtime, so its server bundle carries none of it. Dev always registers, so
  // a directory created mid-session works without a restart.
  const registersServerIslands =
    !buildOptions.isBuild ||
    existsSync(
      resolve(buildOptions.root ?? process.cwd(), resolved.serverIslandsDir.replace(/^\//, "")),
    );

  const source = [
    prachtImports,
    'import { registerServerIslands, setIslandsClientEntryUrl } from "@pracht/core/server";',
    ...(registersServerIslands
      ? [
          'import { registerServerIslandModules, setServerIslandsClientEntryUrl } from "@pracht/core/server";',
        ]
      : []),
    appImport,
    "",
    `const routeLoaderHints = ${JSON.stringify(routeLoaderHints)};`,
    `const routeHeadHints = ${JSON.stringify(routeHeadHints)};`,
    `const routeStaticPathsHints = ${JSON.stringify(routeStaticPathsHints)};`,
    ...createApplyRouteLoaderHintsSource(),
    registrySource,
    "",
    "// Islands are registered eagerly so the server renderer can detect their",
    "// vnodes during islands-mode renders.",
    `const islandModules = import.meta.glob(${JSON.stringify(islandsGlob)}, { eager: true });`,
    "registerServerIslands(islandModules);",
    `setIslandsClientEntryUrl(${JSON.stringify(islandsEntryUrl ?? undefined)});`,
    "export const islandFiles = Object.keys(islandModules);",
    "",
    ...(registersServerIslands
      ? [
          "// Server islands: detected like islands, rendered per request.",
          `const serverIslandModules = import.meta.glob(${JSON.stringify(serverIslandsGlob)}, { eager: true });`,
          "registerServerIslandModules(serverIslandModules, { replace: true });",
          `setServerIslandsClientEntryUrl(${JSON.stringify(serverIslandsEntryUrl ?? undefined)});`,
          "",
        ]
      : []),
    "export const resolvedApp = resolveApp(app);",
    "applyRouteHints(resolvedApp, routeLoaderHints, routeHeadHints, routeStaticPathsHints);",
    `export const apiRoutes = resolveApiRoutes(Object.keys(apiModules), ${JSON.stringify(resolved.apiDir)});`,
    `export const buildTarget = ${JSON.stringify(adapter?.id ?? "node")};`,
    `export const staticTarget = ${JSON.stringify(adapter?.staticTarget === true)};`,
    // Vite's `base`. The CLI reads it to prefix the asset URLs it writes into
    // prerendered documents, to serve `pracht preview` under the same path,
    // and to reject the base shapes a static export cannot honour.
    `export const buildBase = ${JSON.stringify(buildOptions.base ?? "/")};`,
    // Preserve the user-authored value as well. Vite normalizes document-relative
    // bases to "/" in SSR builds, but the static-export validator still needs
    // to reject the original value because the client build resolves it relatively.
    `export const configuredBase = ${JSON.stringify(buildOptions.configuredBase)};`,
    // `pracht({ trailingSlash })`, read by the CLI for the build's routing
    // metadata and by adapters whose output routing is generated at build time.
    `export const buildTrailingSlash = ${JSON.stringify(resolved.trailingSlash)};`,
    `export const clientEntryUrl = ${JSON.stringify(clientEntryUrl ?? CLIENT_BROWSER_PATH)};`,
    `export const islandsEntryUrl = ${JSON.stringify(islandsEntryUrl ?? null)};`,
    `export const islandsBootstrapRequired = ${JSON.stringify(islandsBootstrapRequired)};`,
    // Routes that do not fully hydrate never reach the client bundle, so the
    // client manifest has nothing for them. Their stylesheets come from the
    // server build's own graph, spliced into these tokens once Rollup has named
    // the assets (see plugin-server-css.ts). The client build stays
    // authoritative: it is merged last and wins on any shared key. A build that
    // never replaces the tokens parses to an empty object and behaves as before.
    `const routeCssManifest = /* @__PURE__ */ parsePrachtRouteCss("${ROUTE_CSS_MANIFEST_TOKEN}");`,
    `const routeCssContentManifest = /* @__PURE__ */ parsePrachtRouteCss("${ROUTE_CSS_CONTENT_TOKEN}");`,
    "function parsePrachtRouteCss(raw) {",
    "  try {",
    "    return JSON.parse(raw);",
    "  } catch {",
    "    return {};",
    "  }",
    "}",
    `export const cssManifest = { ...routeCssManifest, ...${JSON.stringify(clientBuild.cssManifest)} };`,
    `export const cssContentManifest = { ...routeCssContentManifest, ...${JSON.stringify(clientBuild.cssContentManifest)} };`,
    `export const jsManifest = ${JSON.stringify(clientBuild.jsManifest)};`,
    `export const prerenderConcurrency = ${JSON.stringify(resolved.prerenderConcurrency)};`,
    `export const budgets = ${JSON.stringify(resolved.budgets)};`,
    "export { prerenderApp, prerenderMarkdown };",
    // Only the opt-out is recorded; the CLI treats a missing export as enabled.
    ...(resolved.markdownFiles ? [] : ["export const markdownFiles = false;"]),
    ...(llmsTxtConfig
      ? [
          "// llms.txt (https://llmstxt.org) generated from the resolved app graph.",
          "// `pracht build` writes it to dist/client/llms.txt; the dev SSR",
          "// middleware serves it at /llms.txt.",
          `const llmsTxtConfig = ${JSON.stringify(llmsTxtConfig)};`,
          "// `pracht build` and the dev server pass the pages that have a `.md` file.",
          "export const generateLlmsTxt = (overrides = {}) =>",
          "  buildLlmsTxt({ ...llmsTxtConfig, ...overrides, apiRoutes, app: resolvedApp, registry });",
        ]
      : []),
    "",
  ];

  if (adapter) {
    source.push(adapter.createServerEntryModule());
  }

  return source.join("\n");
}

/**
 * Adapter-neutral app metadata used by development tooling. Keeping this
 * separate from the server entry avoids evaluating worker-only imports (for
 * example `cloudflare:workers`) in Vite's Node SSR environment.
 */
export function createPrachtDevModuleSource(
  options: PrachtPluginOptions = {},
  buildOptions: { root?: string; base?: string } = {},
): string {
  const resolved = resolveOptions(options);
  const routeHints = createRouteHintsForVirtualModules(resolved, buildOptions.root);
  const routeLoaderHints = routeHints.loader;
  const routeHeadHints = routeHints.head;
  const routeStaticPathsHints = routeHints.staticPaths;
  const appImport = resolved.pagesDir
    ? generatePagesAppInlineSource(resolved, buildOptions.root)
    : `import { app } from ${JSON.stringify(resolved.appFile)};`;

  return [
    'import { resolveApp, resolveApiRoutes } from "@pracht/core/server";',
    appImport,
    "",
    `const routeLoaderHints = ${JSON.stringify(routeLoaderHints)};`,
    `const routeHeadHints = ${JSON.stringify(routeHeadHints)};`,
    `const routeStaticPathsHints = ${JSON.stringify(routeStaticPathsHints)};`,
    ...createApplyRouteLoaderHintsSource(),
    createPrachtRegistryModuleSource(resolved, { root: buildOptions.root }),
    "",
    "export const resolvedApp = resolveApp(app);",
    "applyRouteHints(resolvedApp, routeLoaderHints, routeHeadHints, routeStaticPathsHints);",
    `export const apiRoutes = resolveApiRoutes(Object.keys(apiModules), ${JSON.stringify(resolved.apiDir)});`,
    `export const buildTarget = ${JSON.stringify(resolved.adapter?.id ?? "node")};`,
    `export const staticTarget = ${JSON.stringify(resolved.adapter?.staticTarget === true)};`,
    `export const buildBase = ${JSON.stringify(buildOptions.base ?? "/")};`,
    `export const buildTrailingSlash = ${JSON.stringify(resolved.trailingSlash)};`,
    "",
  ].join("\n");
}

interface ResolvedLlmsTxtConfig {
  title: string;
  description?: string;
  origin?: string;
  include?: string[];
  exclude?: string[];
  maxPagesPerRoute?: number;
}

/**
 * Fill llms.txt title/description from the app's package.json when the user
 * did not set them explicitly. Returns null when the feature is disabled so
 * the server module codegen stays byte-for-byte unchanged.
 */
function resolveLlmsTxtConfig(
  resolved: ResolvedPrachtPluginOptions,
  root = process.cwd(),
): ResolvedLlmsTxtConfig | null {
  if (!resolved.llmsTxt) return null;

  let pkg: { name?: unknown; description?: unknown } = {};
  try {
    pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
  } catch {}

  const config: ResolvedLlmsTxtConfig = {
    title: resolved.llmsTxt.title ?? (typeof pkg.name === "string" && pkg.name ? pkg.name : "App"),
  };
  const description =
    resolved.llmsTxt.description ??
    (typeof pkg.description === "string" && pkg.description ? pkg.description : undefined);
  if (description) config.description = description;
  if (resolved.llmsTxt.origin) config.origin = resolved.llmsTxt.origin;
  if (resolved.llmsTxt.include) config.include = resolved.llmsTxt.include;
  if (resolved.llmsTxt.exclude?.length) config.exclude = resolved.llmsTxt.exclude;
  if (resolved.llmsTxt.maxPagesPerRoute !== undefined) {
    config.maxPagesPerRoute = resolved.llmsTxt.maxPagesPerRoute;
  }
  return config;
}

/** Bits of a client route hint: what the scanned module exports. */
const HINT_LOADER = 1;
const HINT_HEAD = 2;
const HINT_STATIC_PATHS = 4;

/**
 * The route hint table the browser entry carries: one root-absolute key per
 * scanned route or shell module (`/src/routes/home.tsx`, which the entry's
 * `canonicalModuleKey` turns any manifest ref into) and a bitfield of
 * `HINT_*` flags. A module the scan saw exports none of them as `0`, so
 * "known not to" stays distinct from "never scanned" (no key). The server
 * tables keep their two keys and booleans; only the browser pays per route.
 */
function createClientRouteHintTable(
  hints: VirtualModuleRouteHints,
  staticPaths: boolean,
): Record<string, number> {
  const table: Record<string, number> = {};
  const keys = new Set([...Object.keys(hints.loader), ...Object.keys(hints.head)]);
  for (const key of keys) {
    // Root-absolute keys are module ids, which is what the entry's
    // `canonicalModuleKey` turns every ref into before the lookup.
    if (!key.startsWith("/")) continue;
    table[key] =
      (table[key] ?? 0) |
      (hints.loader[key] === true ? HINT_LOADER : 0) |
      (hints.head[key] === true ? HINT_HEAD : 0) |
      (staticPaths && hints.staticPaths[key] === true ? HINT_STATIC_PATHS : 0);
  }
  return table;
}

/**
 * `applyRouteHints` for the browser entry, reading the bitfield table above.
 * The rules match the server copy: a hint only ever adds `true`, and narrows
 * to `false` only when the scan saw the module.
 */
function createApplyClientRouteHintsSource(shellLoaders: boolean, staticPaths: boolean): string[] {
  return [
    "function applyRouteHints(resolvedApp, hints) {",
    "  for (const route of resolvedApp.routes) {",
    "    const hint = hints[canonicalModuleKey(route.file)];",
    "    const shellHint = route.shellFile ? hints[canonicalModuleKey(route.shellFile)] : undefined;",
    "    if (hint !== undefined) {",
    `      if (hint & ${HINT_LOADER}) route.hasLoader = true;`,
    "      else if (route.hasLoader === undefined) route.hasLoader = false;",
    ...(staticPaths
      ? [
          "      if (route.hasStaticPaths === undefined) {",
          `        route.hasStaticPaths = (hint & ${HINT_STATIC_PATHS}) !== 0;`,
          "      }",
        ]
      : []),
    "    }",
    ...(shellLoaders
      ? [
          `    if (shellHint !== undefined) route.hasShellLoader = (shellHint & ${HINT_LOADER}) !== 0;`,
        ]
      : []),
    `    if ((hint & ${HINT_HEAD}) || (shellHint & ${HINT_HEAD})) {`,
    "      route.hasHead = true;",
    "    } else if (",
    "      route.hasHead === undefined &&",
    "      hint !== undefined &&",
    "      (!route.shellFile || shellHint !== undefined)",
    "    ) {",
    "      route.hasHead = false;",
    "    }",
    "  }",
    "}",
    "",
  ];
}

function createApplyRouteLoaderHintsSource(): string[] {
  return [
    "function applyRouteHints(resolvedApp, routeLoaderHints, routeHeadHints, routeStaticPathsHints) {",
    "  for (const route of resolvedApp.routes) {",
    "    const hint = routeLoaderHints[route.file];",
    "    if (hint === true) {",
    "      route.hasLoader = true;",
    "    } else if (typeof route.hasLoader === 'undefined' && typeof hint === 'boolean') {",
    "      route.hasLoader = hint;",
    "    }",
    "    const shellLoaderHint = route.shellFile ? routeLoaderHints[route.shellFile] : undefined;",
    "    if (typeof shellLoaderHint === 'boolean') route.hasShellLoader = shellLoaderHint;",
    "    const routeHeadHint = routeHeadHints[route.file];",
    "    const shellHeadHint = route.shellFile ? routeHeadHints[route.shellFile] : undefined;",
    "    const hasCompleteHeadHints = typeof routeHeadHint === 'boolean' &&",
    "      (!route.shellFile || typeof shellHeadHint === 'boolean');",
    "    if (routeHeadHint === true || shellHeadHint === true) {",
    "      route.hasHead = true;",
    "    } else if (typeof route.hasHead === 'undefined' && hasCompleteHeadHints) {",
    "      route.hasHead = routeHeadHint === true || shellHeadHint === true;",
    "    }",
    "    // Only ever narrows to false, and only when the scan actually saw the",
    "    // module: an unknown route file keeps today's conservative behavior.",
    "    const staticPathsHint = routeStaticPathsHints[route.file];",
    "    if (typeof route.hasStaticPaths === 'undefined' && typeof staticPathsHint === 'boolean') {",
    "      route.hasStaticPaths = staticPathsHint;",
    "    }",
    "  }",
    "}",
    "",
  ];
}

/**
 * Whether some route module may export a `search` schema. A scan that could
 * not finish answers yes, so a schema is never compiled out by mistake.
 */
export function routeHintsHaveSearch(hints: RouteHints): boolean {
  return hints.incomplete || Object.values(hints.search).some(Boolean);
}

/**
 * Every route hint table the generated client entry bakes in, resolved against
 * the plugin's configured directories and keyed the way the app manifest names
 * its modules.
 *
 * One call, one walk per directory, one parse per route file. The four tables
 * used to be built independently, which walked the routes directory four times
 * and re-parsed every route module four times — on each file of each save.
 */
export interface VirtualModuleRouteHints extends RouteHints {
  /**
   * The loader table without the shells' entries: what the browser needs when
   * no shell has a loader, so an app that uses none ships no shell hints.
   */
  routeLoader: Record<string, boolean>;
  /**
   * Whether any shell may export a `loader`. Fail-closed: an incomplete scan
   * answers `true`. Drives `__PRACHT_SHELL_LOADERS__`, which compiles the
   * client's shell-data handling out of apps that have none.
   */
  shellLoaders: boolean;
}

export function createRouteHintsForVirtualModules(
  options: ResolvedPrachtPluginOptions,
  root = process.cwd(),
): VirtualModuleRouteHints {
  const appFileAbs = resolve(root, options.appFile.slice(1));
  const appFileDir = dirname(appFileAbs);
  // `pagesDir` defaults to "" rather than undefined, so test truthiness.
  const routesPrefix = options.pagesDir || options.routesDir;
  // In pages mode `scanPagesDirectory()` returns route records only — its final
  // sort filters the `_app` shell out — so scan the directory itself, or a
  // header-bearing pages shell would stop forcing a document reload.
  const directories = options.pagesDir
    ? [[options.pagesDir, resolve(root, options.pagesDir.slice(1))] as const]
    : [
        [options.routesDir, resolve(root, options.routesDir.slice(1))] as const,
        [options.shellsDir, resolve(root, options.shellsDir.slice(1))] as const,
      ];

  const hints: VirtualModuleRouteHints = {
    capabilities: {},
    head: {},
    headers: {},
    incomplete: false,
    loader: {},
    routeLoader: {},
    search: {},
    shellLoaders: false,
    staticPaths: {},
  };

  const merge = (scanned: RouteHints, isRoute: boolean, isShell: boolean): void => {
    hints.incomplete ||= scanned.incomplete;
    Object.assign(hints.head, scanned.head);
    Object.assign(hints.headers, scanned.headers);
    // Shells can own a loader too; only routes own `getStaticPaths()` and a
    // search schema.
    Object.assign(hints.loader, scanned.loader);
    if (isRoute) {
      Object.assign(hints.routeLoader, scanned.loader);
      Object.assign(hints.search, scanned.search);
      Object.assign(hints.staticPaths, scanned.staticPaths);
    }
    if (isShell) hints.shellLoaders ||= Object.values(scanned.loader).includes(true);
  };

  for (const [prefix, directory] of directories) {
    const scanned = createRouteHints(directory, {
      additionalExtensions: options.additionalExtensions,
      appFileDir,
      root,
    });
    merge(
      scanned,
      prefix === routesPrefix,
      prefix !== routesPrefix || prefix === options.shellsDir,
    );
  }

  // Route and shell modules the manifest names outside those directories.
  if (!options.pagesDir) {
    const external = collectExternalManifestModules(options, root);
    for (const [files, isRoute] of [
      [external.routes, true],
      [external.shells, false],
    ] as const) {
      for (const file of files) {
        const scanned = createRouteHints(dirname(resolve(root, file.slice(1))), {
          additionalExtensions: options.additionalExtensions,
          appFileDir,
          files: [resolve(root, file.slice(1))],
          root,
        });
        merge(scanned, isRoute, !isRoute);
      }
    }
  }

  if (options.pagesDir) {
    // Pages routes are keyed by their manifest-relative path and carry the
    // loader flag the pages scanner already resolved. `_app` shells are not
    // routes, so they keep the flag the directory scan gave them.
    const shellLoaders = Object.entries(hints.loader).filter(([key]) =>
      /(?:^|\/)_app\.[^/]+$/.test(key),
    );
    hints.shellLoaders = shellLoaders.some(([, hasLoader]) => hasLoader);
    hints.loader = Object.fromEntries(shellLoaders);
    hints.routeLoader = {};
    for (const page of scanPagesDirectory(
      resolve(root, options.pagesDir.slice(1)),
      options.additionalExtensions,
    )) {
      const key = fileModuleId(root, page.absolutePath);
      hints.loader[key] = hints.routeLoader[key] = !!page.hasLoader;
    }
  }

  hints.shellLoaders ||= hints.incomplete;
  return hints;
}

export function createRouteHeadersHintsForVirtualModules(
  options: ResolvedPrachtPluginOptions,
  root = process.cwd(),
): Record<string, boolean> {
  return createRouteHintsForVirtualModules(options, root).headers;
}

/**
 * Server data modules that can own a separately wired route loader.
 *
 * These hints stay on the dev-server side: unlike the per-route table above,
 * the generated browser entry has no use for data-module filenames. The HMR
 * importer walk does, though — a shared module can be client-reachable through
 * a component and server-reachable through `route(..., { loader })`, so it
 * cannot rely on the server-only full-reload fallback.
 */
export function createServerLoaderHintsForHotUpdates(
  options: ResolvedPrachtPluginOptions,
  root = process.cwd(),
): Record<string, true> {
  const hints = createRouteLoaderHints(resolve(root, options.serverDir.slice(1)), {
    root,
  });
  return Object.fromEntries(
    Object.entries(hints).filter((entry): entry is [string, true] => entry[1] === true),
  );
}

export function createPrachtRegistryModuleSource(
  options: PrachtPluginOptions = {},
  buildOptions: { root?: string } = {},
): string {
  const resolved = resolveOptions(options);
  const appRoot = findAppRootModule(resolved, buildOptions.root);
  const apiGlobs = moduleGlob(resolved.apiDir, `${resolved.apiDir}/**/*.{ts,js,tsx,jsx}`);
  const isPagesMode = !!resolved.pagesDir;
  const bareRouteExtensions = [
    ...withAdditionalExtensions(LEGACY_BARE_ROUTE_EXTENSIONS, resolved.additionalExtensions),
  ];

  const routeDir = isPagesMode ? resolved.pagesDir : resolved.routesDir;
  const routeGlob = moduleGlob(routeDir, `${routeDir}/**/*.{ts,tsx,js,jsx,md,mdx}`);
  const additionalRouteGlob = moduleGlob(
    routeDir,
    `${routeDir}/**/*.${extensionGlob(bareRouteExtensions)}`,
  );

  const shellGlob = isPagesMode
    ? [
        ...moduleGlob(resolved.pagesDir, `${resolved.pagesDir}/**/_app.{ts,tsx,js,jsx}`),
        ...createReservedSubtreeExcludes(resolved.pagesDir),
      ]
    : moduleGlob(resolved.shellsDir, `${resolved.shellsDir}/**/*.{ts,tsx,js,jsx,md,mdx}`);
  const additionalShellGlob = isPagesMode
    ? [
        ...moduleGlob(
          resolved.pagesDir,
          `${resolved.pagesDir}/**/_app.${extensionGlob(bareRouteExtensions)}`,
        ),
        ...createReservedSubtreeExcludes(resolved.pagesDir),
      ]
    : moduleGlob(
        resolved.shellsDir,
        `${resolved.shellsDir}/**/*.${extensionGlob(bareRouteExtensions)}`,
      );
  const middlewareGlob = moduleGlob(
    resolved.middlewareDir,
    `${resolved.middlewareDir}/**/*.{ts,tsx,js,jsx}`,
  );
  // Modules the manifest names outside the globbed directories.
  const external = collectExternalManifestModules(resolved, buildOptions.root);
  const externalGlob = (files: string[]): string[] =>
    externalRegistryEntries(files, (file) => file);

  return [
    `export const routeModules = {`,
    `  ...import.meta.glob(${JSON.stringify(routeGlob)}),`,
    `  ...import.meta.glob(${JSON.stringify(additionalRouteGlob)}),`,
    ...externalGlob(external.routes),
    `};`,
    `export const shellModules = {`,
    `  ...import.meta.glob(${JSON.stringify(shellGlob)}),`,
    `  ...import.meta.glob(${JSON.stringify(additionalShellGlob)}),`,
    ...externalGlob(external.shells),
    `};`,
    // Pages mode adds the root `_middleware` file so the generated manifest's
    // `pages` middleware resolves through the same runtime registry.
    ...(isPagesMode
      ? [
          `export const middlewareModules = {`,
          `  ...import.meta.glob(${JSON.stringify(middlewareGlob)}),`,
          `  ...import.meta.glob(${JSON.stringify(`${resolved.pagesDir}/_middleware.{ts,tsx,js,jsx}`)}),`,
          `};`,
        ]
      : external.middleware.length > 0
        ? [
            `export const middlewareModules = {`,
            `  ...import.meta.glob(${JSON.stringify(middlewareGlob)}),`,
            ...externalGlob(external.middleware),
            `};`,
          ]
        : [
            `export const middlewareModules = import.meta.glob(${JSON.stringify(middlewareGlob)});`,
          ]),
    `export const apiModules = import.meta.glob(${JSON.stringify(apiGlobs)});`,
    ...(external.loaders.length > 0
      ? [
          `export const dataModules = {`,
          `  ...import.meta.glob(${JSON.stringify(moduleGlob(resolved.serverDir, `${resolved.serverDir}/**/*.{ts,js,tsx,jsx}`))}),`,
          ...externalGlob(external.loaders),
          `};`,
        ]
      : [
          `export const dataModules = import.meta.glob(${JSON.stringify(moduleGlob(resolved.serverDir, `${resolved.serverDir}/**/*.{ts,js,tsx,jsx}`))});`,
        ]),
    `export const capabilityModules = import.meta.glob(${JSON.stringify(moduleGlob(resolved.capabilitiesDir, `${resolved.capabilitiesDir}/**/*.{ts,js,tsx,jsx}`))});`,
    // The one module `defineApp({ root })` registers, or none.
    appRoot
      ? `export const rootModules = { ${JSON.stringify(appRoot.id)}: () => import(${JSON.stringify(appRoot.id)}) };`
      : "export const rootModules = {};",
    "",
    "export const registry = {",
    "  routeModules,",
    "  shellModules,",
    "  middlewareModules,",
    "  apiModules,",
    "  dataModules,",
    "  capabilityModules,",
    "  rootModules,",
    "};",
  ].join("\n");
}

const pagesAppSourceCache = new Map<string, string>();

export function clearPagesAppSourceCache(): void {
  pagesAppSourceCache.clear();
}

/**
 * The generated pages manifest, inlined into a virtual module.
 *
 * The client target drops `agents` and `constraints` — the two keys only the
 * server reads — along with the `_app.config.ts` import that supplies them.
 * Without that split the browser entry would import the config module, and
 * every Web Bot Auth key in it would ship to visitors.
 */
function generatePagesAppInlineSource(
  options: ResolvedPrachtPluginOptions,
  root = process.cwd(),
  target: "server" | "client" = "server",
): string {
  const absPagesDir = resolve(root, options.pagesDir.slice(1));
  const absCapabilitiesDir = resolve(root, options.capabilitiesDir.slice(1));
  const cacheKey = JSON.stringify({
    additionalExtensions: options.additionalExtensions,
    absCapabilitiesDir,
    absPagesDir,
    capabilitiesDirPrefix: options.capabilitiesDir,
    pagesDefaultRender: options.pagesDefaultRender,
    pagesDirPrefix: options.pagesDir,
    target,
  });
  const cached = pagesAppSourceCache.get(cacheKey);
  if (cached) return cached;

  const pages = scanPagesDirectory(absPagesDir, options.additionalExtensions);
  const source = generatePagesManifestSource(pages, {
    additionalExtensions: options.additionalExtensions,
    capabilitiesDir: absCapabilitiesDir,
    capabilitiesDirPrefix: options.capabilitiesDir,
    pagesDir: absPagesDir,
    pagesDefaultRender: options.pagesDefaultRender,
    pagesDirPrefix: options.pagesDir,
    target,
  });
  pagesAppSourceCache.set(cacheKey, source);
  return source;
}
