import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ensureTrailingNewline,
  parseCommaList,
  quote,
  requireEnum,
  requirePositiveInteger,
} from "../utils.js";
import { ensureCoreNamedImport, insertArrayItem } from "../manifest-edit.js";
import { toManifestModulePath } from "../manifest-path.js";
import { extractRegistryEntries } from "../manifest-read.js";
import {
  assertFileExists,
  displayPath,
  resolvePagesRouteModulePath,
  resolveProjectPath,
  resolveRouteModulePath,
  writeGeneratedFile,
  type ProjectConfig,
} from "../project.js";
import {
  hasDynamicSegments,
  normalizeRoutePathString,
  routeIdFromPath,
  titleFromPath,
} from "./paths.js";
import {
  buildManifestRouteModuleSource,
  buildPagesRouteModuleSource,
  buildRouteSmokeTestSource,
} from "./route-source.js";
import type { GenerateResult } from "./types.js";

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
 * the app has a Playwright setup; `--test` forces emission and `--no-test`
 * skips it.
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
