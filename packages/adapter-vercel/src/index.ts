import type { PreviteAdapter } from "@previte/vite-plugin";
import {
  handlePreviteRequest,
  type HandlePreviteRequestOptions,
  type ModuleRegistry,
  type ResolvedApiRoute,
  type PreviteApp,
} from "previte";

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
  app: PreviteApp;
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
    const previteContext = options.createContext
      ? await options.createContext({ request, context })
      : (context as unknown as TContext);

    return handlePreviteRequest({
      app: options.app,
      registry: options.registry,
      request,
      context: previteContext,
      apiRoutes: options.apiRoutes,
      clientEntryUrl: options.clientEntryUrl,
      cssManifest: options.cssManifest,
      jsManifest: options.jsManifest,
    } satisfies HandlePreviteRequestOptions<TContext>);
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
    "  return handlePreviteRequest({",
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
 * Create a previte adapter for Vercel Edge Functions.
 *
 * ```ts
 * import { vercelAdapter } from "@previte/adapter-vercel";
 * previte({ adapter: vercelAdapter() })
 * ```
 */
export function vercelAdapter(options: VercelServerEntryModuleOptions = {}): PreviteAdapter {
  return {
    id: "vercel",
    serverImports: 'import { handlePreviteRequest, resolveApp, resolveApiRoutes } from "previte";',
    createServerEntryModule() {
      return createVercelServerEntryModule(options);
    },
  };
}
