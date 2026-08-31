import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Read-only analysis of a Next.js project, reported as a pracht migration plan.
 *
 * Nothing in this module writes to the analysed project. A migration is a
 * judgement call at almost every step — which render mode a page wants, whether
 * a client component should become an island, whether a parallel route can be
 * flattened — and a tool that rewrites source while guessing at those produces
 * a diff nobody can review. So this reads the app, proposes a manifest, and
 * says what it could not decide.
 */

export type MigrateSeverity = "blocker" | "review" | "note";

export interface MigrateFinding {
  severity: MigrateSeverity;
  /** Stable identifier so a report can be diffed between runs. */
  code: string;
  /** Project-relative path. */
  file: string;
  line?: number;
  message: string;
  guidance: string;
}

export type MigrateRenderMode = "ssg" | "ssr" | "isg";

export interface MigrateRoute {
  file: string;
  /** Suggested filename stem under `src/routes/`, derived from the Next segments. */
  module: string;
  /** The pracht route path, or `null` when the Next segment has no equivalent. */
  path: string | null;
  render: MigrateRenderMode;
  /** Seconds, when `render` is `"isg"`. */
  revalidate?: number;
  /** Why this render mode was chosen, quoted back to the reader. */
  reason: string;
  /** Named shell this route would use, derived from the nearest layout. */
  shell: string | null;
}

export interface MigrateApiRoute {
  file: string;
  path: string;
  methods: string[];
}

export interface MigrateShell {
  name: string;
  file: string;
  /** URL prefix the layout covers, for the reader's orientation. */
  segment: string;
}

export interface MigrateReport {
  root: string;
  source: {
    framework: "next" | null;
    version: string | null;
    router: "app" | "pages" | "mixed" | null;
    appDir: string | null;
    pagesDir: string | null;
  };
  routes: MigrateRoute[];
  apiRoutes: MigrateApiRoute[];
  shells: MigrateShell[];
  findings: MigrateFinding[];
  /** Proposed `src/routes.ts`, printed for the reader — never written. */
  manifest: string;
  /** False when at least one blocker was found. */
  ok: boolean;
}

const PAGE_FILES = new Set(["page.tsx", "page.ts", "page.jsx", "page.js"]);
const LAYOUT_FILES = new Set(["layout.tsx", "layout.ts", "layout.jsx", "layout.js"]);
const ROUTE_FILES = new Set(["route.tsx", "route.ts", "route.jsx", "route.js"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".next", ".git", "dist", "build"]);
const SOURCE_EXTENSIONS = /\.(tsx|ts|jsx|js|mjs|cjs)$/;
/** Files Next requires to be client components, so the directive is not a choice. */
const DIRECTIVE_REQUIRED_FILES = new Set(["error", "global-error"]);

const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/**
 * Next imports whose pracht replacement is mechanical enough to name, and
 * important enough that missing one leaves a broken app.
 */
const IMPORT_REPLACEMENTS: { specifier: string; message: string; guidance: string }[] = [
  {
    specifier: "next/image",
    message: "Uses next/image.",
    guidance:
      "@pracht/image ships a CLS-safe <Image> with the same responsibilities. See /docs/images.",
  },
  {
    specifier: "next/link",
    message: "Uses next/link.",
    guidance: "Import <Link> from @pracht/core; the prefetch prop is per-link or per-route.",
  },
  {
    specifier: "next/font",
    message: "Uses next/font.",
    guidance: "Declare fonts from a route or shell head() export. See /docs/fonts.",
  },
  {
    specifier: "next/navigation",
    message: "Uses next/navigation.",
    guidance:
      "useNavigate(), useLocation(), and useParams() come from @pracht/core. Server-side redirect() becomes a Response from a loader or middleware.",
  },
  {
    specifier: "next/headers",
    message: "Reads request headers or cookies via next/headers.",
    guidance:
      'Loaders and middleware receive the Request directly: `loader({ request })`. This route almost certainly wants render: "ssr".',
  },
  {
    specifier: "next/server",
    message: "Uses next/server (NextRequest / NextResponse).",
    guidance: "pracht API routes take a Request and return a native Response.",
  },
  {
    specifier: "next/cache",
    message: "Uses next/cache (revalidatePath / revalidateTag).",
    guidance:
      "ISG revalidation is declared per route (timeRevalidate) or triggered through the authenticated /__pracht/revalidate webhook. See /docs/rendering.",
  },
];

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === "\n") line += 1;
  }
  return line;
}

/** Directives are only directives at the top of a module, before any statement. */
function hasDirective(source: string, directive: string): boolean {
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) {
      continue;
    }
    if (line === `"${directive}";` || line === `'${directive}';`) return true;
    if (line === `"${directive}"` || line === `'${directive}'`) return true;
    return false;
  }
  return false;
}

function importSpecifiers(source: string): { specifier: string; index: number }[] {
  const found: { specifier: string; index: number }[] = [];
  const pattern = /(?:from|import|require\()\s*["']([^"']+)["']/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    found.push({ specifier: match[1], index: match.index });
  }
  return found;
}

/**
 * `app/(marketing)/blog/[slug]` → `/blog/:slug`.
 *
 * Returns `null` for a segment shape pracht has no equivalent for, so the
 * caller reports it rather than emitting a route that silently means something
 * else.
 */
export function convertRouteSegments(
  segments: string[],
): { path: string; unsupported: null } | { path: null; unsupported: string } {
  const parts: string[] = [];

  for (const [index, segment] of segments.entries()) {
    // Intercepting markers wrap only the marker, not the segment: `(.)photo`.
    if (/^\(\.{1,3}\)/.test(segment)) return { path: null, unsupported: segment };
    // Route groups organise files without appearing in the URL.
    if (segment.startsWith("(") && segment.endsWith(")")) continue;
    // Private folders are excluded from routing by Next.
    if (segment.startsWith("_")) continue;
    if (segment.startsWith("@")) return { path: null, unsupported: segment };

    if (segment.startsWith("[[") && segment.endsWith("]]")) {
      return { path: null, unsupported: segment };
    }

    if (segment.startsWith("[...") && segment.endsWith("]")) {
      // A catch-all only means "the rest of the path" in final position.
      if (index !== segments.length - 1) return { path: null, unsupported: segment };
      parts.push("*");
      continue;
    }

    if (segment.startsWith("[") && segment.endsWith("]")) {
      parts.push(`:${segment.slice(1, -1)}`);
      continue;
    }

    parts.push(segment);
  }

  return { path: parts.length === 0 ? "/" : `/${parts.join("/")}`, unsupported: null };
}

interface RenderInference {
  render: MigrateRenderMode;
  revalidate?: number;
  reason: string;
}

/**
 * Next expresses rendering through a mix of segment config, dynamic API use,
 * and defaults. Pracht wants one declared mode per route, so this reads the
 * signals in the order Next resolves them and explains the answer.
 */
export function inferRenderMode(source: string): RenderInference {
  if (/export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/.test(source)) {
    return { render: "ssr", reason: 'export const dynamic = "force-dynamic"' };
  }
  if (/export\s+const\s+dynamic\s*=\s*["']force-static["']/.test(source)) {
    return { render: "ssg", reason: 'export const dynamic = "force-static"' };
  }

  const revalidate = /export\s+const\s+revalidate\s*=\s*(\d+)/.exec(source);
  if (revalidate) {
    const seconds = Number.parseInt(revalidate[1], 10);
    // `revalidate = 0` is Next's way of opting out of caching entirely.
    if (seconds === 0) return { render: "ssr", reason: "export const revalidate = 0" };
    return {
      render: "isg",
      revalidate: seconds,
      reason: `export const revalidate = ${seconds}`,
    };
  }

  if (/from\s+["']next\/headers["']/.test(source)) {
    return { render: "ssr", reason: "reads cookies or headers at request time" };
  }
  if (/\bsearchParams\b/.test(source)) {
    return { render: "ssr", reason: "reads searchParams" };
  }
  if (/export\s+(?:async\s+)?function\s+generateStaticParams/.test(source)) {
    return { render: "ssg", reason: "generateStaticParams enumerates paths at build time" };
  }

  return { render: "ssg", reason: "no request-time data detected" };
}

function detectMethods(source: string): string[] {
  return HTTP_METHODS.filter((method) =>
    new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b`).test(source),
  );
}

function walk(dir: string, onFile: (path: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, onFile);
    else onFile(path);
  }
}

/** `app/(marketing)/blog/[slug]/page.tsx` → `["(marketing)", "blog", "[slug]"]`. */
function segmentsOf(appDir: string, file: string): string[] {
  return relative(appDir, file).split(sep).slice(0, -1);
}

/** `["blog", "[slug]"]` → `blog-slug`; `["docs", "[...path]"]` → `docs-path`. */
export function moduleNameFor(segments: string[]): string {
  const named = segments
    .filter(
      (segment) =>
        !segment.startsWith("_") &&
        !segment.startsWith("@") &&
        !(segment.startsWith("(") && segment.endsWith(")")),
    )
    .map((segment) => segment.replace(/^\[+\.*|\]+$/g, ""))
    .filter(Boolean);
  return named.length === 0 ? "home" : named.join("-").replace(/[^a-zA-Z0-9-]/g, "-");
}

function shellNameFor(segments: string[]): string {
  const named = segments
    .filter((segment) => !segment.startsWith("_") && !segment.startsWith("@"))
    .map((segment) =>
      segment.startsWith("(") && segment.endsWith(")") ? segment.slice(1, -1) : segment,
    )
    .filter(Boolean);
  if (named.length === 0) return "root";
  return named
    .join("-")
    .replace(/[[\].]/g, "")
    .replace(/[^a-zA-Z0-9-]/g, "-");
}

function findDirectory(root: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const path = join(root, candidate);
    if (existsSync(path) && statSync(path).isDirectory()) return path;
  }
  return null;
}

function scanFileFindings(
  root: string,
  file: string,
  source: string,
  findings: MigrateFinding[],
): void {
  const relativeFile = relative(root, file);

  for (const replacement of IMPORT_REPLACEMENTS) {
    const hit = importSpecifiers(source).find(
      (entry) =>
        entry.specifier === replacement.specifier ||
        entry.specifier.startsWith(`${replacement.specifier}/`),
    );
    if (!hit) continue;
    findings.push({
      severity: "review",
      code: replacement.specifier.replace("/", "-"),
      file: relativeFile,
      line: lineOf(source, hit.index),
      message: replacement.message,
      guidance: replacement.guidance,
    });
  }

  if (hasDirective(source, "use server")) {
    findings.push({
      severity: "blocker",
      code: "server-actions",
      file: relativeFile,
      line: 1,
      message: "Declares Server Actions.",
      guidance:
        "pracht has no Server Actions. Expose the operation as an API route (or a capability) and post to it with <Form>, which progressively enhances without JavaScript.",
    });
  }

  const stem = (file.split(sep).at(-1) ?? "").replace(/\.(tsx|ts|jsx|js)$/, "");
  const directiveIsMandatory = DIRECTIVE_REQUIRED_FILES.has(stem);
  if (!directiveIsMandatory && hasDirective(source, "use client")) {
    findings.push({
      severity: "note",
      code: "use-client",
      file: relativeFile,
      line: 1,
      message: 'Marked "use client".',
      guidance:
        'pracht has no directive: a route hydrates fully by default. If the page is mostly static, move the interactive parts to src/islands/ and set hydration: "islands" on the route.',
    });
  }

  const asyncComponent =
    /export\s+default\s+async\s+function/.exec(source) ??
    /export\s+async\s+function\s+(?:Page|Layout)\b/.exec(source);
  if (asyncComponent) {
    findings.push({
      severity: "review",
      code: "async-component",
      file: relativeFile,
      line: lineOf(source, asyncComponent.index),
      message: "Async Server Component fetches data inside the component.",
      guidance:
        "Move the await into an exported `loader(args)`. Its return type flows into the component as `props.data` with no manual typing.",
    });
  }
}

function scanSpecialFiles(root: string, appDir: string, findings: MigrateFinding[]): void {
  const specials: Record<string, { severity: MigrateSeverity; code: string; guidance: string }> = {
    error: {
      severity: "note",
      code: "error-boundary",
      guidance: "Export ErrorBoundary from the route module, or from a shell to cover a group.",
    },
    loading: {
      severity: "note",
      code: "loading-state",
      guidance:
        "Export Loading from the route. It renders while an SPA route loads; SSR and SSG routes send finished HTML, so most loading.tsx files have nothing to become.",
    },
    "not-found": {
      severity: "note",
      code: "not-found",
      guidance:
        "One notFound entry on defineApp() replaces every not-found.tsx. It sits outside the route table, so it cannot shadow a static asset the way a catch-all route would.",
    },
    template: {
      severity: "review",
      code: "template",
      guidance:
        "pracht has no per-navigation remount wrapper. If the template exists for enter animations, View Transitions cover most of the cases; otherwise fold it into the shell.",
    },
    default: {
      severity: "blocker",
      code: "parallel-route-default",
      guidance:
        "default.tsx only exists to serve parallel routes, which pracht does not have. Render the slots as components of one route.",
    },
  };

  walk(appDir, (file) => {
    const name = file.split(sep).at(-1) ?? "";
    const stem = name.replace(/\.(tsx|ts|jsx|js)$/, "");
    const special = specials[stem];
    if (!special || stem === name) return;
    findings.push({
      severity: special.severity,
      code: special.code,
      file: relative(root, file),
      message: `${name} has no direct pracht equivalent.`,
      guidance: special.guidance,
    });
  });
}

function renderManifest(
  routes: MigrateRoute[],
  shells: MigrateShell[],
  apiRoutes: MigrateApiRoute[],
): string {
  const usable = routes.filter((route) => route.path !== null);
  const usedShells = new Set(usable.map((route) => route.shell).filter(Boolean));
  const needsRevalidate = usable.some((route) => route.render === "isg");

  const imports = ["defineApp", ...(needsRevalidate ? ["timeRevalidate"] : []), "route"].sort();

  const lines: string[] = [
    "// Proposed by `pracht migrate`. Nothing was written — copy what fits.",
    "//",
    "// Route module paths point at where each page will live after you move it,",
    "// not at its current Next.js location.",
    `import { ${imports.join(", ")} } from "@pracht/core";`,
    "",
    "export const app = defineApp({",
  ];

  if (usedShells.size > 0) {
    lines.push("  shells: {");
    for (const shell of shells) {
      if (!usedShells.has(shell.name)) continue;
      lines.push(`    ${shell.name}: () => import("./shells/${shell.name}.tsx"),`);
    }
    lines.push("  },");
  }

  lines.push("  routes: [");
  for (const route of usable) {
    const options: string[] = [`render: "${route.render}"`];
    if (route.render === "isg" && route.revalidate != null) {
      options.push(`revalidate: timeRevalidate(${route.revalidate})`);
    }
    if (route.shell) options.push(`shell: "${route.shell}"`);
    lines.push(
      `    route(${JSON.stringify(route.path)}, () => import("./routes/${route.module}.tsx"), { ${options.join(", ")} }),`,
    );
  }
  lines.push("  ],");
  lines.push("});");

  if (apiRoutes.length > 0) {
    lines.push("");
    lines.push("// API routes are discovered from src/api/ and need no manifest entry:");
    for (const api of apiRoutes) {
      lines.push(`//   ${api.path}  ${api.methods.join(", ") || "(no method exports found)"}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function analyzeMigration(root: string): MigrateReport {
  const findings: MigrateFinding[] = [];
  const packageJsonPath = join(root, "package.json");
  let packageJson: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {};
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    // Reported below as a missing framework.
  }
  const allDependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const nextVersion = allDependencies.next ?? null;

  const appDir = findDirectory(root, ["app", join("src", "app")]);
  const pagesDir = findDirectory(root, ["pages", join("src", "pages")]);

  const report: MigrateReport = {
    root,
    source: {
      framework: nextVersion ? "next" : null,
      version: nextVersion,
      router: appDir && pagesDir ? "mixed" : appDir ? "app" : pagesDir ? "pages" : null,
      appDir: appDir ? relative(root, appDir) : null,
      pagesDir: pagesDir ? relative(root, pagesDir) : null,
    },
    routes: [],
    apiRoutes: [],
    shells: [],
    findings,
    manifest: "",
    ok: true,
  };

  if (allDependencies.react || allDependencies["react-dom"]) {
    findings.push({
      severity: "review",
      code: "react-dependency",
      file: "package.json",
      message: "Depends on react and react-dom.",
      guidance:
        "Swap them for preact. Components and hooks import from preact / preact/hooks; a dependency that insists on React resolves through a preact/compat alias in vite.config.ts, which costs about 1.4 KB gzip. See /docs/migrate/nextjs.",
    });
  }

  const nextConfigFile = ["next.config.ts", "next.config.js", "next.config.mjs"].find((candidate) =>
    existsSync(join(root, candidate)),
  );
  if (nextConfigFile) {
    const config = readFile(join(root, nextConfigFile));
    // `images: {}` is a property; `async redirects() {}` is a method. Both are
    // idiomatic in next.config, so match either shape.
    const configured = ["rewrites", "redirects", "headers", "images", "i18n"].filter((key) =>
      new RegExp(`\\b${key}\\s*[:(]`).test(config),
    );
    if (configured.length > 0) {
      findings.push({
        severity: "review",
        code: "next-config",
        file: nextConfigFile,
        message: `Configures ${configured.join(", ")}.`,
        guidance:
          "pracht has no equivalent config block. Rewrites and redirects become middleware, headers become a route or shell headers() export, images are configured on @pracht/image, and locales are handled by @pracht/i18n.",
      });
    }
  }

  if (!nextVersion) {
    findings.push({
      severity: "blocker",
      code: "not-next",
      file: "package.json",
      message: "No `next` dependency found.",
      guidance:
        "This prototype reads Next.js projects. Run it from the root of the app you want to migrate.",
    });
  }

  if (report.source.router === "pages") {
    findings.push({
      severity: "review",
      code: "pages-router",
      file: report.source.pagesDir ?? "pages",
      message: "Pages Router detected; this prototype analyses the App Router.",
      guidance:
        "pracht's own pages router is the closer match for a Pages Router app — file-based routing with RENDER_MODE exports and no manifest. See /docs/routing.",
    });
  } else if (report.source.router === "mixed") {
    findings.push({
      severity: "review",
      code: "mixed-routers",
      file: report.source.appDir ?? "app",
      message: "Both app/ and pages/ exist; only app/ was analysed.",
      guidance:
        "Migrate the two halves separately, or finish the App Router migration in Next first.",
    });
  }

  const middlewareFile = ["middleware.ts", "middleware.js", join("src", "middleware.ts")].find(
    (candidate) => existsSync(join(root, candidate)),
  );
  if (middlewareFile) {
    findings.push({
      severity: "review",
      code: "root-middleware",
      file: middlewareFile,
      message: "One root middleware with a matcher config.",
      guidance:
        "pracht middleware is named in src/middleware/ and attached per route or per group, so the matcher becomes the manifest. See /docs/middleware.",
    });
  }

  if (!appDir) {
    report.manifest = renderManifest([], [], []);
    report.ok = !findings.some((finding) => finding.severity === "blocker");
    return report;
  }

  const layouts: MigrateShell[] = [];
  const pageFiles: string[] = [];
  const routeFiles: string[] = [];
  const sourceFiles: string[] = [];

  walk(appDir, (file) => {
    const name = file.split(sep).at(-1) ?? "";
    if (SOURCE_EXTENSIONS.test(name)) sourceFiles.push(file);
    if (PAGE_FILES.has(name)) pageFiles.push(file);
    else if (LAYOUT_FILES.has(name)) layouts.push({ name: "", file, segment: "" });
    else if (ROUTE_FILES.has(name)) routeFiles.push(file);
  });

  // Every module under app/ is scanned, not only the routable ones: a Server
  // Action or a next/image import in a shared component is exactly the kind of
  // thing a migration needs told about.
  for (const file of sourceFiles.sort()) {
    scanFileFindings(root, file, readFile(file), findings);
  }

  for (const layout of layouts) {
    const segments = segmentsOf(appDir, layout.file);
    layout.name = shellNameFor(segments);
    const converted = convertRouteSegments(segments);
    layout.segment = converted.path ?? segments.join("/");

    // Reported once per nested layout rather than once per page beneath it:
    // it is one composition decision, and a large app would otherwise bury
    // every other finding under it.
    const parents = layouts.filter(
      (other) =>
        other !== layout &&
        segmentsOf(appDir, other.file).length < segments.length &&
        segmentsOf(appDir, other.file).every((segment, index) => segments[index] === segment),
    );
    if (parents.length > 0) {
      findings.push({
        severity: "review",
        code: "nested-layouts",
        file: relative(root, layout.file),
        message: `Nested inside ${parents.length === 1 ? "another layout" : `${parents.length} outer layouts`}.`,
        guidance:
          "pracht shells do not nest — a route gets exactly one. Fold the outer chrome into this shell, or render this layout's markup from the routes that need it.",
      });
    }
  }
  report.shells = layouts
    .map((layout) => ({ ...layout, file: relative(root, layout.file) }))
    .sort((left, right) => left.name.localeCompare(right.name));

  // An arrow rather than a declaration: a hoisted function could be called
  // before the `appDir` guard above, so TypeScript will not carry that
  // narrowing into it.
  /** The nearest layout at or above a page's directory, which becomes its shell. */
  const shellFor = (pageSegments: string[]): string | null => {
    let best: { depth: number; name: string } | null = null;
    for (const layout of layouts) {
      const layoutSegments = segmentsOf(appDir, layout.file);
      const covers = layoutSegments.every((segment, index) => pageSegments[index] === segment);
      if (!covers) continue;
      if (!best || layoutSegments.length > best.depth) {
        best = { depth: layoutSegments.length, name: layout.name };
      }
    }
    return best?.name ?? null;
  };

  for (const file of pageFiles.sort()) {
    const source = readFile(file);
    const segments = segmentsOf(appDir, file);
    const converted = convertRouteSegments(segments);
    const inference = inferRenderMode(source);

    if (converted.path === null) {
      findings.push({
        severity: "blocker",
        code: "unsupported-segment",
        file: relative(root, file),
        message: `Route segment ${JSON.stringify(converted.unsupported)} has no pracht equivalent.`,
        guidance: describeUnsupportedSegment(converted.unsupported),
      });
    }

    const shell = shellFor(segments);

    report.routes.push({
      file: relative(root, file),
      module: moduleNameFor(segments),
      path: converted.path,
      render: inference.render,
      revalidate: inference.revalidate,
      reason: inference.reason,
      shell,
    });
  }

  for (const file of routeFiles.sort()) {
    const source = readFile(file);
    const segments = segmentsOf(appDir, file);
    const converted = convertRouteSegments(segments);
    report.apiRoutes.push({
      file: relative(root, file),
      path: converted.path ?? segments.join("/"),
      methods: detectMethods(source),
    });
  }

  scanSpecialFiles(root, appDir, findings);

  report.routes.sort((left, right) => {
    if ((left.path === null) !== (right.path === null)) return left.path === null ? 1 : -1;
    if (left.path === "/") return -1;
    if (right.path === "/") return 1;
    return (left.path ?? left.file).localeCompare(right.path ?? right.file);
  });

  report.manifest = renderManifest(report.routes, report.shells, report.apiRoutes);
  report.ok = !findings.some((finding) => finding.severity === "blocker");
  return report;
}

function describeUnsupportedSegment(segment: string): string {
  if (segment.startsWith("@")) {
    return "Parallel routes have no pracht equivalent. Render the slots as ordinary components of one route, fetching their data in that route's loader.";
  }
  if (/^\(\.{1,3}\)/.test(segment)) {
    return "Intercepting routes have no pracht equivalent. Serve the intercepted view as its own route and open it in a dialog from the client.";
  }
  if (segment.startsWith("[[")) {
    return "Optional catch-all matches both the bare path and its descendants. Declare two routes: the exact path, and a trailing `/*` catch-all.";
  }
  if (segment.startsWith("[...")) {
    return 'A catch-all only means "the rest of the path" in final position. Move it to the end of the route, or split the route in two.';
  }
  return "No pracht equivalent for this segment shape.";
}

const SEVERITY_ORDER: Record<MigrateSeverity, number> = { blocker: 0, review: 1, note: 2 };

export function formatMigrateReport(report: MigrateReport): string {
  const lines: string[] = [];

  lines.push("pracht migrate — analysis only, no files were changed.");
  lines.push("");

  if (report.source.framework) {
    lines.push(
      `Detected  Next.js ${report.source.version} (${report.source.router ?? "unknown"} router) in ${report.source.appDir ?? report.source.pagesDir ?? "."}`,
    );
  } else {
    lines.push("Detected  no Next.js project here.");
  }

  if (report.routes.length > 0) {
    lines.push("");
    lines.push(`Routes (${report.routes.length})`);
    const pathWidth = Math.max(
      ...report.routes.map((route) => (route.path ?? "(unsupported)").length),
      4,
    );
    const modeWidth = 4;
    lines.push(
      `  ${"PATH".padEnd(pathWidth)}  ${"MODE".padEnd(modeWidth)}  ${"SHELL".padEnd(12)}  WHY`,
    );
    for (const route of report.routes) {
      const path = route.path ?? "(unsupported)";
      const mode = route.path === null ? "-" : route.render;
      const why = route.path === null ? `see findings for ${route.file}` : route.reason;
      lines.push(
        `  ${path.padEnd(pathWidth)}  ${mode.padEnd(modeWidth)}  ${(route.shell ?? "-").padEnd(12)}  ${why}`,
      );
    }
  }

  if (report.apiRoutes.length > 0) {
    lines.push("");
    lines.push(`API routes (${report.apiRoutes.length}) — these move to src/api/`);
    for (const api of report.apiRoutes) {
      lines.push(`  ${api.path}  ${api.methods.join(", ") || "(no method exports found)"}`);
    }
  }

  const sorted = [...report.findings].sort(
    (left, right) =>
      SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
      left.file.localeCompare(right.file),
  );

  if (sorted.length > 0) {
    lines.push("");
    const counts = sorted.reduce<Record<string, number>>((totals, finding) => {
      totals[finding.severity] = (totals[finding.severity] ?? 0) + 1;
      return totals;
    }, {});
    lines.push(
      `Findings (${["blocker", "review", "note"]
        .filter((severity) => counts[severity])
        .map((severity) => `${counts[severity]} ${severity}`)
        .join(", ")})`,
    );
    for (const finding of sorted) {
      const where = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      lines.push("");
      lines.push(`  ${finding.severity.toUpperCase()}  ${where}`);
      lines.push(`    ${finding.message}`);
      lines.push(`    → ${finding.guidance}`);
    }
  }

  lines.push("");
  lines.push("Proposed src/routes.ts");
  lines.push("");
  for (const line of report.manifest.trimEnd().split("\n")) lines.push(`  ${line}`);

  lines.push("");
  lines.push(
    report.ok
      ? "No blockers. Every finding above is a judgement call, which is why nothing was written."
      : "Blockers found — these have no mechanical translation and need a decision before you start.",
  );

  return lines.join("\n");
}
