import type { PrachtAdapter } from "@pracht/vite-plugin";
import {
  handlePrachtRequest,
  type HandlePrachtRequestOptions,
  type ModuleRegistry,
  type ResolvedApiRoute,
  type PrachtApp,
} from "@pracht/core/server";

export interface VercelExecutionContext {
  waitUntil?(promise: Promise<unknown>): void;
  [key: string]: unknown;
}

export interface VercelContextArgs<
  TVercelContext extends VercelExecutionContext = VercelExecutionContext,
> {
  request: Request;
  context: TVercelContext;
}

export interface VercelAdapterOptions<
  TVercelContext extends VercelExecutionContext = VercelExecutionContext,
  TContext = TVercelContext,
> {
  app: PrachtApp;
  registry?: ModuleRegistry;
  apiRoutes?: ResolvedApiRoute[];
  clientEntryUrl?: string;
  cssManifest?: Record<string, string[]>;
  jsManifest?: Record<string, string[]>;
  createContext?: (args: VercelContextArgs<TVercelContext>) => TContext | Promise<TContext>;
}

export interface VercelServerEntryModuleOptions {
  functionName?: string;
  regions?: string | string[];
  /** Vite-resolvable module path exporting `createContext(args)`. */
  createContextFrom?: string;
}

export function createVercelEdgeHandler<
  TVercelContext extends VercelExecutionContext = VercelExecutionContext,
  TContext = TVercelContext,
>(options: VercelAdapterOptions<TVercelContext, TContext>) {
  return async (request: Request, context: TVercelContext): Promise<Response> => {
    const prachtContext = options.createContext
      ? await options.createContext({ request, context })
      : (context as unknown as TContext);

    return handlePrachtRequest({
      app: options.app,
      registry: options.registry,
      request,
      context: prachtContext,
      apiRoutes: options.apiRoutes,
      clientEntryUrl: options.clientEntryUrl,
      cssManifest: options.cssManifest,
      jsManifest: options.jsManifest,
    } satisfies HandlePrachtRequestOptions<TContext>);
  };
}

export function createVercelServerEntryModule(
  options: VercelServerEntryModuleOptions = {},
): string {
  const functionName = options.functionName ?? "render";
  const regions = options.regions;
  const contextImport = options.createContextFrom
    ? `import { createContext as createPrachtContext } from ${JSON.stringify(options.createContextFrom)};`
    : "const createPrachtContext = undefined;";

  return [
    contextImport,
    `export const vercelFunctionName = ${JSON.stringify(functionName)};`,
    `export const vercelRegions = ${JSON.stringify(regions ?? null)};`,
    "",
    "export default async function handle(request, context) {",
    "  const prachtContext = createPrachtContext",
    "    ? await createPrachtContext({ request, context })",
    "    : context;",
    "",
    "  return handlePrachtRequest({",
    "    app: resolvedApp,",
    "    registry,",
    "    request,",
    "    context: prachtContext,",
    "    apiRoutes,",
    "    clientEntryUrl: clientEntryUrl ?? undefined,",
    "    cssManifest,",
    "    jsManifest,",
    "  });",
    "}",
    "",
  ].join("\n");
}

/**
 * Create a pracht adapter for Vercel Edge Functions.
 *
 * ```ts
 * import { vercelAdapter } from "@pracht/adapter-vercel";
 * pracht({ adapter: vercelAdapter() })
 * ```
 */
export function vercelAdapter(options: VercelServerEntryModuleOptions = {}): PrachtAdapter {
  return {
    id: "vercel",
    edge: true,
    serverImports:
      'import { handlePrachtRequest, resolveApp, resolveApiRoutes } from "@pracht/core/server";',
    createServerEntryModule() {
      return createVercelServerEntryModule(options);
    },
  };
}
