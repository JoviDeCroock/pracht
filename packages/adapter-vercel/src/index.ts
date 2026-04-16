import type { PrachtAdapter } from "@pracht/vite-plugin";
import {
  handlePrachtRequest,
  type HandlePrachtRequestOptions,
  type ModuleRegistry,
  type ResolvedApiRoute,
  type PrachtApp,
} from "@pracht/core";

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

  return [
    `export const vercelFunctionName = ${JSON.stringify(functionName)};`,
    `export const vercelRegions = ${JSON.stringify(regions ?? null)};`,
    "",
    "export default async function handle(request, context) {",
    "  return handlePrachtRequest({",
    "    app: resolvedApp,",
    "    registry,",
    "    request,",
    "    context,",
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
      'import { handlePrachtRequest, resolveApp, resolveApiRoutes } from "@pracht/core";',
    createServerEntryModule() {
      return createVercelServerEntryModule(options);
    },
  };
}
