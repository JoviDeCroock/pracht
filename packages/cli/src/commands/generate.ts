import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

import { defineCommand } from "citty";
import { loadConfigFromFile } from "vite";

import {
  ensureTrailingNewline,
  handleCliError,
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
  listDirectoriesRecursively,
  listFilesRecursively,
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
  buildCapabilityModuleSource,
  buildManifestRouteModuleSource,
  buildMiddlewareModuleSource,
  buildPagesRouteModuleSource,
  buildRouteSmokeTestSource,
  buildShellModuleSource,
} from "./generate-source.js";

export interface GenerateResult {
  created: string[];
  kind: string;
  /** Follow-up the caller has to act on, e.g. a missing dependency. */
  notes?: string[];
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
    try {
      const project = readProjectConfig(process.cwd());
      outputResult(generateRoute(args, project), Boolean(args.json));
    } catch (error) {
      handleCliError(error, { json: Boolean(args.json) });
    }
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
    try {
      const project = readProjectConfig(process.cwd());
      outputResult(generateShell(args.name, project), Boolean(args.json));
    } catch (error) {
      handleCliError(error, { json: Boolean(args.json) });
    }
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
    try {
      const project = readProjectConfig(process.cwd());
      outputResult(await generateMiddleware(args.name, project), Boolean(args.json));
    } catch (error) {
      handleCliError(error, { json: Boolean(args.json) });
    }
  },
});

const CAPABILITY_NAME_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

const capabilityCommand = defineCommand({
  meta: {
    name: "capability",
    description: "Scaffold a capability module",
  },
  args: {
    name: {
      type: "string",
      required: true,
      description: "Dot-separated capability name, e.g. notes.search",
    },
    effect: {
      type: "string",
      description: "Effect class: read, write, or destructive (defaults to read)",
    },
    expose: {
      type: "string",
      description:
        "Transports to expose, comma-separated: http, webmcp, mcp. Omit to keep it private.",
    },
    title: { type: "string", description: "Human-readable title" },
    description: { type: "string", description: "Contract description (required when exposed)" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  async run({ args }) {
    try {
      const project = readProjectConfig(process.cwd());
      outputResult(generateCapability(args, project), Boolean(args.json));
    } catch (error) {
      handleCliError(error, { json: Boolean(args.json) });
    }
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
    try {
      const project = readProjectConfig(process.cwd());
      outputResult(generateApi(args, project), Boolean(args.json));
    } catch (error) {
      handleCliError(error, { json: Boolean(args.json) });
    }
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
    capability: capabilityCommand,
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
  for (const note of result.notes ?? []) {
    console.log("");
    console.log(note);
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
  if (render !== "isg" && args.revalidate !== undefined) {
    throw new Error("`--revalidate` is only valid together with `--render isg`.");
  }
  const revalidateSeconds =
    render === "isg" ? requirePositiveInteger(args.revalidate, "revalidate", 3600) : undefined;
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
      revalidateSeconds,
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
    meta.push(`revalidate: timeRevalidate(${revalidateSeconds})`);
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
  if (!hasPlaywrightDependency(project.root)) {
    result.notes ??= [];
    result.notes.push(
      "The generated smoke test imports `@playwright/test`, which is not installed yet. Install it with your package manager (for example: npm install --save-dev @playwright/test).",
    );
  }
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

function hasPlaywrightDependency(root: string): boolean {
  try {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
    return Boolean(
      packageJson.dependencies?.["@playwright/test"] ??
      packageJson.devDependencies?.["@playwright/test"],
    );
  } catch {
    return true; // Unreadable package.json — do not invent package-manager advice.
  }
}

function generatePagesRoute({
  includeErrorBoundary,
  includeLoader,
  includeStaticPaths,
  project,
  render,
  revalidateSeconds,
  routePath,
  title,
}: {
  includeErrorBoundary: boolean;
  includeLoader: boolean;
  includeStaticPaths: boolean;
  project: ProjectConfig;
  render: string;
  revalidateSeconds?: number;
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
      revalidateSeconds,
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

export async function generateMiddleware(
  name: string,
  project: ProjectConfig,
): Promise<GenerateResult> {
  if (project.mode === "pages") {
    // Pages router apps have exactly one middleware seam: a root-level
    // `_middleware.ts` applied to every page route. The requested name is a
    // manifest concept, so anything else would silently generate an ignored
    // `_`-prefixed file.
    if (name !== "_middleware") {
      throw new Error(
        "Pages router apps register middleware through a single root-level `_middleware.ts` " +
          "applied to every page route. Run `pracht generate middleware --name _middleware`, or " +
          "eject to an explicit manifest for named per-route middleware.",
      );
    }

    const pagesDir = resolveProjectPath(project.root, project.pagesDir);
    const existingMiddlewarePaths = existsSync(pagesDir)
      ? [
          ...listDirectoriesRecursively(pagesDir).filter(
            (directory) => basename(directory) === "_middleware",
          ),
          ...listFilesRecursively(pagesDir).filter(
            (file) => basename(file, extname(file)) === "_middleware",
          ),
        ]
      : [];
    if (existingMiddlewarePaths.length > 0) {
      throw new Error(
        `Refusing to create pages middleware because ${existingMiddlewarePaths
          .map((file) => JSON.stringify(displayPath(project.root, file)))
          .join(
            ", ",
          )} already exists. Pages apps support exactly one root-level \`_middleware\` file.`,
      );
    }

    if (await usesStaticAdapter(project)) {
      throw new Error(
        "Pure static exports cannot use request middleware. Use a serverful adapter before " +
          "generating pages `_middleware.ts`.",
      );
    }

    const middlewareFile = resolveScopedFile(project.root, project.pagesDir, "_middleware.ts");
    writeGeneratedFile(middlewareFile, buildMiddlewareModuleSource());

    return {
      created: [displayPath(project.root, middlewareFile)],
      kind: "middleware",
      updated: [],
    };
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

type PrachtPluginApi = {
  pracht?: {
    staticTarget?: unknown;
  };
};

async function flattenPlugins(value: unknown): Promise<unknown[]> {
  const resolved = await value;
  if (Array.isArray(resolved)) {
    return (await Promise.all(resolved.map((plugin) => flattenPlugins(plugin)))).flat();
  }
  return resolved === false || resolved == null ? [] : [resolved];
}

/** Load the actual Vite config and inspect the adapter selected by the Pracht plugin. */
async function usesStaticAdapter(
  project: Pick<ProjectConfig, "configFile" | "root">,
): Promise<boolean> {
  if (!project.configFile) throw incompatiblePagesMiddlewarePluginError();

  const loaded = await loadConfigFromFile(
    { command: "build", isPreview: false, isSsrBuild: true, mode: "production" },
    project.configFile,
    project.root,
    "silent",
  );
  if (!loaded) throw incompatiblePagesMiddlewarePluginError();

  const plugins = await flattenPlugins(loaded.config.plugins);
  const prachtPlugins = plugins.flatMap((plugin) => {
    if (!plugin || typeof plugin !== "object") return [];
    const candidate = plugin as { api?: PrachtPluginApi; name?: unknown };
    return candidate.name === "pracht" ? [candidate] : [];
  });
  const compatiblePlugins = prachtPlugins.filter(
    (plugin) => typeof plugin.api?.pracht?.staticTarget === "boolean",
  );
  if (compatiblePlugins.length === 0) {
    throw incompatiblePagesMiddlewarePluginError();
  }

  return compatiblePlugins.some((plugin) => plugin.api?.pracht?.staticTarget === true);
}

function incompatiblePagesMiddlewarePluginError(): Error {
  return new Error(
    "Cannot generate pages `_middleware.ts` because the loaded Vite config does not expose " +
      "compatible Pracht plugin metadata. Upgrade `@pracht/vite-plugin` to a version that " +
      "supports pages middleware, then retry.",
  );
}

export interface CapabilityArgs {
  description?: string;
  effect?: string;
  expose?: string;
  name: string;
  title?: string;
}

const CAPABILITY_TRANSPORTS = ["http", "webmcp", "mcp"];

export function generateCapability(args: CapabilityArgs, project: ProjectConfig): GenerateResult {
  const name = args.name;
  if (!CAPABILITY_NAME_RE.test(name)) {
    throw new Error(
      `Invalid capability name ${quote(name)}. Names are dot-separated segments of letters, numbers, hyphens, and underscores — e.g. "notes.search".`,
    );
  }

  const effect = requireEnum(args.effect, "effect", ["read", "write", "destructive"], "read") as
    | "read"
    | "write"
    | "destructive";
  const expose = parseCommaList(args.expose);
  for (const transport of expose) {
    if (!CAPABILITY_TRANSPORTS.includes(transport)) {
      throw new Error(
        `Unknown transport ${quote(transport)} in --expose. Expected one of ${CAPABILITY_TRANSPORTS.join(", ")}.`,
      );
    }
  }

  // The runtime, `defineCapability()`, and `pracht verify` all reject this;
  // refusing here means the scaffold never writes a module that cannot build.
  if (effect === "destructive" && expose.includes("webmcp")) {
    throw new Error(
      "A destructive capability cannot be a WebMCP page tool — a browser host's approval UX is not a security boundary. Use http, or mcp with agents.mcp.destructive.",
    );
  }
  if (expose.includes("webmcp") && !expose.includes("http")) {
    throw new Error("`--expose webmcp` requires http: the page tool calls the HTTP projection.");
  }

  // An exposed capability needs a real description — it is what an agent reads
  // to decide whether to call the tool, and `pracht verify` requires one. A
  // generated "TODO" placeholder would satisfy that check while telling the
  // agent nothing, so ask for it up front instead.
  if (expose.length > 0 && !args.description) {
    throw new Error(
      "`--description` is required when --expose is set: it is the contract text agents read, and `pracht verify` fails without one.",
    );
  }

  const manifestPath = resolveProjectPath(project.root, project.appFile);
  // Pages apps discover `src/capabilities/` directly: the directory is the
  // registry, so there is no manifest to update — but the module must name
  // itself when the name is not simply its file stem.
  const isPagesMode = project.mode === "pages";
  if (!isPagesMode) {
    assertFileExists(manifestPath, `App manifest not found at ${project.appFile}.`);
  }

  const capabilityFile = resolveScopedFile(
    project.root,
    project.capabilitiesDir,
    `${name.replaceAll(".", "-")}.ts`,
  );
  writeGeneratedFile(
    capabilityFile,
    buildCapabilityModuleSource({
      description: args.description ?? `TODO: describe what ${name} does.`,
      effect,
      expose,
      name: isPagesMode ? name : undefined,
      title: args.title ?? titleFromPath(`/${name.replaceAll(".", " ")}`),
    }),
  );

  const capabilitiesNote = hasCapabilitiesDependency(project.root)
    ? {}
    : {
        notes: [
          "This module imports `@pracht/capabilities`, which is not installed yet. Run: npm install @pracht/capabilities",
        ],
      };

  if (isPagesMode) {
    return {
      created: [displayPath(project.root, capabilityFile)],
      kind: "capability",
      ...capabilitiesNote,
      updated: [],
    };
  }

  const manifestSource = readFileSync(manifestPath, "utf-8");
  const updatedSource = upsertObjectEntry(
    manifestSource,
    "capabilities",
    `${quote(name)}: ${quote(toManifestModulePath(manifestPath, capabilityFile))}`,
  );
  writeFileSync(manifestPath, ensureTrailingNewline(updatedSource), "utf-8");

  return {
    created: [displayPath(project.root, capabilityFile)],
    kind: "capability",
    // The generated module imports `@pracht/capabilities`, which is a separate
    // package. Say so here rather than letting the app 500 at request time and
    // report the capability as private everywhere until `pracht verify` runs.
    ...(hasCapabilitiesDependency(project.root)
      ? {}
      : {
          notes: [
            "This module imports `@pracht/capabilities`, which is not installed yet. Run: npm install @pracht/capabilities",
          ],
        }),
    updated: [displayPath(project.root, manifestPath)],
  };
}

function hasCapabilitiesDependency(root: string): boolean {
  try {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
    return Boolean(
      packageJson.dependencies?.["@pracht/capabilities"] ??
      packageJson.devDependencies?.["@pracht/capabilities"],
    );
  } catch {
    return true; // Unreadable package.json — do not invent advice.
  }
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
