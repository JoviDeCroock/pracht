import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { maskCommentsAndStrings } from "@pracht/capabilities/static";
import { parseAst } from "vite";
import { getRolldownLang } from "./client-module-query.ts";
import { detectHeadExport, detectLoaderExport } from "./route-loader-hints.ts";
import {
  DEFAULT_ROUTE_EXTENSIONS,
  DEFAULT_SHELL_EXTENSIONS,
  normalizeAdditionalExtensions,
  withAdditionalExtensions,
} from "./route-extensions.ts";
import { collectBindingNamesFromPattern, getIdentifierName } from "./scope-analysis-helpers.ts";
import type { OxcNode } from "./scope-analysis-types.ts";

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
}

export interface PagesRouterOptions {
  pagesDir: string;
  pagesDefaultRender?: string;
  additionalExtensions?: readonly string[];
}

// Mirrors the `middlewareDir` registry glob (`**/*.{ts,tsx,js,jsx}`): a pages
// middleware file must be resolvable through the same runtime registry.
const MIDDLEWARE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
// Page source extensions that look like they could hold middleware but that
// the runtime registry glob cannot load. `.md`/`.mdx` stay ordinary ignored
// `_`-files — Markdown cannot export a function — but `.tsrx` and configured
// custom formats are first-class page authoring extensions, so silently
// ignoring a middleware-shaped file in either format would fail open exactly
// like a nested file.
const MIDDLEWARE_UNSUPPORTED_EXTENSIONS = new Set([".tsrx"]);

/**
 * The root-level `_middleware.{ts,tsx,js,jsx}` file of a pages directory, or
 * null when the app has none. Fails loudly on every shape that would
 * otherwise fail open: a nested `_middleware` file, a `_middleware/`
 * directory, a middleware-shaped file using a page extension the runtime
 * registry cannot load (all unsupported — they would be silently ignored while
 * looking like an auth gate), and multiple root files competing for the same
 * registration.
 */
export function findPagesMiddlewareFile(
  pagesDir: string,
  additionalExtensions: readonly string[] = [],
): string | null {
  const allFiles = scanAllFiles(pagesDir);
  const unsupportedExtensions = new Set([
    ...MIDDLEWARE_UNSUPPORTED_EXTENSIONS,
    ...normalizeAdditionalExtensions(additionalExtensions).filter(
      (extension) => !MIDDLEWARE_EXTENSIONS.has(extension),
    ),
  ]);

  const inMiddlewareDirectory = allFiles.filter((file) =>
    relative(pagesDir, file).replace(/\\/g, "/").split("/").slice(0, -1).includes("_middleware"),
  );
  if (inMiddlewareDirectory.length > 0) {
    const shown = inMiddlewareDirectory.map((file) => relative(pagesDir, file).replace(/\\/g, "/"));
    throw new Error(
      `[pracht] A \`_middleware\` directory is not supported: ${shown.map((file) => JSON.stringify(file)).join(", ")}. ` +
        "Pages middleware is a single root-level `_middleware.ts` file in the pages directory " +
        "(it runs on every page route). Move the logic there, or eject to an explicit manifest " +
        "for per-group middleware.",
    );
  }

  const unsupported = allFiles.filter(
    (file) =>
      basename(file, extname(file)) === "_middleware" && unsupportedExtensions.has(extname(file)),
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
        "export a `middleware` function. It must `export const middleware: MiddlewareFn = " +
        "(args, next) => …` (a default export is not used); refusing to build routes that " +
        "would fail closed at request time.",
    );
  }

  return middlewareFile;
}

/** Whether a middleware module statically exposes a binding named `middleware`. */
function exportsMiddleware(source: string, file: string): boolean {
  const program = parseAst(source, { lang: getRolldownLang(file) }) as OxcNode;
  const { runtimeBindings, typeOnlyBindings } = collectTopLevelBindingKinds(program);

  for (const statement of program.body as OxcNode[]) {
    if (statement.type === "ExportAllDeclaration") {
      // `export type *` has no runtime bindings, while
      // `export * as middleware` exposes a namespace object rather than the
      // required function. Only an ordinary value `export * from` can
      // conservatively re-export a working middleware binding.
      if (statement.exportKind === "type" || statement.exported) continue;
      // The exported names cannot be known without loading the target module.
      // Preserve working re-export barrels; runtime validation still fails closed.
      return true;
    }
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;

    const declaration = statement.declaration as OxcNode | null;
    if (declaration?.type === "FunctionDeclaration") {
      if (getIdentifierName(declaration.id as OxcNode | null) === "middleware") return true;
    } else if (declaration?.type === "VariableDeclaration" && declaration.declare !== true) {
      for (const declarator of declaration.declarations as OxcNode[]) {
        if (collectBindingNamesFromPattern(declarator.id as OxcNode).includes("middleware")) {
          return true;
        }
      }
    }

    for (const specifier of statement.specifiers as OxcNode[]) {
      if (specifier.type !== "ExportSpecifier" || specifier.exportKind === "type") continue;
      if (getIdentifierName(specifier.exported as OxcNode | null) !== "middleware") continue;

      // A re-export from another module cannot be resolved without loading it;
      // preserve working value barrels and let runtime validation fail closed.
      if (statement.source) return true;

      const localName = getIdentifierName(specifier.local as OxcNode | null);
      if (localName && typeOnlyBindings.has(localName) && !runtimeBindings.has(localName)) {
        continue;
      }
      return true;
    }
  }

  return false;
}

function collectTopLevelBindingKinds(program: OxcNode): {
  runtimeBindings: Set<string>;
  typeOnlyBindings: Set<string>;
} {
  const runtimeBindings = new Set<string>();
  const typeOnlyBindings = new Set<string>();

  for (const rawStatement of program.body as OxcNode[]) {
    if (rawStatement.type === "ImportDeclaration") {
      for (const specifier of rawStatement.specifiers as OxcNode[]) {
        const name = getIdentifierName(specifier.local as OxcNode | null);
        if (!name) continue;
        if (rawStatement.importKind === "type" || specifier.importKind === "type") {
          typeOnlyBindings.add(name);
        } else {
          runtimeBindings.add(name);
        }
      }
      continue;
    }

    const statement =
      rawStatement.type === "ExportNamedDeclaration"
        ? (rawStatement.declaration as OxcNode | null)
        : rawStatement;
    if (!statement) continue;

    if (
      statement.type === "TSTypeAliasDeclaration" ||
      statement.type === "TSInterfaceDeclaration"
    ) {
      const name = getIdentifierName(statement.id as OxcNode | null);
      if (name) typeOnlyBindings.add(name);
      continue;
    }

    if (statement.type === "TSDeclareFunction" || statement.declare === true) {
      if (statement.type === "VariableDeclaration") {
        for (const declarator of statement.declarations as OxcNode[]) {
          for (const name of collectBindingNamesFromPattern(declarator.id as OxcNode)) {
            typeOnlyBindings.add(name);
          }
        }
      } else {
        const name = getIdentifierName(statement.id as OxcNode | null);
        if (name) typeOnlyBindings.add(name);
      }
      continue;
    }

    if (statement.type === "VariableDeclaration") {
      for (const declarator of statement.declarations as OxcNode[]) {
        for (const name of collectBindingNamesFromPattern(declarator.id as OxcNode)) {
          runtimeBindings.add(name);
        }
      }
      continue;
    }

    if (
      statement.type === "FunctionDeclaration" ||
      statement.type === "ClassDeclaration" ||
      statement.type === "TSEnumDeclaration" ||
      statement.type === "TSModuleDeclaration"
    ) {
      const name = getIdentifierName(statement.id as OxcNode | null);
      if (name) runtimeBindings.add(name);
    }
  }

  return { runtimeBindings, typeOnlyBindings };
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
    if (name === "_app" && !shellExtensions.has(ext)) continue;

    // Skip _-prefixed files except _app
    if (name.startsWith("_") && name !== "_app") continue;

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

  const allFiles = scanAllFiles(pagesDir);
  const appFile = allFiles.find(
    (f) =>
      !relative(pagesDir, f).replace(/\\/g, "/").includes("/") &&
      basename(f, extname(f)) === "_app" &&
      shellExtensions.has(extname(f)),
  );
  const middlewareFile = findPagesMiddlewareFile(pagesDir, options.additionalExtensions);

  const coreImports = pages.some((page) => page.revalidateSeconds !== undefined)
    ? "defineApp, group, route, timeRevalidate"
    : "defineApp, group, route";
  const lines: string[] = [`import { ${coreImports} } from "@pracht/core/manifest";`, ""];

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
    routeEntries.push(
      `    route(${JSON.stringify(page.routePath)}, ${fileRef}, { ${metaParts.join(", ")} })`,
    );
  }

  const notFoundEntry = notFoundPage
    ? buildNotFoundEntry(notFoundPage, { fileRef: pageFileRef(notFoundPage), withShell: !!appFile })
    : null;

  // Root-level special files (`_app`, `_middleware`) are referenced relative
  // to the pages directory's parent so ejected manifests written next to it
  // (e.g. `src/routes.ts` beside `src/pages/`) resolve them.
  const specialFileRef = (file: string): string => {
    const path = prefix ? `${prefix}/${basename(file)}` : relativeModuleRef(file);
    return useImport ? `() => import(${JSON.stringify(path)})` : JSON.stringify(path);
  };

  // `_middleware` registers as a named middleware and is attached to every
  // page route through the wrapping group. API routes stay independent, the
  // same default an explicit manifest has.
  const groupMetaParts: string[] = [];
  if (appFile) groupMetaParts.push('shell: "pages"');
  if (middlewareFile) groupMetaParts.push('middleware: ["pages"]');

  lines.push("const app = defineApp({");
  if (appFile) {
    lines.push("  shells: {");
    lines.push(`    pages: ${specialFileRef(appFile)},`);
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
  if (notFoundEntry) lines.push(notFoundEntry);
  lines.push("});");

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

export function generateRoutesFile(
  pagesDir: string,
  outputPath: string,
  options: PagesRouterOptions,
): void {
  const pages = scanPagesDirectory(pagesDir, options.additionalExtensions);
  // For standalone files, replace `const app` with `export const app`
  const manifestSource = generatePagesManifestSource(pages, {
    ...options,
    referenceBaseDir: dirname(outputPath),
    useImportSyntax: true,
  }).replace("const app = defineApp(", "export const app = defineApp(");
  const source = [
    "// Auto-generated from pages/ directory by @pracht/vite-plugin.",
    "// To use it directly: remove `pagesDir` from the pracht config, set `appFile` to this",
    "// file, and point `routesDir`/`shellsDir`/`middlewareDir` at the pages directory (or",
    "// move the referenced files into the conventional directories). The runtime resolves",
    "// manifest refs through those directory registries.",
    "",
    manifestSource,
  ].join("\n");

  writeFileSync(outputPath, source, "utf-8");
}
