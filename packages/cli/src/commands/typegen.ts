import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { defineCommand } from "citty";

import { displayPath, readProjectConfig, resolveProjectPath } from "../project.js";
import type { AppGraphCapability } from "@pracht/core";
import { assertCapabilityProjectionsAgree } from "../capability-consistency.js";
import { buildCapabilityDeclarationSource } from "../typegen-capability-source.js";
import {
  buildDeclarationSource,
  buildRuntimeSource,
  inferRouteParams,
} from "../typegen-route-source.js";
import { ensureTrailingNewline, handleCliError } from "../utils.js";
import { runInspect, type InspectReport } from "./inspect.js";

// The declaration must NOT share a basename with the runtime output
// (`pracht-routes.d.ts` next to `pracht-routes.ts`): TypeScript treats such a
// `.d.ts` as the build output of the `.ts` file and silently drops it from
// the program, so its `Register` augmentation never applies.
export const DEFAULT_DECLARATION_OUT = "src/pracht.d.ts";
export const DEFAULT_RUNTIME_OUT = "src/pracht-routes.ts";
export const DEFAULT_CAPABILITIES_OUT = "src/pracht-capabilities.d.ts";
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
    "capabilities-out": {
      type: "string",
      description: `Capability declaration output path (default: ${DEFAULT_CAPABILITIES_OUT})`,
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
        capabilitiesOut:
          typeof args["capabilities-out"] === "string"
            ? args["capabilities-out"]
            : DEFAULT_CAPABILITIES_OUT,
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

export interface TypegenOptions {
  capabilitiesOut: string;
  check: boolean;
  declarationOut: string;
  root: string;
  runtimeOut: string;
}

export interface TypegenResult {
  apiRoutes: number;
  capabilities: number;
  check: boolean;
  files: string[];
  mode: string;
  routes: number;
  /**
   * Capabilities whose module could not be executed, so their input and output
   * types are `unknown`. Part of the result rather than only a `console.warn`:
   * `--json` consumers and the MCP `typegen` tool are exactly the callers who
   * never see stderr, and regenerating types that silently say `unknown` is
   * the failure this reports.
   */
  unreadableCapabilities?: { name: string; source: string; error: string }[];
}

/**
 * Warn — do not block — when a capability module could not be executed.
 *
 * This is routinely a healthy app: a Cloudflare capability importing
 * `cloudflare:workers` at the top level deploys fine and only fails to load in
 * the CLI's Node graph server. Blocking here would strand it, because the same
 * app is required to keep `.pracht/app-graph.json` fresh.
 *
 * Effect, exposure, policy and middleware are recovered from the source (the
 * graph falls back to the same static extractor the browser projection uses),
 * but only when they are inline literals; the output schema never is, so it
 * types as `unknown`.
 */
function warnUnreadableCapabilities(capabilities: AppGraphCapability[]): void {
  const unreadable = capabilities.filter((capability) => capability.error);
  if (unreadable.length === 0) return;

  console.warn(
    `[pracht] ${unreadable.length} capability module(s) could not be loaded, so their types were ` +
      "recovered from source and their output types are `unknown`:\n" +
      unreadable
        .map((capability) => `  ${capability.name} (${capability.source}): ${capability.error}`)
        .join("\n") +
      "\nMove a runtime-only import (`cloudflare:workers`, a Node built-in in an edge module) " +
      "inside `run()` or behind a dynamic import to get full types.",
  );
}

export async function runTypegen(options: TypegenOptions): Promise<TypegenResult> {
  // Type generation only needs each API route's path and source file. Avoid
  // loading the modules themselves: top-level API code may initialize runtime
  // services or have other side effects that should never run during codegen.
  const report = await runInspect(options.root, {
    inspectApiMethods: false,
    target: ["routes", "api", "capabilities"],
  });
  const routes = report.routes ?? [];
  const apiRoutes = report.api ?? [];
  const capabilities = report.capabilities ?? [];
  validateRoutes(routes);
  validateApiRoutes(apiRoutes);
  const unreadableCapabilities = capabilities
    .filter((capability) => capability.error)
    .map((capability) => ({
      name: capability.name,
      source: capability.source,
      error: String(capability.error),
    }));
  warnUnreadableCapabilities(capabilities);

  const project = readProjectConfig(options.root);
  // Generated types claim which capabilities the browser can reach; the client
  // bundle's endpoint table comes from a separate static pass. Prove they agree
  // before writing types that would otherwise green-light a call that 404s.
  assertCapabilityProjectionsAgree(project, capabilities);
  const declarationPath = resolveOutputPath(options.root, options.declarationOut);
  const runtimePath = resolveOutputPath(options.root, options.runtimeOut);
  const capabilitiesPath = resolveOutputPath(options.root, options.capabilitiesOut);
  if (outputsCollide(declarationPath, runtimePath)) {
    throw new Error(
      `Declaration output ${options.declarationOut} shares its basename with ${options.runtimeOut}. ` +
        "TypeScript drops a .d.ts input that sits next to a same-named .ts file, " +
        "so the generated route types would never apply. Pick a different --out.",
    );
  }
  if (outputsCollide(capabilitiesPath, runtimePath)) {
    throw new Error(
      `Capabilities output ${options.capabilitiesOut} shares its basename with ${options.runtimeOut}. ` +
        "TypeScript drops a .d.ts input that sits next to a same-named .ts file, " +
        "so the generated capability types would never apply. Pick a different --capabilities-out.",
    );
  }
  if (
    capabilitiesPath === declarationPath ||
    outputsCollide(declarationPath, capabilitiesPath) ||
    outputsCollide(capabilitiesPath, declarationPath)
  ) {
    throw new Error(
      `Capabilities output ${options.capabilitiesOut} collides with the declaration output ` +
        `${options.declarationOut} — identical paths overwrite each other, and TypeScript drops ` +
        "a .d.ts input that sits next to a same-named .ts file. Pick a different --capabilities-out.",
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

  // The capability declaration file only exists for apps that register
  // capabilities. When the last capability is removed, an already-generated
  // file is rewritten to the empty registration instead of left stale.
  if (capabilities.length > 0 || existsSync(capabilitiesPath)) {
    outputs.push({
      path: capabilitiesPath,
      source: buildCapabilityDeclarationSource(capabilities),
    });
  }

  if (options.check) {
    const stale = outputs.filter((output) => !fileMatches(output.path, output.source));
    if (stale.length > 0) {
      const files = stale.map((output) => displayPath(options.root, output.path)).join(", ");
      throw new Error(`Generated route files are out of date: ${files}. Run \`pracht typegen\`.`);
    }
  } else {
    for (const output of outputs) {
      // Skip identical rewrites so watch-mode regeneration (`pracht dev`)
      // does not trigger spurious HMR updates for the generated modules.
      if (fileMatches(output.path, output.source)) {
        continue;
      }
      mkdirSync(dirname(output.path), { recursive: true });
      writeFileSync(output.path, output.source, "utf-8");
    }
    removeLegacyDeclaration(options.root, declarationPath);
  }

  return {
    apiRoutes: apiRoutes.length,
    capabilities: capabilities.length,
    check: options.check,
    files: outputs.map((output) => displayPath(options.root, output.path)),
    mode: report.mode,
    routes: routes.length,
    ...(unreadableCapabilities.length > 0 ? { unreadableCapabilities } : {}),
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
