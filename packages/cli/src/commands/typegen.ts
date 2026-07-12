import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { defineCommand } from "citty";

import { displayPath, readProjectConfig, resolveProjectPath } from "../project.js";
import { ensureTrailingNewline, handleCliError } from "../utils.js";
import { runInspect, type InspectReport } from "./inspect.js";

// The declaration must NOT share a basename with the runtime output
// (`pracht-routes.d.ts` next to `pracht-routes.ts`): TypeScript treats such a
// `.d.ts` as the build output of the `.ts` file and silently drops it from
// the program, so its `Register` augmentation never applies.
const DEFAULT_DECLARATION_OUT = "src/pracht.d.ts";
const DEFAULT_RUNTIME_OUT = "src/pracht-routes.ts";
const LEGACY_DECLARATION_OUT = "src/pracht-routes.d.ts";

type RouteEntry = NonNullable<InspectReport["routes"]>[number];
type ApiRouteEntry = NonNullable<InspectReport["api"]>[number];

export default defineCommand({
  meta: {
    name: "typegen",
    description: "Generate typed route declarations and href helpers",
  },
  args: {
    out: {
      type: "string",
      description: `Declaration output path (default: ${DEFAULT_DECLARATION_OUT})`,
    },
    "runtime-out": {
      type: "string",
      description: `Runtime href helper output path (default: ${DEFAULT_RUNTIME_OUT})`,
    },
    check: {
      type: "boolean",
      description: "Check whether generated route files are up to date without writing",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    try {
      const result = await runTypegen({
        check: Boolean(args.check),
        declarationOut: typeof args.out === "string" ? args.out : DEFAULT_DECLARATION_OUT,
        root: process.cwd(),
        runtimeOut:
          typeof args["runtime-out"] === "string" ? args["runtime-out"] : DEFAULT_RUNTIME_OUT,
      });

      if (json) {
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
        return;
      }

      if (result.check) {
        console.log("Generated route files are up to date.");
        return;
      }

      console.log("Generated typed routes:");
      for (const file of result.files) {
        console.log(`  ${file}`);
      }
    } catch (error) {
      handleCliError(error, { json });
    }
  },
});

interface TypegenOptions {
  check: boolean;
  declarationOut: string;
  root: string;
  runtimeOut: string;
}

interface TypegenResult {
  apiRoutes: number;
  check: boolean;
  files: string[];
  mode: string;
  routes: number;
}

async function runTypegen(options: TypegenOptions): Promise<TypegenResult> {
  // Type generation only needs each API route's path and source file. Avoid
  // loading the modules themselves: top-level API code may initialize runtime
  // services or have other side effects that should never run during codegen.
  const report = await runInspect(options.root, { inspectApiMethods: false, target: "all" });
  const routes = report.routes ?? [];
  const apiRoutes = report.api ?? [];
  validateRoutes(routes);
  validateApiRoutes(apiRoutes);

  const project = readProjectConfig(options.root);
  const declarationPath = resolveOutputPath(options.root, options.declarationOut);
  const runtimePath = resolveOutputPath(options.root, options.runtimeOut);
  if (outputsCollide(declarationPath, runtimePath)) {
    throw new Error(
      `Declaration output ${options.declarationOut} shares its basename with ${options.runtimeOut}. ` +
        "TypeScript drops a .d.ts input that sits next to a same-named .ts file, " +
        "so the generated route types would never apply. Pick a different --out.",
    );
  }
  const outputs = [
    {
      path: declarationPath,
      source: buildDeclarationSource(routes, apiRoutes, {
        appDir: dirname(resolveProjectPath(options.root, project.appFile)),
        declarationDir: dirname(declarationPath),
        root: options.root,
      }),
    },
    {
      path: runtimePath,
      source: buildRuntimeSource(routes),
    },
  ];

  if (options.check) {
    const stale = outputs.filter((output) => !fileMatches(output.path, output.source));
    if (stale.length > 0) {
      const files = stale.map((output) => displayPath(options.root, output.path)).join(", ");
      throw new Error(`Generated route files are out of date: ${files}. Run \`pracht typegen\`.`);
    }
  } else {
    for (const output of outputs) {
      mkdirSync(dirname(output.path), { recursive: true });
      writeFileSync(output.path, output.source, "utf-8");
    }
    removeLegacyDeclaration(options.root, declarationPath);
  }

  return {
    apiRoutes: apiRoutes.length,
    check: options.check,
    files: outputs.map((output) => displayPath(options.root, output.path)),
    mode: report.mode,
    routes: routes.length,
  };
}

function outputsCollide(declarationPath: string, runtimePath: string): boolean {
  if (declarationPath === runtimePath) {
    return true;
  }

  const declarationStem = declarationPath.replace(/\.d\.(?:ts|mts|cts)$/, "");
  const runtimeStem = runtimePath.replace(/\.(?:ts|tsx|mts|cts)$/, "");
  return declarationStem !== declarationPath && declarationStem === runtimeStem;
}

function validateRoutes(routes: RouteEntry[]): void {
  const seen = new Map<string, string>();
  for (const route of routes) {
    if (!route.id) {
      throw new Error(`Route ${route.path} resolved without an id.`);
    }

    const previousPath = seen.get(route.id);
    if (previousPath) {
      throw new Error(
        `Duplicate route id "${route.id}" for ${previousPath} and ${route.path}. Add explicit unique ids.`,
      );
    }
    seen.set(route.id, route.path);

    inferRouteParams(route.path);
  }
}

/**
 * Earlier releases wrote the declaration to `src/pracht-routes.d.ts`, where
 * the sibling `pracht-routes.ts` shadowed it (see DEFAULT_DECLARATION_OUT).
 * Remove the stale, inert file when regenerating under the fixed name.
 */
function removeLegacyDeclaration(root: string, declarationPath: string): void {
  const legacyPath = resolve(root, LEGACY_DECLARATION_OUT);
  if (legacyPath === declarationPath || !existsSync(legacyPath)) {
    return;
  }
  if (readFileSync(legacyPath, "utf-8").startsWith("// Generated by `pracht typegen`.")) {
    rmSync(legacyPath);
  }
}

function validateApiRoutes(apiRoutes: ApiRouteEntry[]): void {
  for (const route of apiRoutes) {
    inferRouteParams(route.path);
  }
}

interface DeclarationContext {
  appDir: string;
  declarationDir: string;
  root: string;
}

function buildDeclarationSource(
  routes: RouteEntry[],
  apiRoutes: ApiRouteEntry[],
  context: DeclarationContext,
): string {
  const importsApiMethodMap = apiRoutes.some((route) => formatModuleSpecifier(route.file, context));
  const typeImports = [
    ...(importsApiMethodMap ? ["ApiRouteMethodMap"] : []),
    "RouteLoaderData",
    "RouteParamInput",
    "SearchParamsInput",
  ];
  const lines = [
    "// Generated by `pracht typegen`. Do not edit manually.",
    'import "@pracht/core";',
    `import type { ${typeImports.join(", ")} } from "@pracht/core";`,
    "",
    'declare module "@pracht/core" {',
    "  interface Register {",
    "    routes: {",
  ];

  for (const route of routes) {
    lines.push(`      ${JSON.stringify(route.id)}: {`);
    lines.push(`        path: ${JSON.stringify(route.path)};`);
    lines.push(`        params: ${formatParamsType(inferRouteParams(route.path))};`);
    lines.push("        search: SearchParamsInput;");
    lines.push(`        data: ${formatRouteDataType(route, context)};`);
    lines.push("      };");
  }

  lines.push("    };");
  lines.push("    apiRoutes: {");

  for (const route of apiRoutes) {
    const moduleSpecifier = formatModuleSpecifier(route.file, context);
    lines.push(`      ${JSON.stringify(route.path)}: {`);
    lines.push(`        path: ${JSON.stringify(route.path)};`);
    lines.push(`        params: ${formatParamsType(inferRouteParams(route.path))};`);
    lines.push(
      moduleSpecifier
        ? `        methods: ApiRouteMethodMap<typeof import(${moduleSpecifier})>;`
        : "        methods: Record<never, never>;",
    );
    lines.push("      };");
  }

  lines.push("    };");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push("export {};");
  lines.push("");

  return lines.join("\n");
}

function buildRuntimeSource(routes: RouteEntry[]): string {
  const lines = [
    "// Generated by `pracht typegen`. Do not edit manually.",
    'import { createHref } from "@pracht/core";',
    'import type { HrefRouteDefinition } from "@pracht/core";',
    "",
    "export const routes = [",
  ];

  for (const route of routes) {
    lines.push("  {");
    lines.push(`    id: ${JSON.stringify(route.id)},`);
    lines.push(`    path: ${JSON.stringify(route.path)},`);
    lines.push("  },");
  }

  lines.push("] as const satisfies readonly HrefRouteDefinition[];");
  lines.push("");
  lines.push("export const href = createHref(routes);");
  lines.push("");

  return lines.join("\n");
}

function inferRouteParams(path: string): string[] {
  const params: string[] = [];
  const seen = new Set<string>();

  for (const segment of path.split("/").filter(Boolean)) {
    let name: string | null = null;
    if (segment === "*") {
      name = "*";
    } else if (segment.startsWith(":")) {
      name = segment.endsWith("*") ? segment.slice(1, -1) || "*" : segment.slice(1);
    }

    if (!name) continue;
    if (seen.has(name)) {
      throw new Error(`Route ${path} declares duplicate param "${name}".`);
    }
    seen.add(name);
    params.push(name);
  }

  return params;
}

// Only modules TypeScript can resolve type-only imports for. Route files in
// other formats (`.md`, `.mdx`, `.tsrx`) fall back to `unknown` data.
const IMPORTABLE_MODULE_PATTERN = /\.(ts|tsx|js|jsx)$/;

function formatRouteDataType(route: RouteEntry, context: DeclarationContext): string {
  const routeModule = formatModuleSpecifier(route.file, context);
  const loaderModule = route.loaderFile ? formatModuleSpecifier(route.loaderFile, context) : null;

  if (loaderModule) {
    return routeModule
      ? `RouteLoaderData<typeof import(${loaderModule}), typeof import(${routeModule})>`
      : `RouteLoaderData<typeof import(${loaderModule})>`;
  }

  return routeModule ? `RouteLoaderData<typeof import(${routeModule})>` : "unknown";
}

function formatModuleSpecifier(file: string, context: DeclarationContext): string | null {
  if (!IMPORTABLE_MODULE_PATTERN.test(file)) {
    return null;
  }

  // Mirror the runtime's module resolution: root-relative files (pages mode,
  // `/src/...`) resolve from the project root, manifest-relative files
  // (`./routes/...`) resolve from the app manifest's directory.
  const absolutePath = file.startsWith("/")
    ? resolveProjectPath(context.root, file)
    : resolve(context.appDir, file);
  const relativePath = relative(context.declarationDir, absolutePath)
    .replace(/\\/g, "/")
    .replace(IMPORTABLE_MODULE_PATTERN, "");
  const specifier = relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
  return JSON.stringify(specifier);
}

function formatParamsType(params: string[]): string {
  if (params.length === 0) {
    return "Record<never, never>";
  }

  const properties = params.map((param) => `${JSON.stringify(param)}: RouteParamInput;`).join(" ");
  return `{ ${properties} }`;
}

function resolveOutputPath(root: string, outputPath: string): string {
  const absolutePath = isAbsolute(outputPath) ? outputPath : resolve(root, outputPath);
  const relativePath = relative(root, absolutePath);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return absolutePath;
  }
  throw new Error(`Refusing to write outside the project root: ${outputPath}.`);
}

function fileMatches(path: string, source: string): boolean {
  return existsSync(path) && readFileSync(path, "utf-8") === ensureTrailingNewline(source);
}
