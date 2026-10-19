/**
 * One reader for what the build knows about an app's source files without
 * running them.
 *
 * Every consumer — the registries, the route hint tables, the hydration
 * exclusions, the app root, the pages scanner, the dev server's hot-update
 * path, and `pracht verify` and the dev banner through the plugin API — asks
 * its question here rather than reading and parsing files itself, so two
 * readers can never disagree about the same file, and an unchanged file is
 * parsed once per version however many of them ask. Facts are keyed by
 * `ModuleId`, the one spelling of a module every lookup canonicalizes to.
 *
 * This is a fact reader, not a graph: it reports what the source says, and
 * each consumer decides what that means for it.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { extractDefineAppObjectBody, maskCommentsAndStrings } from "@pracht/capabilities/static";
import { parseAst } from "vite";

import { getRolldownLang } from "./client-module-query.ts";
import {
  canonicalModuleId,
  fileModuleId,
  moduleIdPath,
  toPosixPath,
  type ModuleId,
} from "./module-id.ts";
import {
  findPagesRootFile,
  GENERATED_PAGES_LAYOUT_EXPORT,
  invalidatePageFacts,
  scanPagesDirectory,
} from "./pages-router.ts";
import type { ResolvedPrachtPluginOptions } from "./plugin-options.ts";
import {
  fileStamp,
  invalidateModuleFacts,
  readModuleFacts,
  sameFileStamp,
  type FileStamp,
  type ModuleFacts,
} from "./route-loader-hints.ts";

export {
  canonicalModuleId,
  fileModuleId,
  isWithinRoot,
  moduleIdPath,
  type ModuleId,
} from "./module-id.ts";
export type { FileStamp, ModuleFacts } from "./route-loader-hints.ts";

/**
 * Where a manifest ref sits: a `route()` component, `notFound`, a `shells`,
 * `middleware` or `capabilities` registry entry, a route `loader:`, or any
 * other path-shaped string the manifest holds (`mention`), which a custom
 * helper may still hand the runtime as a module ref.
 */
export type ManifestRefKind =
  | "route"
  | "not-found"
  | "shell"
  | "middleware"
  | "capability"
  | "loader"
  | "mention";

/** A route's hydration as the manifest states it; `unknown` when it cannot be read for certain. */
export type RefHydration = "full" | "islands" | "none" | "unknown";

export interface ManifestRef {
  kind: ManifestRefKind;
  /** The ref as written, or `null` when the position holds a computed value. */
  ref: string | null;
  /** The module the ref names, or `null` for a computed ref. */
  id: ModuleId | null;
  /** The registry key, for `shell`, `middleware` and `capability` entries. */
  name?: string;
  hydration: RefHydration;
}

export interface ManifestFacts {
  refs: readonly ManifestRef[];
  /**
   * Every ref the app has is in `refs`. False as soon as one could live where
   * the reader cannot see: a computed ref, an import specifier assembled at
   * runtime, a local import that does not resolve to a parseable module, or
   * more imports than the reader follows.
   */
  complete: boolean;
  /** The module `defineApp({ root })` registers (pages: `_root`), or `null`. */
  appRoot: { ref: string; id: ModuleId } | null;
  /** Why `root` is registered but cannot be read statically, when that is so. */
  appRootError: string | null;
  /** The manifest is an ejected pages layout (`__PRACHT_EJECTED_PAGES_LAYOUT__`). */
  ejectedLayout: boolean;
  /**
   * Whether a route may set `streaming`: some module names it, the manifest
   * imports a package other than pracht's, or the read is incomplete.
   */
  mayStream: boolean;
  /** Absolute POSIX paths of the manifest and every local module it imports that was read. */
  files: readonly string[];
  /**
   * Local imports (`./x`, `/src/x`) that name no file, as written, with the
   * absolute POSIX path of the module that imports them.
   */
  unresolvedImports: readonly { specifier: string; importer: string }[];
  /** Why a manifest module could not be read or parsed, or `null` when every one was. */
  error: string | null;
}

export interface AnalysisSession {
  /** The facts of one module, or `null` when it cannot be read. One parse per file stamp. */
  module(id: ModuleId, stamp?: FileStamp): ModuleFacts | null;
  /** What the app manifest says. Each manifest module is parsed once per file stamp. */
  manifest(): ManifestFacts;
  /** Forget what was read from `file` (absolute), or from every file. */
  invalidate(file?: string): void;
}

const sessions = new Map<string, AnalysisSession>();

/** The analysis session for an app at `root` with these plugin options. */
export function getAnalysisSession(
  resolved: ResolvedPrachtPluginOptions,
  root: string = process.cwd(),
): AnalysisSession {
  const key = JSON.stringify([
    root,
    resolved.appFile,
    resolved.pagesDir,
    resolved.routesDir,
    resolved.shellsDir,
    resolved.additionalExtensions,
  ]);
  let session = sessions.get(key);
  if (!session) {
    session = createAnalysisSession(resolved, root);
    sessions.set(key, session);
  }
  return session;
}

function createAnalysisSession(
  resolved: ResolvedPrachtPluginOptions,
  root: string,
): AnalysisSession {
  const memo: ManifestMemo = { inputs: [], facts: null, refs: new WeakMap() };
  return {
    module: (id, stamp) => readModuleFacts(moduleIdPath(root, id), stamp),
    manifest: () =>
      resolved.pagesDir ? readPagesManifest(resolved, root) : readManifest(resolved, root, memo),
    invalidate(file) {
      invalidateModuleFacts(file);
      invalidatePageFacts(file);
      if (file === undefined) manifestModuleCache.clear();
      else manifestModuleCache.delete(file);
    },
  };
}

// ---------------------------------------------------------------------------
// Manifest mode

/** At most this many modules are read while following a manifest's imports. */
const MANIFEST_MODULE_LIMIT = 64;
const MANIFEST_IMPORT_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];

/**
 * A session's last manifest read. Every reader in one regeneration asks for
 * the same facts, so a walk that meets the same module reads and import
 * targets as the last one returns the facts it built, and a module's refs are
 * resolved to ids once per read.
 */
interface ManifestMemo {
  inputs: unknown[];
  facts: ManifestFacts | null;
  refs: WeakMap<ManifestModuleRead, ManifestRef[]>;
}

function readManifest(
  resolved: ResolvedPrachtPluginOptions,
  root: string,
  memo: ManifestMemo,
): ManifestFacts {
  const appFile = resolve(root, resolved.appFile.replace(/^\//, ""));
  const appDir = dirname(appFile);
  const ownedDirectories = [resolved.routesDir, resolved.shellsDir].map((directory) =>
    toPosixPath(resolve(root, directory.replace(/^\//, ""))),
  );
  const isOwned = (path: string): boolean =>
    ownedDirectories.some((directory) => toPosixPath(path).startsWith(`${directory}/`));

  const reads: ManifestModuleRead[] = [];
  const inputs: unknown[] = [];
  const queue = [appFile];
  const seen = new Set(queue);
  let complete = true;
  let mayStream = false;
  let entry: ManifestModuleRead | null = null;
  let entryFailure: ManifestModuleFailure | null = null;
  let error: string | null = null;
  const unresolvedImports: { specifier: string; importer: string }[] = [];

  while (queue.length > 0) {
    const file = queue.shift()!;
    const read = readManifestModule(file);
    inputs.push(read);
    if (file === appFile) {
      if ("failure" in read) entryFailure = read.failure;
      else entry = read.facts;
    }
    // An unreadable or unparseable manifest is the dev server's error to
    // report, not a reason to reorganize the bundle.
    if ("failure" in read) {
      complete = false;
      mayStream = true;
      error = `${relative(root, file).split(sep).join("/")}: ${read.failure.error}`;
      break;
    }
    const facts = read.facts;
    mayStream ||= facts.mentionsStreaming || facts.eagerDynamicImport;
    if (!facts.literalRefs) complete = false;
    reads.push(facts);

    for (const specifier of facts.localImports) {
      if (specifier === "") {
        complete = false;
        continue;
      }
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        // A package can hand the manifest route options this reader never sees.
        if (!specifier.startsWith("@pracht/")) mayStream = true;
        continue;
      }
      const target = resolveManifestImport(specifier, file, root);
      inputs.push(target);
      if (target === null) {
        complete = false;
        unresolvedImports.push({ specifier, importer: toPosixPath(file) });
        continue;
      }
      // A route or shell module is a leaf: it holds components, not refs. A
      // value imported from one may still be route options this reader never
      // sees.
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

  if (
    memo.facts !== null &&
    inputs.length === memo.inputs.length &&
    inputs.every((input, index) => input === memo.inputs[index])
  ) {
    return memo.facts;
  }

  const refs: ManifestRef[] = [];
  for (const read of reads) {
    let resolvedRefs = memo.refs.get(read);
    if (!resolvedRefs) {
      // Refs resolve against the app manifest's directory wherever they are
      // written: that is how the runtime reads them.
      resolvedRefs = read.refs.map((written) => ({
        ...written,
        id: written.ref === null ? null : canonicalModuleId(root, written.ref, appDir),
      }));
      memo.refs.set(read, resolvedRefs);
    }
    refs.push(...resolvedRefs);
  }

  const rootRef = entry?.root ?? null;
  memo.inputs = inputs;
  return (memo.facts = {
    refs,
    complete,
    appRoot:
      rootRef && "ref" in rootRef
        ? { ref: rootRef.ref, id: canonicalModuleId(root, rootRef.ref, appDir) }
        : null,
    appRootError: rootRef && "error" in rootRef ? rootRef.error : (entryFailure?.rootError ?? null),
    ejectedLayout: entry?.ejectedLayout ?? false,
    mayStream: mayStream || !complete,
    files: [...seen].map(toPosixPath),
    unresolvedImports,
    error,
  });
}

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

/** A ref as one manifest module writes it, before it is resolved to an id. */
type WrittenRef = Omit<ManifestRef, "id">;

/** What one manifest module says, independent of where the read started. */
interface ManifestModuleRead {
  localImports: string[];
  /** Static value imports, which may supply route options. */
  valueImports: string[];
  /** A literal `import()` that is not a lazy `() => import(...)` ref. */
  eagerDynamicImport: boolean;
  mentionsStreaming: boolean;
  refs: WrittenRef[];
  /** Every route, shell and component ref position holds a literal. */
  literalRefs: boolean;
  /** `defineApp({ root })` in this module, read or unreadable. */
  root: { ref: string } | { error: string } | null;
  ejectedLayout: boolean;
}

interface ManifestModuleFailure {
  /** Why the module could not be read or parsed. */
  error: string;
  /** Set when the module failed to parse while its `defineApp({ … })` names `root`. */
  rootError: string | null;
}

type ManifestModuleResult = { facts: ManifestModuleRead } | { failure: ManifestModuleFailure };

/**
 * Parsed facts per manifest module, checked against the file's stamp. A
 * module that does not parse is remembered too, so a broken manifest is not
 * re-parsed by every reader until it changes.
 */
const manifestModuleCache = new Map<string, { stamp: FileStamp; result: ManifestModuleResult }>();

function readManifestModule(file: string): ManifestModuleResult {
  let stamp: FileStamp;
  try {
    stamp = fileStamp(statSync(file));
  } catch {
    manifestModuleCache.delete(file);
    return { failure: { error: "the file does not exist", rootError: null } };
  }
  const cached = manifestModuleCache.get(file);
  if (cached && sameFileStamp(cached.stamp, stamp)) return cached.result;

  let result: ManifestModuleResult;
  let source = "";
  try {
    source = readFileSync(file, "utf-8");
    const program = parseAst(source, { lang: getRolldownLang(file) }) as unknown as StaticNode;
    result = { facts: readManifestProgram(program, source) };
  } catch (error) {
    const body = source ? extractDefineAppObjectBody(source) : null;
    result = {
      failure: {
        error: error instanceof Error ? error.message : String(error),
        rootError:
          body !== null && /\broot\b/.test(maskCommentsAndStrings(body))
            ? `[pracht] The build could not parse defineApp({ … }) to read its root: ${
                error instanceof Error ? error.message : String(error)
              }`
            : null,
      },
    };
  }
  manifestModuleCache.set(file, { stamp, result });
  return result;
}

function readManifestProgram(program: StaticNode, source: string): ManifestModuleRead {
  const collected = collectManifestStrings(program);
  const positional = collectPositionalRefs(program);

  // Every path-shaped string the module holds that is not already a ref in a
  // position counts as a mention: a custom helper may still pass it to the
  // runtime, so it must keep its module referenced.
  const unclaimed = new Map<string, number>();
  for (const value of collected.strings) {
    if (!value.startsWith(".") && !value.startsWith("/")) continue;
    unclaimed.set(value, (unclaimed.get(value) ?? 0) + 1);
  }
  for (const written of positional.refs) {
    const count = written.ref === null ? 0 : (unclaimed.get(written.ref) ?? 0);
    if (count > 0) unclaimed.set(written.ref!, count - 1);
  }
  const mentions: WrittenRef[] = [];
  for (const [ref, count] of unclaimed) {
    for (let index = 0; index < count; index += 1) {
      mentions.push({ kind: "mention", ref, hydration: "unknown" });
    }
  }

  return {
    localImports: collected.localImports,
    valueImports: collected.valueImports,
    eagerDynamicImport: collected.eagerDynamicImport,
    mentionsStreaming: /\bstreaming\b/.test(source),
    refs: [...positional.refs, ...mentions],
    literalRefs: positional.literal,
    root: readAppRoot(program, source),
    ejectedLayout: hasTrueConstExport(program, GENERATED_PAGES_LAYOUT_EXPORT),
  };
}

const IMPORTING_NODE_TYPES = new Set([
  "ExportAllDeclaration",
  "ExportNamedDeclaration",
  "ImportDeclaration",
  "ImportExpression",
]);

/** Every string the module holds, and where it imports from. */
function collectManifestStrings(program: StaticNode): {
  localImports: string[];
  valueImports: string[];
  eagerDynamicImport: boolean;
  strings: string[];
} {
  const strings: string[] = [];
  const localImports: string[] = [];
  const valueImports: string[] = [];
  // `() => import("./x")` written where a module ref goes (a call argument,
  // an object property value, an array element) is a lazy module ref. Any
  // other literal `import()`, including one behind a named helper the manifest
  // can call, hands the manifest values this reader never sees.
  const lazyImports = new WeakSet<object>();
  const markLazy = (candidate: unknown): void => {
    const arrow = asStaticNode(candidate);
    if (arrow?.type !== "ArrowFunctionExpression") return;
    const body = asStaticNode(arrow.body);
    if (body?.type === "ImportExpression") lazyImports.add(body);
  };
  let eagerDynamicImport = false;

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const node = asStaticNode(value);
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
    // contributes one — and a specifier that is not a literal is read as a
    // reason to distrust the whole read. `export const app = …` carries no
    // source at all and is not one of them.
    if (IMPORTING_NODE_TYPES.has(node.type) && node.source != null) {
      const specifier = asStaticNode(node.source);
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
 * The refs a manifest module writes in a position the runtime reads a module
 * from, each with the hydration its route states: the route's own literal
 * `hydration` or, without one, the innermost enclosing `group()`'s. A ref held
 * in a variable is not seen here; the build's registry check reports it if the
 * registry cannot serve it.
 *
 * `literal` is false when a route, `notFound` or shell ref position holds
 * something other than a literal (`"./routes/" + name + ".tsx"`, a variable, a
 * spread): the module it names cannot be known, so the refs are not all here.
 * Such a position is still listed, with a `null` ref.
 */
function collectPositionalRefs(program: StaticNode): { refs: WrittenRef[]; literal: boolean } {
  const refs: WrittenRef[] = [];
  let literal = true;
  const computed = (kind: ManifestRefKind, hydration: RefHydration, name?: string): void => {
    literal = false;
    refs.push({ kind, ref: null, hydration, ...(name === undefined ? {} : { name }) });
  };
  const push = (
    kind: ManifestRefKind,
    value: unknown,
    required: boolean,
    hydration: RefHydration = "unknown",
    name?: string,
  ): void => {
    const ref = staticRefValue(value);
    if (ref !== null) refs.push({ kind, ref, hydration, ...(name === undefined ? {} : { name }) });
    else if (required) computed(kind, hydration, name);
  };
  const readComponentConfig = (
    value: unknown,
    kind: ManifestRefKind,
    hydration: RefHydration,
  ): void => {
    if (staticRefValue(value) !== null) {
      push(kind, value, true, hydration);
      return;
    }
    if (hasOpaqueProperties(value)) {
      computed(kind, hydration);
      return;
    }
    let component = false;
    for (const property of staticObjectProperties(value)) {
      if (property.name === "component") {
        component = true;
        push(kind, property.value, true, hydration);
      }
      if (property.name === "loader") push("loader", property.value, false);
    }
    if (!component) computed(kind, hydration);
  };

  const walk = (value: unknown, inherited: RefHydration): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, inherited);
      return;
    }
    const node = asStaticNode(value);
    if (!node) return;

    if (node.type === "CallExpression") {
      const callee = calleeName(node.callee);
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      if (callee === "group") {
        const mode = metaHydration(args[0], inherited);
        walk(node.callee, inherited);
        walk(args[0], inherited);
        for (const arg of args.slice(1)) walk(arg, mode);
        return;
      }
      if (callee === "route") {
        if (args.some((arg) => asStaticNode(arg)?.type === "SpreadElement")) {
          computed("route", "unknown");
        } else {
          // `route(path, { component, …meta })` reads its options from the
          // config object and ignores a third argument.
          const config = unwrapStaticExpression(args[1]);
          const meta = config?.type === "ObjectExpression" ? args[1] : args[2];
          readComponentConfig(args[1], "route", metaHydration(meta, inherited));
        }
      }
    } else if (node.type === "ObjectExpression") {
      for (const property of staticObjectProperties(node)) {
        if (property.name === "shells") {
          if (hasOpaqueProperties(property.value)) literal = false;
          for (const shell of staticObjectProperties(property.value))
            push("shell", shell.value, true, "unknown", shell.name);
        } else if (property.name === "middleware" || property.name === "capabilities") {
          const kind = property.name === "middleware" ? "middleware" : "capability";
          for (const entry of staticObjectProperties(property.value))
            push(kind, entry.value, false, "unknown", entry.name);
        } else if (property.name === "notFound") {
          readComponentConfig(property.value, "not-found", "unknown");
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "type") continue;
      walk(node[key], inherited);
    }
  };

  walk(program.body, "full");
  return { refs, literal };
}

/**
 * The hydration a `route()`/`group()` meta argument gives, or `inherited` when
 * it sets none. Anything that cannot be read for certain — a meta held in a
 * variable, a spread, a computed key, a non-literal value — is `unknown`.
 */
function metaHydration(meta: unknown, inherited: RefHydration): RefHydration {
  if (meta === undefined) return inherited;
  const node = unwrapStaticExpression(meta);
  if (node?.type !== "ObjectExpression") return "unknown";
  let mode = inherited;
  for (const property of Array.isArray(node.properties) ? node.properties : []) {
    const name = staticPropertyName(property);
    if (name === null) return "unknown";
    if (name !== "hydration") continue;
    const value = staticStringValue(asStaticNode(property)!.value);
    mode = value === "full" || value === "islands" || value === "none" ? value : "unknown";
  }
  return mode;
}

/**
 * `defineApp({ root })` in the module that exports the app: `export default
 * defineApp(…)`, `export const app = defineApp(…)`, or a local exported as
 * `app`. Only a top-level `root` counts — `shells: { root }` is a shell name.
 */
function readAppRoot(
  program: StaticNode,
  source: string,
): { ref: string } | { error: string } | null {
  const app = findAppObject(program);
  if (!app) return null;
  const property = (Array.isArray(app.properties) ? app.properties : [])
    .map(asStaticNode)
    .find(
      (node) =>
        (node?.type === "Property" || node?.type === "ObjectProperty") &&
        node.computed !== true &&
        getStaticName(asStaticNode(node.key)) === "root",
    );
  if (!property) return null;
  const ref = staticRefValue(property.value);
  if (ref !== null) return { ref };
  // Shorthand (`defineApp({ root })`) names a variable the build cannot read.
  const value = asStaticNode(property.value)!;
  const written =
    property.shorthand === true ? "root" : source.slice(value.start as number, value.end as number);
  return {
    error:
      `[pracht] defineApp({ root }) must be a string path or a \`() => import("…")\` literal ` +
      `written inside defineApp({ … }) so the build can bundle the module; found \`${written}\`.`,
  };
}

function findAppObject(program: StaticNode): StaticNode | null {
  const statements = (Array.isArray(program.body) ? program.body : [])
    .map(asStaticNode)
    .filter((statement): statement is StaticNode => statement !== null);
  const defineAppObject = (value: unknown): StaticNode | null => {
    const call = unwrapStaticExpression(value);
    if (call?.type !== "CallExpression" || calleeName(call.callee) !== "defineApp") return null;
    const arg = unwrapStaticExpression(Array.isArray(call.arguments) ? call.arguments[0] : null);
    return arg?.type === "ObjectExpression" ? arg : null;
  };
  const declared = (name: string, exportedOnly: boolean): StaticNode | null => {
    for (const statement of statements) {
      const declaration =
        statement.type === "ExportNamedDeclaration"
          ? asStaticNode(statement.declaration)
          : exportedOnly
            ? null
            : statement;
      if (declaration?.type !== "VariableDeclaration") continue;
      for (const declarator of Array.isArray(declaration.declarations)
        ? declaration.declarations
        : []) {
        const node = asStaticNode(declarator);
        if (getStaticName(asStaticNode(node?.id)) !== name) continue;
        const object = defineAppObject(node?.init);
        if (object) return object;
      }
    }
    return null;
  };

  for (const statement of statements) {
    if (statement.type === "ExportDefaultDeclaration") {
      const object = defineAppObject(statement.declaration);
      if (object) return object;
    }
  }
  const exported = declared("app", true);
  if (exported) return exported;
  for (const statement of statements) {
    if (statement.type !== "ExportNamedDeclaration" || statement.source) continue;
    for (const specifier of Array.isArray(statement.specifiers) ? statement.specifiers : []) {
      const node = asStaticNode(specifier);
      if (getStaticName(asStaticNode(node?.exported)) !== "app") continue;
      const local = getStaticName(asStaticNode(node?.local));
      const object = local === null ? null : declared(local, false);
      if (object) return object;
    }
  }
  return null;
}

/** Whether the module exports `name` as a `const` bound to the literal `true`. */
function hasTrueConstExport(program: StaticNode, name: string): boolean {
  const statements = (Array.isArray(program.body) ? program.body : [])
    .map(asStaticNode)
    .filter((statement): statement is StaticNode => statement !== null);
  const trueConstBindings = new Set<string>();

  for (const statement of statements) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? asStaticNode(statement.declaration) : statement;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;

    const declarators = Array.isArray(declaration.declarations) ? declaration.declarations : [];
    for (const declaratorValue of declarators) {
      const declarator = asStaticNode(declaratorValue);
      if (declarator?.type !== "VariableDeclarator") continue;
      const identifier = asStaticNode(declarator.id);
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
    const declaration = asStaticNode(statement.declaration);
    if (declaration?.type === "VariableDeclaration") {
      const declarators = Array.isArray(declaration.declarations) ? declaration.declarations : [];
      if (
        declarators.some((declaratorValue) => {
          const declarator = asStaticNode(declaratorValue);
          const identifier = asStaticNode(declarator?.id);
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
      const specifier = asStaticNode(specifierValue);
      if (specifier?.type !== "ExportSpecifier" || specifier.exportKind === "type") continue;
      const localName = getStaticName(asStaticNode(specifier.local));
      if (
        localName !== null &&
        getStaticName(asStaticNode(specifier.exported)) === name &&
        trueConstBindings.has(localName)
      ) {
        return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Pages mode: the directory is the manifest.

function readPagesManifest(resolved: ResolvedPrachtPluginOptions, root: string): ManifestFacts {
  const pagesDir = resolve(root, resolved.pagesDir.replace(/^\//, ""));
  const facts: ManifestFacts = {
    refs: [],
    complete: false,
    appRoot: null,
    appRootError: null,
    ejectedLayout: false,
    mayStream: true,
    files: [],
    unresolvedImports: [],
    error: null,
  };
  try {
    const pages = scanPagesDirectory(pagesDir, resolved.additionalExtensions);
    facts.refs = pages.map((page) => ({
      kind: page.routePath === "/404" ? "not-found" : "route",
      ref: `${resolved.pagesDir}/${toPosixPath(page.relativePath)}`,
      id: fileModuleId(root, page.absolutePath),
      hydration:
        page.hydrationMode === undefined
          ? "full"
          : page.hydrationMode === "full" ||
              page.hydrationMode === "islands" ||
              page.hydrationMode === "none"
            ? page.hydrationMode
            : "unknown",
    }));
    facts.complete = true;
    facts.mayStream = pages.some((page) => page.streaming === true);
  } catch {
    // An invalid pages tree is reported by the generated manifest.
  }
  try {
    const rootFile = findPagesRootFile(pagesDir);
    if (rootFile) {
      facts.appRoot = {
        ref: `${resolved.pagesDir}/${toPosixPath(relative(pagesDir, rootFile))}`,
        id: fileModuleId(root, rootFile),
      };
    }
  } catch {
    // So is an ambiguous `_root`.
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Static AST helpers

type StaticNode = {
  type: string;
  [key: string]: unknown;
};

function asStaticNode(value: unknown): StaticNode | null {
  if (!value || typeof value !== "object" || !("type" in value)) return null;
  return typeof (value as { type?: unknown }).type === "string" ? (value as StaticNode) : null;
}

const TRANSPARENT_EXPRESSIONS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "TypeCastExpression",
]);

function unwrapStaticExpression(value: unknown): StaticNode | null {
  let node = asStaticNode(value);
  while (node && TRANSPARENT_EXPRESSIONS.has(node.type)) node = asStaticNode(node.expression);
  return node;
}

function getStaticName(value: StaticNode | null): string | null {
  if (value?.type === "Identifier" && typeof value.name === "string") return value.name;
  if (value?.type === "Literal" && typeof value.value === "string") return value.value;
  return null;
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
    const cooked = (asStaticNode(quasis[0])?.value as { cooked?: unknown } | undefined)?.cooked;
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
  const property = asStaticNode(value);
  if (property?.type !== "Property" && property?.type !== "ObjectProperty") return null;
  if (property.computed === true) return null;
  return getStaticName(asStaticNode(property.key));
}

function staticObjectProperties(value: unknown): Array<{ name: string; value: unknown }> {
  const node = unwrapStaticExpression(value);
  if (node?.type !== "ObjectExpression") return [];
  const properties = Array.isArray(node.properties) ? node.properties : [];
  const result: Array<{ name: string; value: unknown }> = [];
  for (const property of properties) {
    const name = staticPropertyName(property);
    if (name !== null) result.push({ name, value: asStaticNode(property)!.value });
  }
  return result;
}

function calleeName(value: unknown): string | null {
  const callee = unwrapStaticExpression(value);
  if (callee?.type === "Identifier" && typeof callee.name === "string") return callee.name;
  if (callee?.type === "MemberExpression" && callee.computed !== true)
    return getStaticName(asStaticNode(callee.property));
  return null;
}

/** Whether an object literal hides properties behind a spread or computed key. */
function hasOpaqueProperties(value: unknown): boolean {
  const node = unwrapStaticExpression(value);
  if (node?.type !== "ObjectExpression") return true;
  const properties = Array.isArray(node.properties) ? node.properties : [];
  return properties.some((property) => staticPropertyName(property) === null);
}
