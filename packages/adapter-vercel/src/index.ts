import type { PrachtAdapter } from "@pracht/vite-plugin";
import {
  handlePrachtRequest,
  hasWebhookRevalidate,
  type HandlePrachtRequestOptions,
  jsonResponse,
  matchAppRoute,
  type ModuleRegistry,
  PRACHT_REVALIDATE_ENDPOINT,
  PRACHT_REVALIDATE_TOKEN_ENV,
  type ResolvedApiRoute,
  readRevalidationRequest,
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
    if (new URL(request.url).pathname === PRACHT_REVALIDATE_ENDPOINT) {
      return handleVercelRevalidationEndpoint(request, options.app);
    }

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
    "  const handler = createVercelEdgeHandler({",
    "    app: resolvedApp,",
    "    registry,",
    "    apiRoutes,",
    "    clientEntryUrl: clientEntryUrl ?? undefined,",
    "    cssManifest,",
    "    jsManifest,",
    "    createContext: createPrachtContext,",
    "  });",
    "  return handler(request, context);",
    "}",
    "",
  ].join("\n");
}

async function handleVercelRevalidationEndpoint(
  request: Request,
  app: PrachtApp,
): Promise<Response> {
  const token = getRuntimeRevalidationToken();
  const parsed = await readRevalidationRequest(request, token);
  if (!parsed.ok) return parsed.response;

  const revalidated: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const pathname of parsed.paths) {
    const match = matchAppRoute(app, pathname);
    if (!match || match.route.render !== "isg" || !hasWebhookRevalidate(match.route.revalidate)) {
      skipped.push(pathname);
      continue;
    }

    // A failed regeneration keeps Vercel's cached prerender output and is
    // reported in `failed` instead of aborting the whole batch with a 500.
    try {
      const revalidateUrl = new URL(pathname, request.url);
      const response = await fetch(revalidateUrl, {
        headers: {
          accept: "text/html",
          "x-prerender-revalidate": token!,
        },
        method: "GET",
      });

      if (response.ok) {
        revalidated.push(pathname);
      } else {
        failed.push(pathname);
      }
    } catch (err) {
      console.error(`ISG webhook revalidation failed for ${pathname}:`, err);
      failed.push(pathname);
    }
  }

  return jsonResponse({ failed, revalidated, skipped });
}

function getRuntimeRevalidationToken(): string | undefined {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env?.[PRACHT_REVALIDATE_TOKEN_ENV];
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
      'import { resolveApp, resolveApiRoutes } from "@pracht/core/server";\nimport { createVercelEdgeHandler } from "@pracht/adapter-vercel";',
    createServerEntryModule() {
      return createVercelServerEntryModule(options);
    },
  };
}
