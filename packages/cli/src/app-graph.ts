import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import {
  resolveMcpEndpoint,
  resolveRegistryModule,
  serializeApiRoutesStatic,
  serializeCapabilities,
} from "@pracht/core";
import type { AppGraphCapability } from "@pracht/core";
import type { ViteDevServer } from "vite";

export interface AppGraphRoute {
  file: string;
  hydration: string | null;
  id: string;
  loaderCache: number | false | null;
  loaderFile: string | null;
  middleware: string[];
  path: string;
  prefetch: string | null;
  render: string | null;
  revalidate: unknown;
  shell: string | null;
  shellFile: string | null;
  speculation: unknown;
}

export interface AppGraphApiRoute {
  file: string;
  hasDefaultHandler: boolean;
  methods: string[];
  path: string;
}

export interface AppGraph {
  api: AppGraphApiRoute[];
  capabilities: AppGraphCapability[];
  /**
   * Path the remote MCP projection is served from, or `null` when the app does
   * not configure `agents.mcp` (in which case `expose.mcp` is recorded in the
   * graph but nothing serves it).
   */
  mcpEndpoint: string | null;
  routes: AppGraphRoute[];
  /** The app-level not-found page (never part of `routes`), or `null`. */
  notFound?: AppGraphRoute | null;
}

interface ResolvedRouteEntry {
  file: string;
  hydration?: string;
  id: string;
  loaderCache?: number | false;
  loaderFile?: string;
  middleware: string[];
  path: string;
  prefetch?: string;
  render?: string;
  revalidate?: unknown;
  shell?: string;
  shellFile?: string;
  speculation?: unknown;
}

const PRACHT_DEV_METADATA_MODULE_ID = "virtual:pracht/dev-metadata";

/**
 * Adapter-neutral app metadata (`resolvedApp`, `apiRoutes`, `registry`,
 * `buildTarget`) for graph-reading commands. It comes from a dedicated virtual
 * module rather than the adapter's server entry because that entry can pull in
 * imports Vite's Node SSR environment cannot resolve — Cloudflare Durable
 * Objects re-exported through `workerExportsFrom` import `cloudflare:workers`,
 * which only exists inside workerd.
 */
export async function loadAppMetadataModule(server: ViteDevServer): Promise<Record<string, any>> {
  try {
    return await server.ssrLoadModule(PRACHT_DEV_METADATA_MODULE_ID);
  } catch (error) {
    if (!isMissingDevMetadataModule(error)) throw error;

    // Apps on a @pracht/vite-plugin older than the dev-metadata module.
    return server.ssrLoadModule("virtual:pracht/server");
  }
}

function isMissingDevMetadataModule(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_LOAD_URL" &&
    error.message.includes(
      `Failed to load url ${PRACHT_DEV_METADATA_MODULE_ID} (resolved id: ${PRACHT_DEV_METADATA_MODULE_ID})`,
    )
  );
}

/**
 * Load the resolved app graph (page routes + API routes) from a running Vite
 * dev server. Shared by `pracht inspect` and the `pracht dev` startup banner.
 */
export async function collectAppGraph(
  server: ViteDevServer,
  root: string,
  options: { appFile?: string } = {},
): Promise<AppGraph> {
  const serverModule = await loadAppMetadataModule(server);
  const notFound = serverModule.resolvedApp.notFound;
  return {
    // The banner must not execute every API module at startup. Static export
    // analysis follows named and star re-exports without triggering unrelated
    // top-level application work.
    api: await serializeApiRoutesStatic(serverModule.apiRoutes, {
      readSource: (file) => readStaticAppModule(root, file),
      resolveModule: (specifier, importer) =>
        resolveStaticModule(server, root, specifier, importer),
    }),
    capabilities: await serializeCapabilities(serverModule.resolvedApp.capabilities, {
      loadModule: capabilityModuleLoader(server, serverModule),
      readSource: createSourceReader(root, options.appFile ?? "/src/routes.ts"),
    }),
    mcpEndpoint: resolveMcpEndpoint(serverModule.resolvedApp.agents),
    notFound: notFound ? serializeResolvedRoutes([notFound])[0] : null,
    routes: serializeResolvedRoutes(serverModule.resolvedApp.routes),
  };
}

function readStaticAppModule(root: string, file: string): string {
  const resolved = resolveInRootAppFile(root, resolve(root, `.${file}`));
  if (!resolved) throw new Error(`Static app module is outside the project root: ${file}`);
  return readFileSync(resolved.absolute, "utf-8");
}

async function resolveStaticModule(
  server: ViteDevServer,
  root: string,
  specifier: string,
  importer: string,
): Promise<string | null> {
  const importerFile = resolveInRootAppFile(root, resolve(root, `.${importer}`));
  if (!importerFile) return null;

  const resolved = await server.pluginContainer.resolveId(specifier, importerFile.absolute, {
    ssr: true,
  });
  if (!resolved) return null;
  if (typeof resolved !== "string" && resolved.external) return null;

  const id = typeof resolved === "string" ? resolved : resolved.id;
  const cleanId = id.split("?", 1)[0].split("#", 1)[0];
  if (cleanId.startsWith("\0") || cleanId.startsWith("virtual:")) return null;

  return resolveInRootAppFile(root, cleanId)?.appPath ?? null;
}

function resolveInRootAppFile(
  root: string,
  candidate: string,
): { absolute: string; appPath: string } | null {
  try {
    const canonicalRoot = realpathSync.native(root);
    const absolute = realpathSync.native(candidate);
    if (!statSync(absolute).isFile()) return null;

    const relativePath = relative(canonicalRoot, absolute);
    if (
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      relativePath.split(sep).includes("node_modules")
    ) {
      return null;
    }
    return { absolute, appPath: `/${relativePath.split(sep).join("/")}` };
  } catch {
    return null;
  }
}

/**
 * Manifest capability paths are relative to the app file (e.g.
 * `./capabilities/notes-search.ts`), so they only load through the virtual
 * server module's registry, which suffix-matches them against its glob keys.
 * Fall back to a direct ssrLoadModule for absolute/root-relative paths.
 */
/**
 * Read a module's source given the path shape the graph reports.
 *
 * API and route files are root-relative (`/src/api/health.ts`); capability
 * files come from the manifest and are manifest-relative
 * (`./capabilities/kv-get.ts`). Resolving the latter with the root-relative
 * rule walks *above* the project, so the read fails — and every consumer that
 * falls back to reading source (the static capability projection) silently got
 * nothing.
 */
export function createSourceReader(root: string, appFile: string): (file: string) => string {
  const manifestDir = dirname(resolve(root, `.${appFile}`));
  return (file) =>
    readFileSync(
      file.startsWith("/") ? resolve(root, `.${file}`) : resolve(manifestDir, file),
      "utf-8",
    );
}

export function capabilityModuleLoader(
  server: ViteDevServer,
  serverModule: Record<string, unknown>,
): (file: string) => Promise<Record<string, unknown>> {
  const registry = serverModule.registry as
    | { capabilityModules?: Record<string, () => Promise<unknown>> }
    | undefined;
  return async (file) => {
    const viaRegistry = await resolveRegistryModule<Record<string, unknown>>(
      registry?.capabilityModules,
      file,
    );
    return viaRegistry ?? server.ssrLoadModule(file);
  };
}

export function serializeResolvedRoutes(routes: ResolvedRouteEntry[]): AppGraphRoute[] {
  return routes.map((route) => ({
    file: route.file,
    hydration: route.hydration ?? null,
    id: route.id,
    loaderCache: route.loaderCache ?? null,
    loaderFile: route.loaderFile ?? null,
    middleware: route.middleware,
    path: route.path,
    prefetch: route.prefetch ?? null,
    render: route.render ?? null,
    revalidate: route.revalidate ?? null,
    shell: route.shell ?? null,
    shellFile: route.shellFile ?? null,
    speculation: route.speculation ?? null,
  }));
}
