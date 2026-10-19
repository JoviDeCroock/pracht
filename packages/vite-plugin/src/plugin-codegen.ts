import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, posix, resolve } from "node:path";
import { parseAst } from "vite";
import { SERVER_ENTRY_CONTRACT } from "@pracht/core/adapter";
import { resolveServerEntryBuildId } from "./build-id.ts";
import { getRolldownLang, PRACHT_CLIENT_MODULE_QUERY } from "./client-module-query.ts";
import {
  GENERATED_PAGES_LAYOUT_EXPORT,
  generatePagesManifestSource,
  scanPagesDirectory,
} from "./pages-router.ts";
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
import {
  createRouteHints,
  createRouteLoaderHints,
  fileStamp,
  sameFileStamp,
  type FileStamp,
  type RouteHints,
} from "./route-loader-hints.ts";
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

const PAGES_NON_FULL_HYDRATION_RE = /export\s+const\s+HYDRATION\s*=\s*["'](?:islands|none)["']/;

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

/** Per page file, by stamp: whether its source declares non-full hydration. */
const pageNonFullHydrationCache = new Map<string, { stamp: FileStamp; nonFull: boolean }>();

function pageDeclaresNonFullHydration(file: string): boolean {
  const stamp = fileStamp(statSync(file));
  const cached = pageNonFullHydrationCache.get(file);
  if (cached && sameFileStamp(cached.stamp, stamp)) return cached.nonFull;
  const nonFull = PAGES_NON_FULL_HYDRATION_RE.test(readFileSync(file, "utf-8"));
  pageNonFullHydrationCache.set(file, { stamp, nonFull });
  return nonFull;
}

function createNonFullHydrationExcludes(
  resolved: ResolvedPrachtPluginOptions,
  root: string = process.cwd(),
): string[] {
  const excludes = new Set<string>();

  if (resolved.pagesDir) {
    const files: string[] = [];
    scanFiles(
      resolve(root, resolved.pagesDir.replace(/^\//, "")),
      files,
      withAdditionalExtensions(DEFAULT_ROUTE_EXTENSIONS, resolved.additionalExtensions),
    );
    for (const file of files) {
      try {
        if (pageDeclaresNonFullHydration(file)) {
          excludes.add(
            `!/${toPosixPath(file).replace(toPosixPath(root).replace(/\/$/, "") + "/", "")}`,
          );
        }
      } catch {}
    }
    return [...excludes];
  }

  // A ref the scan cannot see could be a full route's, so a partial scan
  // excludes nothing.
  const scan = scanManifestModules(resolved, root);
  if (!scan.complete) return [];

  const appDir = dirname(resolve(root, resolved.appFile.replace(/^\//, "")));
  const resolveRef = (ref: string): string =>
    toPosixPath(ref.startsWith("/") ? resolve(root, ref.slice(1)) : resolve(appDir, ref));
  // One module can back a full route and an islands route, and the full route
  // needs it in the browser. A file is left out only when every ref to it in
  // the manifest belongs to a non-full route; a ref this scan cannot attribute
  // (a full route, a shared constant, a `notFound` component) keeps it in.
  const nonFullRefs = new Map<string, number>();
  for (const ref of scan.nonFullRefs) {
    const file = resolveRef(ref);
    nonFullRefs.set(file, (nonFullRefs.get(file) ?? 0) + 1);
  }
  if (nonFullRefs.size === 0) return [];

  const allRefs = new Map<string, number>();
  for (const value of scan.strings) {
    if (!value.startsWith(".") && !value.startsWith("/")) continue;
    const file = resolveRef(value);
    if (nonFullRefs.has(file)) allRefs.set(file, (allRefs.get(file) ?? 0) + 1);
  }

  const rootPrefix = `${toPosixPath(root).replace(/\/$/, "")}/`;
  for (const [file, count] of nonFullRefs) {
    if ((allRefs.get(file) ?? 0) > count) continue;
    excludes.add(`!/${file.replace(rootPrefix, "")}`);
  }

  return [...excludes];
}

const IMPORTING_NODE_TYPES = new Set([
  "ExportAllDeclaration",
  "ExportNamedDeclaration",
  "ImportDeclaration",
  "ImportExpression",
]);

/** Every string the manifest holds, and where it imports from. */
function collectManifestStrings(program: StaticProgramNode): {
  localImports: string[];
  valueImports: string[];
  eagerDynamicImport: boolean;
  strings: string[];
} {
  const strings: string[] = [];
  const localImports: string[] = [];
  // Static imports that bring values (not just types) into the manifest.
  const valueImports: string[] = [];
  // `() => import("./x")` written where a module ref goes (a call argument,
  // an object property value, an array element) is a lazy module ref. Any
  // other literal `import()`, including one behind a named helper the manifest
  // can call, hands the manifest values this scan never reads.
  const lazyImports = new WeakSet<object>();
  const markLazy = (candidate: unknown): void => {
    const arrow = asStaticProgramNode(candidate);
    if (arrow?.type !== "ArrowFunctionExpression") return;
    const body = asStaticProgramNode(arrow.body);
    if (body?.type === "ImportExpression") lazyImports.add(body);
  };
  let eagerDynamicImport = false;

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const node = asStaticProgramNode(value);
    if (!node) return;

    if (node.type === "CallExpression" && Array.isArray(node.arguments)) {
      for (const argument of node.arguments) markLazy(argument);
    } else if (node.type === "ArrayExpression" && Array.isArray(node.elements)) {
      for (const element of node.elements) markLazy(element);
    } else if (node.type === "Property" || node.type === "ObjectProperty") {
      markLazy(node.value);
    }

    if (
      typeof node.value === "string" &&
      (node.type === "Literal" || node.type === "StringLiteral")
    )
      strings.push(node.value);
    // `\`./routes/a.tsx\`` is a ref like "./routes/a.tsx", and counts as one.
    if (node.type === "TemplateLiteral") {
      const value = staticRefValue(node);
      if (value !== null) strings.push(value);
    }

    // A module ref can only be a plain string, so `import("./" + name)` never
    // contributes one — and a specifier that is not a literal is read below as
    // a reason to distrust the whole scan. `export const app = …` carries no
    // source at all and is not one of them.
    if (IMPORTING_NODE_TYPES.has(node.type) && node.source != null) {
      const specifier = asStaticProgramNode(node.source);
      const value = typeof specifier?.value === "string" ? specifier.value : "";
      // A literal `import("./x")` is a module ref (a route, middleware, or
      // capability the runtime loads), not manifest data: it is read as a
      // string above and never followed.
      if (node.type !== "ImportExpression" || value === "") localImports.push(value);
      if (node.type === "ImportExpression") {
        if (value !== "" && !lazyImports.has(node)) eagerDynamicImport = true;
      } else if (node.importKind !== "type" && node.exportKind !== "type") {
        valueImports.push(value);
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "type") continue;
      walk(node[key]);
    }
  };

  walk(program.body);
  return { localImports, valueImports, eagerDynamicImport, strings };
}

/**
 * Refs written where the runtime reads a module from them, by registry:
 * `route()` components and `notFound` (route modules), `shells` entries,
 * and the server-only `defineApp({ middleware })` entries and route `loader`
 * files. Each value is the ref exactly as written.
 */
interface PositionalManifestRefs {
  routes: string[];
  shells: string[];
  middleware: string[];
  loaders: string[];
}

/** The string a plain literal (or a template literal without expressions) holds. */
function staticStringValue(value: unknown): string | null {
  const node = unwrapStaticExpression(value);
  if (!node) return null;
  if ((node.type === "Literal" || node.type === "StringLiteral") && typeof node.value === "string")
    return node.value;
  if (node.type === "TemplateLiteral") {
    const quasis = Array.isArray(node.quasis) ? node.quasis : [];
    const expressions = Array.isArray(node.expressions) ? node.expressions : [];
    if (expressions.length !== 0 || quasis.length !== 1) return null;
    const cooked = (asStaticProgramNode(quasis[0])?.value as { cooked?: unknown } | undefined)
      ?.cooked;
    return typeof cooked === "string" ? cooked : null;
  }
  return null;
}

/** The literal a ref position holds: a string, or `() => import("…")`. */
function staticRefValue(value: unknown): string | null {
  const literal = staticStringValue(value);
  if (literal !== null) return literal;
  const node = unwrapStaticExpression(value);
  if (node?.type === "ArrowFunctionExpression") {
    const params = Array.isArray(node.params) ? node.params : [];
    const body = unwrapStaticExpression(node.body);
    if (params.length === 0 && body?.type === "ImportExpression")
      return staticRefValue(body.source);
  }
  return null;
}

function staticPropertyName(value: unknown): string | null {
  const property = asStaticProgramNode(value);
  if (property?.type !== "Property" && property?.type !== "ObjectProperty") return null;
  if (property.computed === true) return null;
  return getStaticProgramName(asStaticProgramNode(property.key));
}

function staticObjectProperties(value: unknown): Array<{ name: string; value: unknown }> {
  const node = unwrapStaticExpression(value);
  if (node?.type !== "ObjectExpression") return [];
  const properties = Array.isArray(node.properties) ? node.properties : [];
  const result: Array<{ name: string; value: unknown }> = [];
  for (const property of properties) {
    const name = staticPropertyName(property);
    if (name !== null) result.push({ name, value: asStaticProgramNode(property)!.value });
  }
  return result;
}

function calleeName(value: unknown): string | null {
  const callee = unwrapStaticExpression(value);
  if (callee?.type === "Identifier" && typeof callee.name === "string") return callee.name;
  if (callee?.type === "MemberExpression" && callee.computed !== true)
    return getStaticProgramName(asStaticProgramNode(callee.property));
  return null;
}

/** Whether an object literal hides properties behind a spread or computed key. */
function hasOpaqueProperties(value: unknown): boolean {
  const node = unwrapStaticExpression(value);
  if (node?.type !== "ObjectExpression") return true;
  const properties = Array.isArray(node.properties) ? node.properties : [];
  return properties.some((property) => staticPropertyName(property) === null);
}

/**
 * The refs a manifest module writes in a position the runtime reads a module
 * from. A ref held in a variable is not seen here; the build's registry check
 * reports it if the registry cannot serve it.
 *
 * Returns false when a route or shell ref position holds something other than
 * a literal (`"./routes/" + name + ".tsx"`, a variable, a spread): the module
 * it names cannot be known, so the scan must not be trusted to list them all.
 */
function collectPositionalRefs(program: StaticProgramNode, refs: PositionalManifestRefs): boolean {
  let literal = true;
  const push = (list: string[], value: unknown, required: boolean): void => {
    const ref = staticRefValue(value);
    if (ref !== null) list.push(ref);
    else if (required) literal = false;
  };
  const readComponentConfig = (value: unknown): void => {
    if (staticRefValue(value) !== null) {
      push(refs.routes, value, true);
      return;
    }
    if (hasOpaqueProperties(value)) {
      literal = false;
      return;
    }
    let component = false;
    for (const property of staticObjectProperties(value)) {
      if (property.name === "component") {
        component = true;
        push(refs.routes, property.value, true);
      }
      if (property.name === "loader") push(refs.loaders, property.value, false);
    }
    if (!component) literal = false;
  };

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const node = asStaticProgramNode(value);
    if (!node) return;

    if (node.type === "CallExpression" && calleeName(node.callee) === "route") {
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      if (args.some((arg) => asStaticProgramNode(arg)?.type === "SpreadElement")) literal = false;
      else readComponentConfig(args[1]);
    } else if (node.type === "ObjectExpression") {
      for (const property of staticObjectProperties(node)) {
        if (property.name === "shells") {
          if (hasOpaqueProperties(property.value)) literal = false;
          for (const shell of staticObjectProperties(property.value))
            push(refs.shells, shell.value, true);
        } else if (property.name === "middleware") {
          for (const entry of staticObjectProperties(property.value))
            push(refs.middleware, entry.value, false);
        } else if (property.name === "notFound") {
          readComponentConfig(property.value);
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "type") continue;
      walk(node[key]);
    }
  };

  walk(program.body);
  return literal;
}

type HydrationMode = "full" | "nonFull" | "unknown";

/**
 * The hydration mode a `route()`/`group()` meta argument gives, or `inherited`
 * when it sets none. Anything this cannot read for certain — a meta held in a
 * variable, a spread, a computed key, a non-literal value — is "unknown".
 */
function metaHydrationMode(meta: unknown, inherited: HydrationMode): HydrationMode {
  if (meta === undefined) return inherited;
  const node = unwrapStaticExpression(meta);
  if (node?.type !== "ObjectExpression") return "unknown";
  let mode = inherited;
  for (const property of Array.isArray(node.properties) ? node.properties : []) {
    const name = staticPropertyName(property);
    if (name === null) return "unknown";
    if (name !== "hydration") continue;
    const value = staticStringValue(asStaticProgramNode(property)!.value);
    mode =
      value === "full" ? "full" : value === "islands" || value === "none" ? "nonFull" : "unknown";
  }
  return mode;
}

/** A `route()` second argument's component ref: the module itself or `{ component }`. */
function componentRef(value: unknown): string | null {
  const direct = staticRefValue(value);
  if (direct !== null) return direct;
  for (const property of staticObjectProperties(value)) {
    if (property.name === "component") return staticRefValue(property.value);
  }
  return null;
}

/**
 * Component refs of `route()` calls whose hydration is provably `"islands"` or
 * `"none"`: their own literal mode or, without one, the innermost enclosing
 * `group()`'s. A route whose mode this cannot read for certain counts as full,
 * so its module stays in the client registry — dropping a module a route needs
 * breaks client navigation to it.
 */
function collectNonFullRouteRefs(program: StaticProgramNode, refs: string[]): void {
  const walk = (value: unknown, inherited: HydrationMode): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, inherited);
      return;
    }
    const node = asStaticProgramNode(value);
    if (!node) return;

    if (node.type === "CallExpression") {
      const name = calleeName(node.callee);
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      if (name === "group") {
        const mode = metaHydrationMode(args[0], inherited);
        for (const arg of args.slice(1)) walk(arg, mode);
        return;
      }
      if (name === "route") {
        // `route(path, { component, …meta })` reads its options from the
        // config object and ignores a third argument.
        const config = unwrapStaticExpression(args[1]);
        const meta = config?.type === "ObjectExpression" ? args[1] : args[2];
        if (metaHydrationMode(meta, inherited) === "nonFull") {
          const ref = componentRef(args[1]);
          if (ref !== null) refs.push(ref);
        }
        return;
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "type") continue;
      walk(node[key], inherited);
    }
  };
  walk(program.body, "full");
}

/** At most this many modules are read while following a manifest's imports. */
const MANIFEST_MODULE_LIMIT = 64;
const MANIFEST_IMPORT_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];

/** The file a relative import specifier loads, or null when it cannot tell. */
function resolveManifestImport(specifier: string, importer: string, root: string): string | null {
  const base = specifier.startsWith("/")
    ? resolve(root, specifier.slice(1))
    : resolve(dirname(importer), specifier);
  const candidates = [
    base,
    // TypeScript lets a `.js` specifier name the `.ts` source.
    ...(/\.[mc]?js$/.test(base)
      ? [base.replace(/js$/, "ts"), base.replace(/\.([mc]?)js$/, ".$1tsx")]
      : []),
    ...MANIFEST_IMPORT_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...MANIFEST_IMPORT_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

/**
 * What the app manifest and the local modules it imports say about module refs.
 *
 * `strings` holds every string literal in those modules, `refs` the ones
 * written in a ref position. Refs resolve against the app manifest's directory
 * wherever they are written — that is how the runtime reads them.
 *
 * `complete` is false as soon as a ref could live somewhere this scan cannot
 * see: a route or shell ref that is not a literal, an import specifier
 * assembled at runtime, a local import that does not resolve to a parseable
 * module, or more imports than the scan follows.
 */
interface ManifestScan {
  complete: boolean;
  strings: string[];
  refs: PositionalManifestRefs;
  /** Absolute paths of the manifest and every local module the scan read. */
  files: string[];
  /** Component refs of routes whose hydration is provably not `"full"`. */
  nonFullRefs: string[];
  /**
   * Whether a route may set `streaming`: some scanned module names it, the
   * manifest imports a package other than pracht's, or the scan is incomplete.
   */
  mayStream: boolean;
}

/** What one manifest module says, independent of where the scan started. */
interface ManifestModuleFacts {
  localImports: string[];
  strings: string[];
  refs: PositionalManifestRefs;
  nonFullRefs: string[];
  /** Every route and shell ref position holds a literal. */
  literalRefs: boolean;
  mentionsStreaming: boolean;
  /** Static value imports, which may supply route options. */
  valueImports: string[];
  /** A literal `import()` that is not a lazy `() => import(...)` ref. */
  eagerDynamicImport: boolean;
}

/**
 * Parsed facts per manifest module, checked against the file's stamp. The
 * client, server, and dev modules each scan the manifest several times per
 * regeneration; a file that has not changed is parsed once.
 */
const manifestModuleFactsCache = new Map<
  string,
  { stamp: FileStamp; facts: ManifestModuleFacts }
>();

/** Forget cached manifest facts for `file`, or for every file. */
export function invalidateManifestModuleFacts(file?: string): void {
  if (file === undefined) {
    manifestModuleFactsCache.clear();
    pageNonFullHydrationCache.clear();
  } else {
    manifestModuleFactsCache.delete(file);
    pageNonFullHydrationCache.delete(file);
  }
}

function readManifestModuleFacts(file: string): ManifestModuleFacts | null {
  let stamp: FileStamp;
  try {
    stamp = fileStamp(statSync(file));
  } catch {
    manifestModuleFactsCache.delete(file);
    return null;
  }
  const cached = manifestModuleFactsCache.get(file);
  if (cached && sameFileStamp(cached.stamp, stamp)) return cached.facts;

  try {
    const source = readFileSync(file, "utf-8");
    const program = parseAst(source, {
      lang: getRolldownLang(file),
    }) as unknown as StaticProgramNode;
    const collected = collectManifestStrings(program);
    const facts: ManifestModuleFacts = {
      localImports: collected.localImports,
      strings: collected.strings,
      refs: { routes: [], shells: [], middleware: [], loaders: [] },
      nonFullRefs: [],
      literalRefs: true,
      mentionsStreaming: /\bstreaming\b/.test(source),
      valueImports: collected.valueImports,
      eagerDynamicImport: collected.eagerDynamicImport,
    };
    facts.literalRefs = collectPositionalRefs(program, facts.refs);
    collectNonFullRouteRefs(program, facts.nonFullRefs);
    manifestModuleFactsCache.set(file, { stamp, facts });
    return facts;
  } catch {
    manifestModuleFactsCache.delete(file);
    return null;
  }
}

function scanManifestModules(resolved: ResolvedPrachtPluginOptions, root: string): ManifestScan {
  const refs: PositionalManifestRefs = { routes: [], shells: [], middleware: [], loaders: [] };
  const strings: string[] = [];
  const nonFullRefs: string[] = [];
  const appFile = resolve(root, resolved.appFile.replace(/^\//, ""));
  const ownedDirectories = [resolved.routesDir, resolved.shellsDir].map((directory) =>
    toPosixPath(resolve(root, directory.replace(/^\//, ""))),
  );
  const isOwned = (path: string): boolean =>
    ownedDirectories.some((directory) => toPosixPath(path).startsWith(`${directory}/`));

  const queue = [appFile];
  const seen = new Set(queue);
  let complete = true;
  let mayStream = false;
  while (queue.length > 0) {
    const file = queue.shift()!;
    const facts = readManifestModuleFacts(file);
    // An unreadable or unparseable manifest is the dev server's error to
    // report, not a reason to reorganize the bundle.
    if (!facts) {
      return { complete: false, strings, refs, files: [...seen], nonFullRefs, mayStream: true };
    }
    mayStream ||= facts.mentionsStreaming || facts.eagerDynamicImport;
    strings.push(...facts.strings);
    for (const kind of ["routes", "shells", "middleware", "loaders"] as const) {
      refs[kind].push(...facts.refs[kind]);
    }
    nonFullRefs.push(...facts.nonFullRefs);
    if (!facts.literalRefs) complete = false;

    for (const specifier of facts.localImports) {
      if (specifier === "") {
        complete = false;
        continue;
      }
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        // A package can hand the manifest route options this scan never reads.
        if (!specifier.startsWith("@pracht/")) mayStream = true;
        continue;
      }
      const target = resolveManifestImport(specifier, file, root);
      if (target === null) {
        complete = false;
        continue;
      }
      // A route or shell module is a leaf: it holds components, not refs. A
      // value imported from one may still be route options this scan never
      // reads.
      if (isOwned(target)) {
        if (facts.valueImports.includes(specifier)) mayStream = true;
        continue;
      }
      if (seen.has(target)) continue;
      if (seen.size >= MANIFEST_MODULE_LIMIT || !/\.[mc]?[jt]sx?$/.test(target)) {
        complete = false;
        continue;
      }
      seen.add(target);
      queue.push(target);
    }
  }

  return {
    complete,
    strings,
    refs,
    files: [...seen],
    nonFullRefs,
    mayStream: mayStream || !complete,
  };
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
  return scanManifestModules(resolved, root).files.map(toPosixPath);
}

/**
 * Whether any route may stream its document (`streaming: true`), which is the
 * only way a page's hydration state carries `defer()` values out of band.
 * Answers `true` whenever it cannot tell.
 */
export function appMayStream(resolved: ResolvedPrachtPluginOptions, root: string): boolean {
  if (!resolved.pagesDir) return scanManifestModules(resolved, root).mayStream;
  try {
    return scanPagesDirectory(
      resolve(root, resolved.pagesDir.replace(/^\//, "")),
      resolved.additionalExtensions,
    ).some((page) => page.streaming !== false && page.streaming !== undefined);
  } catch {
    return true;
  }
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
 * see (see `scanManifestModules`). Callers must then leave the registry as it
 * was — dropping a module a route needs breaks navigation to it, which is far
 * worse than shipping one nothing reaches.
 */
export function collectManifestModuleRefs(
  resolved: ResolvedPrachtPluginOptions,
  root: string = process.cwd(),
): { complete: boolean; files: Set<string> } {
  const files = new Set<string>();
  if (resolved.pagesDir) return { complete: false, files };

  const scan = scanManifestModules(resolved, root);
  const appDir = dirname(resolve(root, resolved.appFile.replace(/^\//, "")));
  const ownedDirectories = [resolved.routesDir, resolved.shellsDir].map((directory) =>
    toPosixPath(resolve(root, directory.replace(/^\//, ""))),
  );
  const isOwned = (path: string): boolean =>
    ownedDirectories.some((directory) => toPosixPath(path).startsWith(`${directory}/`));

  for (const value of scan.strings) {
    if (!value.startsWith(".") && !value.startsWith("/")) continue;
    const abs = value.startsWith("/") ? resolve(root, value.slice(1)) : resolve(appDir, value);
    if (!isOwned(abs)) continue;
    try {
      if (statSync(abs).isFile()) files.add(toPosixPath(abs));
    } catch {
      // A ref to a file that is not there fails `pracht build`; it cannot be
      // excluded from anything either way.
    }
  }

  return { complete: scan.complete, files };
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

  const scan = scanManifestModules(resolved, root);
  const rootPosix = toPosixPath(root).replace(/\/$/, "");
  const appDir = dirname(resolve(root, resolved.appFile.replace(/^\//, "")));
  const directoryOf = (directory: string): string =>
    `${toPosixPath(resolve(root, directory.replace(/^\//, "")))}/`;
  const globbed = {
    routes: [directoryOf(resolved.routesDir)],
    shells: [directoryOf(resolved.shellsDir)],
    middleware: [directoryOf(resolved.middlewareDir)],
    loaders: [directoryOf(resolved.serverDir)],
  };

  for (const kind of ["routes", "shells", "middleware", "loaders"] as const) {
    const found = new Set<string>();
    for (const ref of scan.refs[kind]) {
      if (!ref.startsWith(".") && !ref.startsWith("/")) continue;
      const abs = toPosixPath(
        ref.startsWith("/") ? resolve(root, ref.slice(1)) : resolve(appDir, ref.split("?")[0]!),
      );
      if (globbed[kind].some((directory) => abs.startsWith(directory))) continue;
      if (!abs.startsWith(`${rootPosix}/`)) continue;
      try {
        if (!statSync(abs).isFile()) continue;
      } catch {
        continue;
      }
      found.add(abs.slice(rootPosix.length));
    }
    external[kind] = [...found].sort();
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

  try {
    const appFile = resolve(root, resolved.appFile.replace(/^\//, ""));
    const manifestSource = readFileSync(appFile, "utf-8");
    return hasTrueConstExport(manifestSource, appFile, GENERATED_PAGES_LAYOUT_EXPORT);
  } catch {
    return false;
  }
}

type StaticProgramNode = {
  type: string;
  [key: string]: unknown;
};

function hasTrueConstExport(source: string, file: string, name: string): boolean {
  const program = parseAst(source, { lang: getRolldownLang(file) }) as unknown as StaticProgramNode;
  const statements = (Array.isArray(program.body) ? program.body : [])
    .map(asStaticProgramNode)
    .filter((statement): statement is StaticProgramNode => statement !== null);
  const trueConstBindings = new Set<string>();

  for (const statement of statements) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? asStaticProgramNode(statement.declaration)
        : statement;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;

    const declarators = Array.isArray(declaration.declarations) ? declaration.declarations : [];
    for (const declaratorValue of declarators) {
      const declarator = asStaticProgramNode(declaratorValue);
      if (declarator?.type !== "VariableDeclarator") continue;
      const identifier = asStaticProgramNode(declarator.id);
      if (identifier?.type !== "Identifier" || typeof identifier.name !== "string") continue;
      const initializer = unwrapStaticExpression(declarator.init);
      if (
        (initializer?.type === "BooleanLiteral" || initializer?.type === "Literal") &&
        initializer.value === true
      ) {
        trueConstBindings.add(identifier.name);
      }
    }
  }

  for (const statement of statements) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = asStaticProgramNode(statement.declaration);
    if (declaration?.type === "VariableDeclaration") {
      const declarators = Array.isArray(declaration.declarations) ? declaration.declarations : [];
      if (
        declarators.some((declaratorValue) => {
          const declarator = asStaticProgramNode(declaratorValue);
          const identifier = asStaticProgramNode(declarator?.id);
          return identifier?.type === "Identifier" && identifier.name === name;
        }) &&
        trueConstBindings.has(name)
      ) {
        return true;
      }
      continue;
    }
    if (statement.source) continue;

    const specifiers = Array.isArray(statement.specifiers) ? statement.specifiers : [];
    for (const specifierValue of specifiers) {
      const specifier = asStaticProgramNode(specifierValue);
      if (specifier?.type !== "ExportSpecifier" || specifier.exportKind === "type") continue;
      const local = asStaticProgramNode(specifier.local);
      const exported = asStaticProgramNode(specifier.exported);
      const localName = getStaticProgramName(local);
      if (
        localName !== null &&
        getStaticProgramName(exported) === name &&
        trueConstBindings.has(localName)
      ) {
        return true;
      }
    }
  }

  return false;
}

function unwrapStaticExpression(value: unknown): StaticProgramNode | null {
  let node = asStaticProgramNode(value);
  while (
    node &&
    new Set([
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSNonNullExpression",
      "TSSatisfiesExpression",
      "TSTypeAssertion",
      "TypeCastExpression",
    ]).has(node.type)
  ) {
    node = asStaticProgramNode(node.expression);
  }
  return node;
}

function asStaticProgramNode(value: unknown): StaticProgramNode | null {
  if (!value || typeof value !== "object" || !("type" in value)) return null;
  return typeof (value as { type?: unknown }).type === "string"
    ? (value as StaticProgramNode)
    : null;
}

function getStaticProgramName(value: StaticProgramNode | null): string | null {
  if (value?.type === "Identifier" && typeof value.name === "string") return value.name;
  if (value?.type === "Literal" && typeof value.value === "string") return value.value;
  return null;
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
    /** Defaults to the id `pracht build` passes in, or `"dev"` outside a build. */
    buildId?: string;
  } = {},
): string {
  const resolved = resolveOptions(options);
  const isPagesMode = !!resolved.pagesDir;
  const buildId = buildOptions.buildId ?? resolveServerEntryBuildId(buildOptions.isBuild);
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
    // The server entry contract `pracht build` reads through `readServerEntry()`
    // from `@pracht/core/adapter`.
    `export const contract = ${SERVER_ENTRY_CONTRACT};`,
    `export const buildId = ${JSON.stringify(buildId)};`,
    `export const adapterId = ${JSON.stringify(adapter?.id ?? "node")};`,
    `export const features = ${JSON.stringify({ headersManifest: adapter?.features?.headersManifest ?? 1 })};`,
    // TODO(next minor): drop `buildTarget`, the contract's former `adapterId`.
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
    const adapterSource = adapter.createServerEntryModule({ buildId });
    // CLI releases before `features` read this export instead; adapters
    // released before `features` emit it themselves.
    // TODO(next minor): drop the `headersManifestFormat` export.
    if (
      adapter.features?.headersManifest === 2 &&
      !/\bexport const headersManifestFormat\b/.test(adapterSource)
    ) {
      source.push("export const headersManifestFormat = 2;");
    }
    source.push(adapterSource);
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
    if (!key.startsWith("/")) continue;
    // The entry canonicalizes every ref before the lookup (`..` and `.`
    // segments collapse), so a configured directory like
    // `/src/other/../routes` must produce the same key.
    const canonical = posix.normalize(key);
    table[canonical] =
      (table[canonical] ?? 0) |
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
      rootRelativePrefix: prefix,
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
          rootRelativePrefix: dirname(file),
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
      const key = `${options.pagesDir}/${page.relativePath.replace(/\\/g, "/")}`;
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
    rootRelativePrefix: options.serverDir,
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
