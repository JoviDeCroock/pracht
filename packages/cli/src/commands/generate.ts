import { readFileSync, writeFileSync } from "node:fs";

import { defineCommand } from "citty";

import {
  ensureTrailingNewline,
  parseApiMethods,
  parseCommaList,
  quote,
  requireEnum,
  requirePositiveInteger,
} from "../utils.js";
import {
  extractRegistryEntries,
  insertArrayItem,
  toManifestModulePath,
  upsertObjectEntry,
  ensureCoreNamedImport,
} from "../manifest.js";
import {
  assertFileExists,
  displayPath,
  readProjectConfig,
  resolveApiModulePath,
  resolvePagesRouteModulePath,
  resolveProjectPath,
  resolveRouteModulePath,
  resolveScopedFile,
  writeGeneratedFile,
  type ProjectConfig,
} from "../project.js";

interface GenerateResult {
  created: string[];
  kind: string;
  updated: string[];
}

const routeCommand = defineCommand({
  meta: {
    name: "route",
    description: "Scaffold a route module",
  },
  args: {
    path: { type: "string", required: true, description: "Route path (e.g. /dashboard)" },
    render: { type: "string", description: "Render mode: ssr, spa, ssg, or isg" },
    shell: { type: "string", description: "Shell name" },
    middleware: { type: "string", description: "Middleware names (comma-separated)" },
    loader: { type: "boolean", description: "Include loader" },
    "error-boundary": { type: "boolean", description: "Include error boundary" },
    "static-paths": { type: "boolean", description: "Include static paths" },
    title: { type: "string", description: "Page title" },
    revalidate: { type: "string", description: "ISG revalidation seconds" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  async run({ args }) {
    const project = readProjectConfig(process.cwd());
    const result = generateRoute(args, project);
    outputResult(result, Boolean(args.json));
  },
});

const shellCommand = defineCommand({
  meta: {
    name: "shell",
    description: "Scaffold a shell component",
  },
  args: {
    name: { type: "string", required: true, description: "Shell name" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  async run({ args }) {
    const project = readProjectConfig(process.cwd());
    const result = generateShell(args.name, project);
    outputResult(result, Boolean(args.json));
  },
});

const middlewareCommand = defineCommand({
  meta: {
    name: "middleware",
    description: "Scaffold a middleware function",
  },
  args: {
    name: { type: "string", required: true, description: "Middleware name" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  async run({ args }) {
    const project = readProjectConfig(process.cwd());
    const result = generateMiddleware(args.name, project);
    outputResult(result, Boolean(args.json));
  },
});

const apiCommand = defineCommand({
  meta: {
    name: "api",
    description: "Scaffold an API route",
  },
  args: {
    path: { type: "string", required: true, description: "API endpoint path" },
    methods: { type: "string", description: "HTTP methods (comma-separated, e.g. GET,POST)" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  async run({ args }) {
    const project = readProjectConfig(process.cwd());
    const result = generateApi(args, project);
    outputResult(result, Boolean(args.json));
  },
});

export default defineCommand({
  meta: {
    name: "generate",
    description: "Scaffold framework files",
  },
  subCommands: {
    route: routeCommand,
    shell: shellCommand,
    middleware: middlewareCommand,
    api: apiCommand,
  },
});

function outputResult(result: GenerateResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }

  console.log(`Created ${result.kind}:`);
  for (const file of result.created) {
    console.log(`  ${file}`);
  }
  for (const file of result.updated) {
    console.log(`  updated ${file}`);
  }
}

interface RouteArgs {
  "error-boundary"?: boolean;
  loader?: boolean;
  middleware?: string;
  path: string;
  render?: string;
  revalidate?: string;
  shell?: string;
  "static-paths"?: boolean;
  title?: string;
}

function generateRoute(args: RouteArgs, project: ProjectConfig): GenerateResult {
  const routePath = normalizeRoutePathString(args.path);
  const render = requireEnum(args.render, "render", ["spa", "ssr", "ssg", "isg"], "ssr");
  const includeLoader = Boolean(args.loader);
  const includeErrorBoundary = Boolean(args["error-boundary"]);
  const middleware = parseCommaList(args.middleware);
  const includeStaticPaths =
    Boolean(args["static-paths"]) ||
    (hasDynamicSegments(routePath) && (render === "ssg" || render === "isg"));
  const title = args.title ?? titleFromPath(routePath);

  if (project.mode === "pages") {
    if (args.shell) {
      throw new Error("`pracht generate route --shell` is only available for manifest apps.");
    }
    if (middleware.length > 0) {
      throw new Error("`pracht generate route --middleware` is only available for manifest apps.");
    }
    return generatePagesRoute({
      includeErrorBoundary,
      includeLoader,
      includeStaticPaths,
      project,
      render,
      routePath,
      title,
    });
  }

  const manifestPath = resolveProjectPath(project.root, project.appFile);
  assertFileExists(manifestPath, `App manifest not found at ${project.appFile}.`);

  const manifestSource = readFileSync(manifestPath, "utf-8");
  const registeredShells = new Set(
    extractRegistryEntries(manifestSource, "shells").map((entry) => entry.name),
  );
  const registeredMiddleware = new Set(
    extractRegistryEntries(manifestSource, "middleware").map((entry) => entry.name),
  );

  const shellName = args.shell;
  if (shellName && !registeredShells.has(shellName)) {
    throw new Error(`Shell "${shellName}" is not registered in ${project.appFile}.`);
  }

  for (const name of middleware) {
    if (!registeredMiddleware.has(name)) {
      throw new Error(`Middleware "${name}" is not registered in ${project.appFile}.`);
    }
  }

  const routeFile = resolveRouteModulePath(project, routePath, ".tsx");
  writeGeneratedFile(
    routeFile.absolutePath,
    buildManifestRouteModuleSource({
      includeErrorBoundary,
      includeLoader,
      includeStaticPaths,
      routePath,
      title,
    }),
  );

  let nextManifestSource = ensureCoreNamedImport(manifestSource, "route");
  if (render === "isg") {
    nextManifestSource = ensureCoreNamedImport(nextManifestSource, "timeRevalidate");
  }

  const routeModulePath = toManifestModulePath(manifestPath, routeFile.absolutePath);
  const routeId = routeIdFromPath(routePath);
  const meta = [`id: ${quote(routeId)}`, `render: ${quote(render)}`];

  if (shellName) {
    meta.push(`shell: ${quote(shellName)}`);
  }
  if (middleware.length > 0) {
    meta.push(`middleware: [${middleware.map((item) => quote(item)).join(", ")}]`);
  }
  if (render === "isg") {
    const seconds = requirePositiveInteger(args.revalidate, "revalidate", 3600);
    meta.push(`revalidate: timeRevalidate(${seconds})`);
  }

  nextManifestSource = insertArrayItem(
    nextManifestSource,
    "routes",
    [
      `route(${quote(routePath)}, ${quote(routeModulePath)}, {`,
      ...meta.map((line) => `  ${line},`),
      "})",
    ].join("\n"),
  );
  writeFileSync(manifestPath, ensureTrailingNewline(nextManifestSource), "utf-8");

  return {
    created: [displayPath(project.root, routeFile.absolutePath)],
    kind: "route",
    updated: [displayPath(project.root, manifestPath)],
  };
}

function generatePagesRoute({
  includeErrorBoundary,
  includeLoader,
  includeStaticPaths,
  project,
  render,
  routePath,
  title,
}: {
  includeErrorBoundary: boolean;
  includeLoader: boolean;
  includeStaticPaths: boolean;
  project: ProjectConfig;
  render: string;
  routePath: string;
  title: string;
}): GenerateResult {
  const routeFile = resolvePagesRouteModulePath(project, routePath, ".tsx");
  writeGeneratedFile(
    routeFile.absolutePath,
    buildPagesRouteModuleSource({
      includeErrorBoundary,
      includeLoader,
      includeStaticPaths,
      render,
      routePath,
      title,
    }),
  );

  return {
    created: [displayPath(project.root, routeFile.absolutePath)],
    kind: "route",
    updated: [],
  };
}

function generateShell(name: string, project: ProjectConfig): GenerateResult {
  if (project.mode === "pages") {
    throw new Error(
      "Pages router apps use a single `_app` shell. `pracht generate shell` is only available for manifest apps.",
    );
  }

  const manifestPath = resolveProjectPath(project.root, project.appFile);
  assertFileExists(manifestPath, `App manifest not found at ${project.appFile}.`);

  const shellFile = resolveScopedFile(project.root, project.shellsDir, `${name}.tsx`);
  writeGeneratedFile(shellFile, buildShellModuleSource(name));

  const manifestSource = readFileSync(manifestPath, "utf-8");
  const updatedSource = upsertObjectEntry(
    manifestSource,
    "shells",
    `${name}: ${quote(toManifestModulePath(manifestPath, shellFile))}`,
  );
  writeFileSync(manifestPath, ensureTrailingNewline(updatedSource), "utf-8");

  return {
    created: [displayPath(project.root, shellFile)],
    kind: "shell",
    updated: [displayPath(project.root, manifestPath)],
  };
}

function generateMiddleware(name: string, project: ProjectConfig): GenerateResult {
  if (project.mode === "pages") {
    throw new Error(
      "Pages router apps do not use manifest middleware registration. `pracht generate middleware` is only available for manifest apps.",
    );
  }

  const manifestPath = resolveProjectPath(project.root, project.appFile);
  assertFileExists(manifestPath, `App manifest not found at ${project.appFile}.`);

  const middlewareFile = resolveScopedFile(project.root, project.middlewareDir, `${name}.ts`);
  writeGeneratedFile(middlewareFile, buildMiddlewareModuleSource());

  const manifestSource = readFileSync(manifestPath, "utf-8");
  const updatedSource = upsertObjectEntry(
    manifestSource,
    "middleware",
    `${name}: ${quote(toManifestModulePath(manifestPath, middlewareFile))}`,
  );
  writeFileSync(manifestPath, ensureTrailingNewline(updatedSource), "utf-8");

  return {
    created: [displayPath(project.root, middlewareFile)],
    kind: "middleware",
    updated: [displayPath(project.root, manifestPath)],
  };
}

interface ApiArgs {
  methods?: string;
  path: string;
}

function generateApi(args: ApiArgs, project: ProjectConfig): GenerateResult {
  const endpointPath = normalizeApiPath(args.path);
  const methods = parseApiMethods(args.methods);
  const apiFile = resolveApiModulePath(project, endpointPath);
  writeGeneratedFile(apiFile.absolutePath, buildApiRouteSource({ endpointPath, methods }));

  return {
    created: [displayPath(project.root, apiFile.absolutePath)],
    kind: "api",
    updated: [],
  };
}

interface RouteModuleParts {
  includeErrorBoundary: boolean;
  includeLoader: boolean;
  includeStaticPaths: boolean;
  routePath: string;
  title: string;
}

function buildRouteModuleSections(opts: RouteModuleParts): string[] {
  const { includeErrorBoundary, includeLoader, includeStaticPaths, routePath, title } = opts;
  const params = dynamicParamNames(routePath);
  const imports: string[] = [];
  const sections: string[] = [];

  if (includeLoader) {
    imports.push("LoaderArgs", "RouteComponentProps");
  }
  if (includeErrorBoundary) {
    imports.push("ErrorBoundaryProps");
  }

  if (imports.length > 0) {
    sections.push(`import type { ${imports.join(", ")} } from "@pracht/core";`);
    sections.push("");
  }

  if (includeLoader) {
    sections.push(
      "export async function loader(_args: LoaderArgs) {",
      `  return { message: ${quote(`Welcome to ${title}.`)} };`,
      "}",
      "",
    );
  }

  if (includeStaticPaths) {
    sections.push(
      "export function getStaticPaths() {",
      `  return [${buildStaticPathsStub(params)}];`,
      "}",
      "",
    );
  }

  if (includeLoader) {
    sections.push(
      "export function Component({ data }: RouteComponentProps<typeof loader>) {",
      "  return (",
      "    <section>",
      `      <h1>${escapeJsxText(title)}</h1>`,
      "      <p>{data.message}</p>",
      "    </section>",
      "  );",
      "}",
    );
  } else {
    sections.push(
      "export function Component() {",
      "  return (",
      "    <section>",
      `      <h1>${escapeJsxText(title)}</h1>`,
      "    </section>",
      "  );",
      "}",
    );
  }

  if (includeErrorBoundary) {
    sections.push(
      "",
      "export function ErrorBoundary({ error }: ErrorBoundaryProps) {",
      "  return <p>{error.message}</p>;",
      "}",
    );
  }

  return sections;
}

function buildManifestRouteModuleSource(opts: RouteModuleParts): string {
  const sections = buildRouteModuleSections(opts);

  // Insert head() before the Component export (after loader/getStaticPaths)
  const componentIdx = sections.findIndex((s) => s.startsWith("export function Component"));
  const insertAt = componentIdx === -1 ? sections.length : componentIdx;
  sections.splice(
    insertAt,
    0,
    "export function head() {",
    `  return { title: ${quote(opts.title)} };`,
    "}",
    "",
  );

  return `${sections.join("\n")}\n`;
}

function buildPagesRouteModuleSource(opts: RouteModuleParts & { render: string }): string {
  const sections = buildRouteModuleSections(opts);

  // Insert RENDER_MODE before the first exported declaration (after imports)
  const firstExportIdx = sections.findIndex((s) => s.startsWith("export"));
  const insertAt = firstExportIdx === -1 ? sections.length : firstExportIdx;
  sections.splice(insertAt, 0, `export const RENDER_MODE = ${quote(opts.render)};`, "");

  return `${sections.join("\n")}\n`;
}

function buildShellModuleSource(name: string): string {
  const title = titleCase(name);
  return [
    'import type { ShellProps } from "@pracht/core";',
    "",
    "export function Shell({ children }: ShellProps) {",
    "  return (",
    `    <div class=${quote(`${name}-shell`)}>`,
    "      <main>{children}</main>",
    "    </div>",
    "  );",
    "}",
    "",
    "export function head() {",
    `  return { title: ${quote(title)} };`,
    "}",
    "",
  ].join("\n");
}

function buildMiddlewareModuleSource(): string {
  return [
    'import type { MiddlewareFn } from "@pracht/core";',
    "",
    "export const middleware: MiddlewareFn = async (_args) => {",
    "  return;",
    "};",
    "",
  ].join("\n");
}

function buildApiRouteSource({
  endpointPath,
  methods,
}: {
  endpointPath: string;
  methods: string[];
}): string {
  const methodLines = methods.flatMap((method, index) => {
    const lines = buildApiMethodSource(method, methods, endpointPath);
    if (index === methods.length - 1) return lines;
    return [...lines, ""];
  });

  return ['import type { BaseRouteArgs } from "@pracht/core";', "", ...methodLines, ""].join("\n");
}

function buildApiMethodSource(method: string, methods: string[], endpointPath: string): string[] {
  if (method === "DELETE" || method === "HEAD") {
    return [
      `export function ${method}(_args: BaseRouteArgs) {`,
      "  return new Response(null, { status: 204 });",
      "}",
    ];
  }

  if (method === "OPTIONS") {
    return [
      `export function ${method}(_args: BaseRouteArgs) {`,
      "  return new Response(null, {",
      `    headers: { allow: ${quote(methods.join(", "))} },`,
      "    status: 204,",
      "  });",
      "}",
    ];
  }

  if (method === "GET") {
    return [
      `export function ${method}(_args: BaseRouteArgs) {`,
      `  return Response.json({ endpoint: ${quote(`/api${endpointPath}`)}, ok: true });`,
      "}",
    ];
  }

  const status = method === "POST" ? 201 : 200;
  return [
    `export async function ${method}({ request }: BaseRouteArgs) {`,
    "  const body = await request.json();",
    `  return Response.json({ body, ok: true }, { status: ${status} });`,
    "}",
  ];
}

function normalizeRoutePathString(value: string): string {
  if (!value || value === "/") return "/";
  const normalized = `/${value}`.replace(/\/+/g, "/");
  return normalized !== "/" && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function normalizeApiPath(value: string): string {
  const normalized = normalizeRoutePathString(value).replace(/^\/api(?=\/|$)/, "");
  return normalized || "/";
}

function hasDynamicSegments(routePath: string): boolean {
  return routePath.split("/").some((segment) => segment.startsWith(":") || segment === "*");
}

function dynamicParamNames(routePath: string): string[] {
  return routePath
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(":")) return segment.slice(1);
      if (segment === "*") return "slug";
      return null;
    })
    .filter((s): s is string => s !== null);
}

function routeIdFromPath(routePath: string): string {
  if (routePath === "/") return "index";
  return routePath
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/^:/, "").replace(/\*/g, "splat"))
    .join("-");
}

function titleFromPath(routePath: string): string {
  if (routePath === "/") return "Home";
  const lastSegment = routePath.split("/").filter(Boolean).at(-1) ?? "Page";
  return titleCase(lastSegment.replace(/^:/, "").replace(/\*/g, "slug"));
}

function titleCase(value: string): string {
  return value
    .split(/[-_/]/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function buildStaticPathsStub(params: string[]): string {
  if (params.length === 0) {
    return "{}";
  }

  return `{ ${params.map((name) => `${name}: ${quote(`example-${name}`)}`).join(", ")} }`;
}

function escapeJsxText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
