import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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
import {
  hasDynamicSegments,
  normalizeApiPath,
  normalizeRoutePathString,
  routeIdFromPath,
  titleFromPath,
} from "./generate-paths.js";
import {
  buildApiRouteSource,
  buildManifestRouteModuleSource,
  buildMiddlewareModuleSource,
  buildPagesRouteModuleSource,
  buildRouteSmokeTestSource,
  buildShellModuleSource,
} from "./generate-source.js";

export interface GenerateResult {
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
    test: {
      type: "boolean",
      description:
        "Emit a Playwright smoke test in e2e/ (default: on when the app has a Playwright setup; --no-test to skip)",
    },
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

export interface RouteArgs {
  "error-boundary"?: boolean;
  loader?: boolean;
  middleware?: string;
  path: string;
  render?: string;
  revalidate?: string;
  shell?: string;
  "static-paths"?: boolean;
  test?: boolean;
  title?: string;
}

export function generateRoute(args: RouteArgs, project: ProjectConfig): GenerateResult {
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
    const result = generatePagesRoute({
      includeErrorBoundary,
      includeLoader,
      includeStaticPaths,
      project,
      render,
      routePath,
      title,
    });
    maybeGenerateSmokeTest(project, routePath, title, args.test, result);
    return result;
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

  const result: GenerateResult = {
    created: [displayPath(project.root, routeFile.absolutePath)],
    kind: "route",
    updated: [displayPath(project.root, manifestPath)],
  };
  maybeGenerateSmokeTest(project, routePath, title, args.test, result);
  return result;
}

/**
 * Emit a Playwright smoke test next to a generated route. Defaults to on when
 * the app has a Playwright setup (playwright.config.* or an e2e/ directory);
 * `--test` forces emission, `--no-test` skips it.
 */
function maybeGenerateSmokeTest(
  project: ProjectConfig,
  routePath: string,
  title: string,
  testFlag: boolean | undefined,
  result: GenerateResult,
): void {
  const shouldEmit = testFlag ?? hasPlaywrightSetup(project.root);
  if (!shouldEmit) return;

  const testFile = resolve(project.root, "e2e", `${routeIdFromPath(routePath)}.spec.ts`);
  writeGeneratedFile(testFile, buildRouteSmokeTestSource({ routePath, title }));
  result.created.push(displayPath(project.root, testFile));
}

function hasPlaywrightSetup(root: string): boolean {
  return (
    [
      "playwright.config.ts",
      "playwright.config.mts",
      "playwright.config.js",
      "playwright.config.mjs",
    ]
      .map((name) => resolve(root, name))
      .some((file) => existsSync(file)) || existsSync(resolve(root, "e2e"))
  );
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

export function generateShell(name: string, project: ProjectConfig): GenerateResult {
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

export function generateMiddleware(name: string, project: ProjectConfig): GenerateResult {
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

export interface ApiArgs {
  methods?: string;
  path: string;
}

export function generateApi(args: ApiArgs, project: ProjectConfig): GenerateResult {
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
