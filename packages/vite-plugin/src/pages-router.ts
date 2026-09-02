import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import {
  hasNamedMiddlewareExport,
  hasNamedValueExport,
  hasValueStarExport,
  maskCommentsAndStrings,
  resolvePagesCapabilityName,
} from "@pracht/capabilities/static";
import { parseAst } from "vite";
import { getRolldownLang } from "./client-module-query.ts";
import { detectHeadExport, detectHeadersExport, detectLoaderExport } from "./route-loader-hints.ts";
import {
  DEFAULT_ROUTE_EXTENSIONS,
  DEFAULT_SHELL_EXTENSIONS,
  normalizeAdditionalExtensions,
  withAdditionalExtensions,
} from "./route-extensions.ts";

export interface ScannedPage {
  absolutePath: string;
  relativePath: string;
  routePath: string;
  isIndex: boolean;
  isCatchAll: boolean;
  isDynamic: boolean;
  renderMode?: string;
  hydrationMode?: string;
  revalidateSeconds?: number;
  hasRevalidateExport?: boolean;
  hasLoader?: boolean;
  hasHead?: boolean;
  hasHeaders?: boolean;
}

export interface PagesRouterOptions {
  pagesDir: string;
  pagesDefaultRender?: string;
  additionalExtensions?: readonly string[];
  /**
   * Absolute path of the capabilities directory. Every module in it is
   * registered as a capability. Defaults to `<pagesDir>/../capabilities`, the
   * `src/pages` + `src/capabilities` layout the plugin defaults to; pass `null`
   * to register none.
   */
  capabilitiesDir?: string | null;
}

export const GENERATED_PAGES_MANIFEST_MARKER =
  "Auto-generated from pages/ directory by @pracht/vite-plugin.";
export const GENERATED_PAGES_LAYOUT_EXPORT = "__PRACHT_EJECTED_PAGES_LAYOUT__";

// Mirrors the `middlewareDir` registry glob (`**/*.{ts,tsx,js,jsx}`): a pages
// middleware file must be resolvable through the same runtime registry.
const MIDDLEWARE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

// Mirrors the `capabilitiesDir` registry glob (`**/*.{ts,js,tsx,jsx}`).
const CAPABILITY_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

/**
 * The root-level `_middleware.{ts,tsx,js,jsx}` file of a pages directory, or
 * null when the app has none. Fails loudly on every shape that would
 * otherwise fail open: a nested `_middleware` file, a `_middleware/`
 * directory, any exact `_middleware` basename using an extension the runtime
 * registry cannot load (all unsupported — they would be silently ignored while
 * looking like an auth gate), and multiple root files competing for the same
 * registration.
 */
export function findPagesMiddlewareFile(
  pagesDir: string,
  _additionalExtensions: readonly string[] = [],
): string | null {
  const allFiles = scanAllFiles(pagesDir);

  const middlewareDirectories = scanAllDirectories(pagesDir).filter(
    (directory) => basename(directory) === "_middleware",
  );
  if (middlewareDirectories.length > 0) {
    const shown = middlewareDirectories.map((directory) =>
      relative(pagesDir, directory).replace(/\\/g, "/"),
    );
    throw new Error(
      `[pracht] A \`_middleware\` directory is not supported: ${shown.map((file) => JSON.stringify(file)).join(", ")}. ` +
        "Pages middleware is a single root-level `_middleware.ts` file in the pages directory " +
        "(it runs on every page route). Move the logic there, or eject to an explicit manifest " +
        "for per-group middleware.",
    );
  }

  const unsupported = allFiles.filter(
    (file) =>
      basename(file, extname(file)) === "_middleware" && !MIDDLEWARE_EXTENSIONS.has(extname(file)),
  );
  if (unsupported.length > 0) {
    const shown = unsupported.map((file) => relative(pagesDir, file).replace(/\\/g, "/"));
    throw new Error(
      `[pracht] Pages middleware cannot use the ${shown.map((file) => JSON.stringify(extname(file))).join(", ")} extension ` +
        `(${shown.map((file) => JSON.stringify(file)).join(", ")}). The middleware registry loads ` +
        "`.ts`, `.tsx`, `.js`, and `.jsx` modules only — rename the file to `_middleware.ts`.",
    );
  }

  const middlewareFiles = allFiles.filter(
    (file) =>
      basename(file, extname(file)) === "_middleware" && MIDDLEWARE_EXTENSIONS.has(extname(file)),
  );

  const nested = middlewareFiles.filter((file) =>
    relative(pagesDir, file).replace(/\\/g, "/").includes("/"),
  );
  if (nested.length > 0) {
    const shown = nested.map((file) => relative(pagesDir, file).replace(/\\/g, "/"));
    throw new Error(
      `[pracht] Nested pages middleware is not supported: ${shown.map((file) => JSON.stringify(file)).join(", ")}. ` +
        "Only a root-level `_middleware.ts` in the pages directory is applied (it runs on every " +
        "page route). Move the logic there, or eject to an explicit manifest for per-group " +
        "middleware.",
    );
  }

  if (middlewareFiles.length > 1) {
    const shown = middlewareFiles.map((file) => basename(file));
    throw new Error(
      `[pracht] Multiple pages middleware files resolve to the same registration: ${shown
        .map((file) => JSON.stringify(file))
        .join(", ")}. Keep exactly one root-level \`_middleware\` file.`,
    );
  }

  const middlewareFile = middlewareFiles[0] ?? null;
  if (middlewareFile && !exportsMiddleware(readFileSync(middlewareFile, "utf-8"), middlewareFile)) {
    throw new Error(
      `[pracht] Pages middleware ${JSON.stringify(relative(pagesDir, middlewareFile).replace(/\\/g, "/"))} does not ` +
        "export `middleware`. It must declare a named value export such as " +
        "`export const middleware: MiddlewareFn = (args, next) => …` (a default export is not " +
        "used). The runtime validates that the exported value is callable.",
    );
  }

  return middlewareFile;
}

/** A discovered `_app` shell and the registration it owns. */
export interface PagesAppShell {
  absolutePath: string;
  /** Posix directory of the shell relative to the pages directory; `""` at the root. */
  directory: string;
  /** Registered shell name: `pages` at the root, `pages:blog` for `blog/_app.tsx`. */
  name: string;
}

/** The registered shell name for an `_app` in `directory` (posix, `""` at the root). */
export function pagesShellName(directory: string): string {
  return directory === "" ? "pages" : `pages:${directory}`;
}

/**
 * Every `_app` shell in a pages directory, deepest first.
 *
 * An `_app` in a subdirectory owns the routes in that subtree: like a group's
 * `shell` in an explicit manifest, the nearest one wins and REPLACES the
 * parent rather than rendering inside it — `resolveApp()` gives every route
 * exactly one shell, so file-system nesting cannot mean something the manifest
 * router cannot express.
 *
 * Two `_app` files in the same directory are rejected: they compete for one
 * registration, and picking either silently drops the other's `head()` and
 * `headers()` from every route below.
 */
export function findPagesAppShellFiles(
  pagesDir: string,
  shellExtensions: ReadonlySet<string>,
): PagesAppShell[] {
  const shells = scanAllFiles(pagesDir)
    .filter((file) => {
      if (basename(file, extname(file)) !== "_app" || !shellExtensions.has(extname(file))) {
        return false;
      }
      // An `_app` inside an underscore-reserved tree is a deliberate helper,
      // not a shell that went unnoticed.
      const segments = relative(pagesDir, file).replace(/\\/g, "/").split("/");
      return !segments.slice(0, -1).some((segment) => segment.startsWith("_"));
    })
    .map((file) => {
      const directory = relative(pagesDir, file)
        .replace(/\\/g, "/")
        .split("/")
        .slice(0, -1)
        .join("/");
      return { absolutePath: file, directory, name: pagesShellName(directory) };
    });

  const byDirectory = new Map<string, PagesAppShell[]>();
  for (const shell of shells) {
    byDirectory.set(shell.directory, [...(byDirectory.get(shell.directory) ?? []), shell]);
  }
  for (const [directory, candidates] of byDirectory) {
    if (candidates.length < 2) continue;
    const shown = candidates
      .map((shell) => JSON.stringify(relative(pagesDir, shell.absolutePath).replace(/\\/g, "/")))
      .join(", ");
    throw new Error(
      `[pracht] Multiple \`_app\` shells in ${JSON.stringify(directory || ".")} compete for the ` +
        `same registration (${JSON.stringify(pagesShellName(directory))}): ${shown}. Keep exactly ` +
        "one `_app` file per directory.",
    );
  }

  // Deepest first so the nearest ancestor is the first prefix match.
  return shells.sort((left, right) => right.directory.length - left.directory.length);
}

/** The `_app` that owns a page: the nearest ancestor directory with one. */
export function findOwningPagesShell(
  shells: readonly PagesAppShell[],
  pageRelativePath: string,
): PagesAppShell | undefined {
  const segments = pageRelativePath.replace(/\\/g, "/").split("/").slice(0, -1);
  return shells.find(
    (shell) =>
      shell.directory === "" ||
      segments.slice(0, shell.directory.split("/").length).join("/") === shell.directory,
  );
}

/** Whether a middleware module explicitly exports, or may re-export, `middleware`. */
function exportsMiddleware(source: string, file: string): boolean {
  return hasNamedMiddlewareExport(parseAst(source, { lang: getRolldownLang(file) }));
}

/**
 * The app-level config file of a pages directory: `_app.config.ts` at the
 * pages root.
 *
 * Named after the shell it configures, because that is what it is — the
 * app-level knobs a manifest passes to `defineApp()` that no single route
 * owns. It is root-only for the same reason `_middleware` is: `agents`,
 * `constraints`, and `notFound` are app-wide, so a per-directory copy would
 * look scoped while being ignored.
 */
export const PAGES_APP_CONFIG_BASENAME = "_app.config";

/** The `defineApp` keys a pages app may set from `_app.config.ts`. */
export const PAGES_APP_CONFIG_EXPORTS = ["agents", "constraints", "notFound"] as const;

export interface PagesAppConfig {
  absolutePath: string;
  /** The subset of PAGES_APP_CONFIG_EXPORTS the module actually exports. */
  exports: string[];
}

/**
 * The root-level `_app.config.{ts,tsx,js,jsx}` of a pages directory, or null
 * when the app has none.
 *
 * Fails closed on every shape that would otherwise leave an app looking
 * configured while nothing is registered: a nested file, an unsupported
 * extension, duplicates, a module that exports none of the supported keys, and
 * a value `export *` whose names cannot be known without loading the module.
 */
export function findPagesAppConfigFile(pagesDir: string): PagesAppConfig | null {
  const named = scanAllFiles(pagesDir).filter(
    (file) => basename(file, extname(file)) === PAGES_APP_CONFIG_BASENAME,
  );
  if (named.length === 0) return null;

  const show = (file: string): string =>
    JSON.stringify(relative(pagesDir, file).replace(/\\/g, "/"));

  const nested = named.filter((file) => relative(pagesDir, file).replace(/\\/g, "/").includes("/"));
  if (nested.length > 0) {
    throw new Error(
      `[pracht] Nested \`${PAGES_APP_CONFIG_BASENAME}\` is not supported: ${nested.map(show).join(", ")}. ` +
        "`agents`, `constraints`, and `notFound` are app-wide, so only a root-level " +
        `\`${PAGES_APP_CONFIG_BASENAME}.ts\` in the pages directory is read.`,
    );
  }

  const unsupported = named.filter((file) => !MIDDLEWARE_EXTENSIONS.has(extname(file)));
  if (unsupported.length > 0) {
    throw new Error(
      `[pracht] Pages app config cannot use the ${unsupported.map((file) => JSON.stringify(extname(file))).join(", ")} ` +
        `extension (${unsupported.map(show).join(", ")}). Rename the file to ` +
        `\`${PAGES_APP_CONFIG_BASENAME}.ts\`.`,
    );
  }

  if (named.length > 1) {
    throw new Error(
      `[pracht] Multiple pages app config files resolve to the same registration: ` +
        `${named.map(show).join(", ")}. Keep exactly one root-level \`${PAGES_APP_CONFIG_BASENAME}\` file.`,
    );
  }

  const file = named[0];
  const program = parseAst(readFileSync(file, "utf-8"), { lang: getRolldownLang(file) });
  if (hasValueStarExport(program)) {
    throw new Error(
      `[pracht] Pages app config ${show(file)} re-exports \`export * from …\`, whose names cannot ` +
        "be read without loading the module. Re-export the keys explicitly, for example " +
        '`export { agents } from "./_config/agents.ts"`.',
    );
  }

  const exports = PAGES_APP_CONFIG_EXPORTS.filter((name) => hasNamedValueExport(program, name));
  if (exports.length === 0) {
    throw new Error(
      `[pracht] Pages app config ${show(file)} exports none of ` +
        `${PAGES_APP_CONFIG_EXPORTS.map((name) => `\`${name}\``).join(", ")}. It must declare named ` +
        "value exports such as `export const agents: PrachtAgentsConfig = { … }` (a default " +
        "export is not used), or be deleted.",
    );
  }

  return { absolutePath: file, exports: [...exports] };
}

/** A capability module auto-discovered from the capabilities directory. */
export interface PagesCapability {
  absolutePath: string;
  name: string;
}

/**
 * Every capability module in `capabilitiesDir`, keyed by the name it registers
 * under.
 *
 * The pages router has no `capabilities` registry, so the directory *is* the
 * registry: one module per capability, named by `defineCapability({ name })`
 * or by its file stem. That keeps registration explicit — a file has to be in
 * `src/capabilities/` to be reachable — without inventing a second place to
 * repeat the name.
 */
export function findPagesCapabilityFiles(capabilitiesDir: string): PagesCapability[] {
  const files = scanAllFiles(capabilitiesDir)
    .filter((file) => CAPABILITY_EXTENSIONS.has(extname(file)))
    // Declaration files describe a module, they are not one.
    .filter((file) => !file.endsWith(".d.ts"))
    .sort();

  const capabilities: PagesCapability[] = [];
  const byName = new Map<string, string[]>();

  for (const file of files) {
    const show = JSON.stringify(relative(capabilitiesDir, file).replace(/\\/g, "/"));
    const stem = basename(file, extname(file));
    const resolved = resolvePagesCapabilityName(stem, readFileSync(file, "utf-8"));
    if (!resolved.ok) {
      throw new Error(`[pracht] Capability module ${show} ${resolved.error}`);
    }
    capabilities.push({ absolutePath: file, name: resolved.name });
    byName.set(resolved.name, [...(byName.get(resolved.name) ?? []), show]);
  }

  for (const [name, shown] of byName) {
    if (shown.length < 2) continue;
    throw new Error(
      `[pracht] Multiple capability modules register the name ${JSON.stringify(name)}: ` +
        `${shown.join(", ")}. Keep one module per capability name.`,
    );
  }

  return capabilities;
}

export function scanPagesDirectory(
  pagesDir: string,
  additionalExtensions: readonly string[] = [],
): ScannedPage[] {
  const normalizedExtensions = normalizeAdditionalExtensions(additionalExtensions);
  const pageExtensions = withAdditionalExtensions(DEFAULT_ROUTE_EXTENSIONS, normalizedExtensions);
  const shellExtensions = withAdditionalExtensions(DEFAULT_SHELL_EXTENSIONS, normalizedExtensions);
  const pages: ScannedPage[] = [];
  scan(pagesDir, pagesDir, pages, pageExtensions, shellExtensions, new Set(normalizedExtensions));
  const appShell = pages.find((page) => page.routePath === "__shell__");
  if (appShell?.hasRevalidateExport) {
    throw new Error(
      `[pracht] Pages app shell ${JSON.stringify(appShell.relativePath)} exports REVALIDATE, ` +
        "but app shells are not ISG routes. Declare the policy on each ISG page instead.",
    );
  }
  return sortRoutes(pages);
}

function scan(
  dir: string,
  root: string,
  pages: ScannedPage[],
  pageExtensions: Set<string>,
  shellExtensions: Set<string>,
  additionalExtensions: Set<string>,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const abs = join(dir, entry);
    const stat = statSync(abs);

    if (stat.isDirectory()) {
      // The underscore prefix reserves both files and whole subtrees for
      // non-route implementation details. `_middleware/` is still rejected
      // separately by findPagesMiddlewareFile() because silently ignoring an
      // auth-looking directory would fail open.
      if (entry.startsWith("_")) continue;
      scan(abs, root, pages, pageExtensions, shellExtensions, additionalExtensions);
      continue;
    }

    const ext = extname(entry);
    if (!pageExtensions.has(ext)) continue;

    const name = basename(entry, ext);
    const isRootApp = dir === root && name === "_app";
    if (name === "_app" && (!isRootApp || !shellExtensions.has(ext))) continue;

    // Skip _-prefixed files except the root-level _app shell.
    if (name.startsWith("_") && !isRootApp) continue;

    const rel = relative(root, abs);
    const routePath = filePathToRoutePath(rel);
    const source = readFileSync(abs, "utf-8");
    const analysisSource = maskMarkdownFences(source, rel);
    const renderMode = extractQuotedPageExport(analysisSource, "RENDER_MODE", rel);
    const hydrationMode = extractQuotedPageExport(analysisSource, "HYDRATION", rel);
    const revalidate = extractRevalidateSeconds(analysisSource, rel);
    const hasLoader = detectLoaderExport(analysisSource);
    const hasHead =
      ext === ".md" ||
      ext === ".mdx" ||
      additionalExtensions.has(ext) ||
      detectHeadExport(analysisSource);
    const hasHeaders =
      ext === ".md" ||
      ext === ".mdx" ||
      additionalExtensions.has(ext) ||
      detectHeadersExport(analysisSource);

    pages.push({
      absolutePath: abs,
      relativePath: rel,
      routePath,
      isIndex: name === "index",
      isCatchAll: routePath.split("/").includes("*"),
      isDynamic: routePath.split("/").some((segment) => segment.startsWith(":")),
      renderMode,
      hydrationMode,
      revalidateSeconds: revalidate.seconds,
      hasRevalidateExport: revalidate.present,
      hasLoader,
      hasHead,
      hasHeaders,
    });
  }
}

export function filePathToRoutePath(relativePath: string): string {
  const extension = extname(relativePath);
  let route = extension ? relativePath.slice(0, -extension.length) : relativePath;
  route = route.replace(/\\/g, "/");

  // _app is not a route
  if (route === "_app" || route.endsWith("/_app")) return "__shell__";

  // Remove trailing /index
  if (route === "index") return "/";
  route = route.replace(/\/index$/, "");

  // Convert [param] → :param
  route = route.replace(/\[([^\].]+)\]/g, ":$1");

  // Convert [...param] → *
  route = route.replace(/\[\.\.\.([^\]]+)\]/g, "*");

  return `/${route}`;
}

export function sortRoutes(pages: ScannedPage[]): ScannedPage[] {
  return [...pages].filter((p) => p.routePath !== "__shell__").sort(comparePagesBySpecificity);
}

function comparePagesBySpecificity(left: ScannedPage, right: ScannedPage): number {
  const leftSegments = splitRoutePath(left.routePath);
  const rightSegments = splitRoutePath(right.routePath);
  const length = Math.max(leftSegments.length, rightSegments.length);

  for (let index = 0; index < length; index += 1) {
    const leftSegment = leftSegments[index];
    const rightSegment = rightSegments[index];

    // Exact routes should win over deeper catch-all routes that can also
    // match the same URL (e.g. `/docs` before `/docs/*`).
    if (!leftSegment) return -1;
    if (!rightSegment) return 1;

    const leftScore = getRouteSegmentSpecificity(leftSegment);
    const rightScore = getRouteSegmentSpecificity(rightSegment);
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }

    if (leftScore === 3 && leftSegment !== rightSegment) {
      return leftSegment.localeCompare(rightSegment);
    }
  }

  return left.routePath.localeCompare(right.routePath);
}

function splitRoutePath(routePath: string): string[] {
  return routePath.split("/").filter(Boolean);
}

function getRouteSegmentSpecificity(segment: string): number {
  if (segment === "*") return 1;
  if (segment.startsWith(":")) return 2;
  return 3;
}

function extractQuotedPageExport(
  source: string,
  name: "RENDER_MODE" | "HYDRATION",
  relativePath: string,
): string | undefined {
  const masked = maskCommentsAndStrings(source);
  const declarations = [...masked.matchAll(new RegExp(`export\\s+const\\s+${name}\\s*=`, "g"))];
  if (declarations.length === 0) return undefined;
  if (declarations.length > 1) {
    throw new Error(
      `[pracht] Pages route ${JSON.stringify(relativePath)} exports ${name} more than once.`,
    );
  }

  const declaration = declarations[0];
  const valueStart = (declaration.index ?? 0) + declaration[0].length;
  return source
    .slice(valueStart)
    .trimStart()
    .match(/^["'](\w+)["']/)?.[1];
}

const REVALIDATE_RE = /export\s+const\s+REVALIDATE\s*=\s*([^;\n]+)/;

function extractRevalidateSeconds(
  source: string,
  relativePath: string,
): { present: boolean; seconds?: number } {
  const matches = [...maskCommentsAndStrings(source).matchAll(new RegExp(REVALIDATE_RE, "g"))];
  if (matches.length === 0) return { present: false };
  if (matches.length > 1) {
    throw new Error(
      `[pracht] Pages route ${JSON.stringify(relativePath)} exports REVALIDATE more than once.`,
    );
  }
  const match = matches[0];

  const expression = match[1].trim().replace(/\s+as\s+const$/, "");
  if (!/^\d(?:_?\d)*$/.test(expression)) {
    throw new Error(
      `[pracht] Pages route ${JSON.stringify(relativePath)} must export REVALIDATE as a ` +
        "positive integer literal number of seconds (for example, `export const REVALIDATE = 60`).",
    );
  }

  const seconds = Number(expression.replaceAll("_", ""));
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(
      `[pracht] Pages route ${JSON.stringify(relativePath)} must export REVALIDATE as a ` +
        "positive integer literal number of seconds within JavaScript's safe integer range.",
    );
  }

  return { present: true, seconds };
}

/** Mask Markdown fenced examples while preserving source offsets and top-level MDX exports. */
function maskMarkdownFences(source: string, relativePath: string): string {
  if (!/\.mdx?$/.test(relativePath)) return source;

  const chars = source.split("");
  let activeFence: { character: "`" | "~"; continuationIndent: number; length: number } | null =
    null;
  for (const line of source.matchAll(/.*(?:\r?\n|$)/g)) {
    if (line[0] === "") continue;
    const lineStart = line.index ?? 0;
    const content = line[0].replace(/\r?\n$/, "");
    const stripped = stripMarkdownContainerPrefix(content);
    const fenceContent: string =
      activeFence && stripped.content.startsWith(" ".repeat(activeFence.continuationIndent))
        ? stripped.content.slice(activeFence.continuationIndent)
        : stripped.content;
    const opening: RegExpExecArray | null = activeFence
      ? null
      : /^ {0,3}(`{3,}|~{3,})/.exec(fenceContent);
    const closing = activeFence
      ? new RegExp(`^ {0,3}\\${activeFence.character}{${activeFence.length},}[ \\t]*$`).test(
          fenceContent,
        )
      : false;

    if (activeFence || opening) {
      for (let offset = 0; offset < line[0].length; offset += 1) {
        const index = lineStart + offset;
        if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
      }
    }

    if (closing) {
      activeFence = null;
    } else if (opening) {
      activeFence = {
        character: opening[1][0] as "`" | "~",
        continuationIndent: stripped.continuationIndent,
        length: opening[1].length,
      };
    }
  }
  return chars.join("");
}

function stripMarkdownContainerPrefix(line: string): {
  content: string;
  continuationIndent: number;
} {
  let content = line;
  let continuationIndent = 0;
  while (true) {
    const quote = /^ {0,3}> ?/.exec(content);
    if (quote) {
      content = content.slice(quote[0].length);
      continue;
    }
    const list = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(content);
    if (!list) return { content, continuationIndent };
    continuationIndent += list[0].length;
    content = content.slice(list[0].length);
  }
}

export function generatePagesManifestSource(
  pages: ScannedPage[],
  options: PagesRouterOptions & {
    /** Project-root-relative capabilities prefix (e.g. `/src/capabilities`). */
    capabilitiesDirPrefix?: string;
    pagesDirPrefix?: string;
    referenceBaseDir?: string;
    useImportSyntax?: boolean;
  },
): string {
  const pagesDir = options.pagesDir;
  const defaultRender = options.pagesDefaultRender ?? "ssr";
  // pagesDirPrefix is the project-root-relative prefix (e.g. "/src/pages")
  // used to build Vite-resolvable paths in virtual modules.
  const prefix = options.pagesDirPrefix;
  // useImportSyntax: when true, emit `() => import("path")` for IDE navigation.
  // Only used for ejected files; virtual modules must use plain strings.
  const useImport = options.useImportSyntax ?? false;
  const shellExtensions = withAdditionalExtensions(
    DEFAULT_SHELL_EXTENSIONS,
    normalizeAdditionalExtensions(options.additionalExtensions),
  );

  const appShells = findPagesAppShellFiles(pagesDir, shellExtensions);
  const rootAppShell = appShells.find((shell) => shell.directory === "");
  const middlewareFile = findPagesMiddlewareFile(pagesDir, options.additionalExtensions);
  const appConfig = findPagesAppConfigFile(pagesDir);
  const capabilitiesDir =
    options.capabilitiesDir === null
      ? null
      : (options.capabilitiesDir ?? resolve(pagesDir, "..", "capabilities"));
  const capabilities = capabilitiesDir ? findPagesCapabilityFiles(capabilitiesDir) : [];

  const coreImports = pages.some((page) => page.revalidateSeconds !== undefined)
    ? "defineApp, group, route, timeRevalidate"
    : "defineApp, group, route";
  const lines: string[] = [`import { ${coreImports} } from "@pracht/core/manifest";`];

  // Without a prefix, references are relative to the file that will contain
  // the generated manifest. Direct source-generation callers retain the
  // historical adjacent-manifest default (`src/routes.ts` beside `src/pages`).
  const referenceBaseDir = options.referenceBaseDir ?? join(pagesDir, "..");
  const relativeModuleRef = (file: string): string => {
    const path = relative(referenceBaseDir, file).replace(/\\/g, "/");
    return path.startsWith(".") ? path : `./${path}`;
  };
  const pageFileRef = (page: ScannedPage): string => {
    const path = prefix
      ? `${prefix}/${page.relativePath.replace(/\\/g, "/")}`
      : relativeModuleRef(page.absolutePath);
    return useImport ? `() => import(${JSON.stringify(path)})` : JSON.stringify(path);
  };
  const capabilityFileRef = (file: string): string => {
    const path =
      options.capabilitiesDirPrefix && capabilitiesDir
        ? `${options.capabilitiesDirPrefix}/${relative(capabilitiesDir, file).replace(/\\/g, "/")}`
        : relativeModuleRef(file);
    return useImport ? `() => import(${JSON.stringify(path)})` : JSON.stringify(path);
  };

  // `_app.config.ts` holds plain configuration values, not registry modules, so
  // it is imported directly rather than referenced by path. The specifier list
  // is filled in once the body is emitted, because only the keys the manifest
  // actually uses may be imported — an unused binding would not typecheck in
  // an ejected manifest, and `agents: undefined` would make an app that
  // configures nothing look like it opted into the agent surface.
  const appConfigImportIndex = lines.push("") - 1;
  const usedAppConfigExports: string[] = [];
  lines.push("");

  const routeEntries: string[] = [];
  // `pages/404.tsx` is the app's not-found page, not a route: it renders with
  // a 404 status when nothing matches, and it is never reachable at a URL of
  // its own (which is what would let it shadow a static asset).
  const notFoundPage = pages.find((page) => page.routePath === "/404");
  if (notFoundPage?.hasRevalidateExport) {
    throw new Error(
      `[pracht] Pages not-found module ${JSON.stringify(notFoundPage.relativePath)} exports ` +
        "REVALIDATE, but not-found responses are never ISG routes.",
    );
  }

  for (const page of pages) {
    if (page === notFoundPage) continue;
    const render = page.renderMode ?? defaultRender;
    if (render === "isg" && page.revalidateSeconds === undefined) {
      throw new Error(
        `[pracht] Pages route ${JSON.stringify(page.relativePath)} uses render mode "isg" but ` +
          "does not export a revalidation policy. Add `export const REVALIDATE = 60` with a " +
          "positive integer number of seconds, or use another render mode.",
      );
    }
    if (render !== "isg" && page.hasRevalidateExport) {
      throw new Error(
        `[pracht] Pages route ${JSON.stringify(page.relativePath)} exports REVALIDATE but its ` +
          `effective render mode is ${JSON.stringify(render)}. REVALIDATE is only valid with ` +
          '`RENDER_MODE = "isg"` (or `pagesDefaultRender: "isg"`).',
      );
    }
    const fileRef = pageFileRef(page);
    const metaParts = [
      `render: ${JSON.stringify(render)}`,
      `hasLoader: ${page.hasLoader ? "true" : "false"}`,
      `hasHead: ${page.hasHead ? "true" : "false"}`,
    ];
    if (page.hydrationMode) {
      metaParts.push(`hydration: ${JSON.stringify(page.hydrationMode)}`);
    }
    if (page.revalidateSeconds !== undefined) {
      metaParts.push(`revalidate: timeRevalidate(${page.revalidateSeconds})`);
    }
    // The wrapping group already carries the root shell, so only a nested
    // `_app` needs a per-route override. Assigning it on the route rather than
    // through nested groups keeps the emitted order identical to the scanned
    // specificity order the linear-scan matcher depends on.
    const owningShell = findOwningPagesShell(appShells, page.relativePath);
    if (owningShell && owningShell !== rootAppShell) {
      metaParts.push(`shell: ${JSON.stringify(owningShell.name)}`);
    }
    routeEntries.push(
      `    route(${JSON.stringify(page.routePath)}, ${fileRef}, { ${metaParts.join(", ")} })`,
    );
  }

  const notFoundEntry = notFoundPage
    ? buildNotFoundEntry(notFoundPage, {
        fileRef: pageFileRef(notFoundPage),
        withShell: !!rootAppShell,
      })
    : null;

  // Special files (`_app`, `_middleware`) are referenced relative to the pages
  // directory's parent so ejected manifests written next to it (e.g.
  // `src/routes.ts` beside `src/pages/`) resolve them.
  const specialFileRef = (file: string): string => {
    const path = prefix
      ? `${prefix}/${relative(pagesDir, file).replace(/\\/g, "/")}`
      : relativeModuleRef(file);
    return useImport ? `() => import(${JSON.stringify(path)})` : JSON.stringify(path);
  };

  // `_middleware` registers as a named middleware and is attached to every
  // page route through the wrapping group. API routes stay independent, the
  // same default an explicit manifest has.
  const groupMetaParts: string[] = [];
  if (rootAppShell) groupMetaParts.push('shell: "pages"');
  if (middlewareFile) groupMetaParts.push('middleware: ["pages"]');

  lines.push("const app = defineApp({");
  // `agents` and `constraints` come from `_app.config.ts` verbatim, which is
  // what makes the pages router's agent surface identical to a manifest's.
  for (const name of appConfig?.exports ?? []) {
    if (name === "notFound") continue; // handled below, next to `pages/404`
    usedAppConfigExports.push(name);
    lines.push(`  ${name},`);
  }
  if (capabilities.length > 0) {
    lines.push("  capabilities: {");
    for (const capability of capabilities) {
      lines.push(
        `    ${JSON.stringify(capability.name)}: ${capabilityFileRef(capability.absolutePath)},`,
      );
    }
    lines.push("  },");
  }
  if (appShells.length > 0) {
    lines.push("  shells: {");
    // Shallowest first so the generated registry reads top-down. Directory
    // shell names contain `:` and `/`, so they need quoting; `pages` does not.
    for (const shell of [...appShells].reverse()) {
      const key = /^[A-Za-z_$][\w$]*$/.test(shell.name) ? shell.name : JSON.stringify(shell.name);
      lines.push(`    ${key}: ${specialFileRef(shell.absolutePath)},`);
    }
    lines.push("  },");
  }
  if (middlewareFile) {
    lines.push("  middleware: {");
    lines.push(`    pages: ${specialFileRef(middlewareFile)},`);
    lines.push("  },");
  }
  lines.push("  routes: [");
  if (groupMetaParts.length > 0) {
    lines.push(`    group({ ${groupMetaParts.join(", ")} }, [`);
    lines.push(routeEntries.join(",\n"));
    lines.push("    ]),");
  } else {
    lines.push(routeEntries.join(",\n"));
  }
  lines.push("  ],");
  // `pages/404` is the more specific declaration and wins; the config export
  // covers apps that render their not-found page some other way.
  if (notFoundEntry) lines.push(notFoundEntry);
  else if (appConfig?.exports.includes("notFound")) {
    usedAppConfigExports.push("notFound");
    lines.push("  notFound,");
  }
  lines.push("});");

  if (appConfig && usedAppConfigExports.length > 0) {
    const path = prefix
      ? `${prefix}/${relative(pagesDir, appConfig.absolutePath).replace(/\\/g, "/")}`
      : relativeModuleRef(appConfig.absolutePath);
    lines[appConfigImportIndex] =
      `import { ${usedAppConfigExports.join(", ")} } from ${JSON.stringify(path)};`;
  } else {
    lines.splice(appConfigImportIndex, 1);
  }

  lines.push("");
  return lines.join("\n");
}

function buildNotFoundEntry(
  page: ScannedPage,
  options: { fileRef: string; withShell: boolean },
): string {
  const configParts = [`component: ${options.fileRef}`];
  if (options.withShell) configParts.push('shell: "pages"');
  if (page.hydrationMode) configParts.push(`hydration: ${JSON.stringify(page.hydrationMode)}`);

  return `  notFound: { ${configParts.join(", ")} },`;
}

function scanAllFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      results.push(...scanAllFiles(abs));
    } else {
      results.push(abs);
    }
  }
  return results;
}

function scanAllDirectories(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const abs = join(dir, entry);
    if (!statSync(abs).isDirectory()) continue;
    results.push(abs, ...scanAllDirectories(abs));
  }
  return results;
}

export function generateRoutesFile(
  pagesDir: string,
  outputPath: string,
  options: PagesRouterOptions,
): void {
  const resolvedOutputPath = resolve(outputPath);
  const pages = scanPagesDirectory(pagesDir, options.additionalExtensions).filter(
    (page) => resolve(page.absolutePath) !== resolvedOutputPath,
  );
  // For standalone files, replace `const app` with `export const app`
  const manifestSource = generatePagesManifestSource(pages, {
    ...options,
    referenceBaseDir: dirname(outputPath),
    useImportSyntax: true,
  }).replace("const app = defineApp(", "export const app = defineApp(");
  const source = [
    `// ${GENERATED_PAGES_MANIFEST_MARKER}`,
    "// Keep this exported marker: the client build uses it to preserve pages-router",
    "// server-only boundaries after ejection without guessing from manifest syntax.",
    `export const ${GENERATED_PAGES_LAYOUT_EXPORT} = true;`,
    "// To use it directly: remove `pagesDir` from the pracht config, set `appFile` to this",
    "// file, and point `routesDir`/`shellsDir`/`middlewareDir` at the pages directory (or",
    "// move the referenced files into the conventional directories). The runtime resolves",
    "// manifest refs through those directory registries.",
    "",
    manifestSource,
  ].join("\n");

  writeFileSync(outputPath, source, "utf-8");
}
