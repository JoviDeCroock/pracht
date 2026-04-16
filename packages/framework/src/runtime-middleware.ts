import { applyHeaders, withDefaultSecurityHeaders } from "./runtime-headers.ts";
import { resolveRegistryModule } from "./runtime-manifest.ts";
import type {
  BaseRouteArgs,
  HeadMetadata,
  MiddlewareModule,
  ModuleRegistry,
  ResolvedApiRoute,
  RouteModule,
  ShellModule,
} from "./types.ts";

export async function runMiddlewareChain<TContext>(options: {
  context: TContext;
  middlewareFiles: string[];
  params: Record<string, string>;
  registry: ModuleRegistry;
  request: Request;
  route: BaseRouteArgs<TContext>["route"] | ResolvedApiRoute;
  url: URL;
}): Promise<
  { context: TContext; response?: undefined } | { response: Response; context?: undefined }
> {
  let context = options.context;

  // Kick off module resolution for every middleware in parallel. Execution
  // below still runs sequentially — middleware may mutate context and the
  // ordering is part of the public contract — but the imports themselves
  // have no inter-dependency, so waiting for them one-by-one is pure
  // latency for no benefit. On cold starts where middleware ships as its
  // own chunks this can meaningfully reduce TTFB.
  const modulePromises = options.middlewareFiles.map((mwFile) =>
    resolveRegistryModule<MiddlewareModule>(options.registry.middlewareModules, mwFile),
  );
  // Suppress unhandled-rejection warnings for promises that may not be
  // awaited if an earlier middleware short-circuits with a response.
  for (const p of modulePromises) {
    p.catch(() => {});
  }

  for (const modulePromise of modulePromises) {
    const mwModule = await modulePromise;
    if (!mwModule?.middleware) continue;

    const result = await mwModule.middleware({
      request: options.request,
      params: options.params,
      context,
      signal: AbortSignal.timeout(30_000),
      url: options.url,
      route: options.route as BaseRouteArgs<TContext>["route"],
    });

    if (!result) continue;
    if (result instanceof Response) {
      return { response: withDefaultSecurityHeaders(result) };
    }
    if ("redirect" in result) {
      return {
        response: withDefaultSecurityHeaders(
          new Response(null, {
            status: 302,
            headers: { location: result.redirect },
          }),
        ),
      };
    }
    if ("context" in result) {
      context = { ...context, ...result.context } as TContext;
    }
  }

  return { context };
}

export async function mergeHeadMetadata(
  shellModule: ShellModule | undefined,
  routeModule: RouteModule | undefined,
  routeArgs: BaseRouteArgs<unknown>,
  data: unknown,
): Promise<HeadMetadata> {
  // Shell and route `head` exports are independent — run them concurrently.
  // Merge order (shell first, then route) is preserved below.
  const [shellHead, routeHead] = await Promise.all([
    shellModule?.head ? shellModule.head(routeArgs) : Promise.resolve({} as HeadMetadata),
    routeModule?.head
      ? routeModule.head({ ...routeArgs, data } as any)
      : Promise.resolve({} as HeadMetadata),
  ]);

  return {
    title: routeHead.title ?? shellHead.title,
    lang: routeHead.lang ?? shellHead.lang,
    meta: [...(shellHead.meta ?? []), ...(routeHead.meta ?? [])],
    link: [...(shellHead.link ?? []), ...(routeHead.link ?? [])],
  };
}

export async function mergeDocumentHeaders(
  shellModule: ShellModule | undefined,
  routeModule: RouteModule | undefined,
  routeArgs: BaseRouteArgs<unknown>,
  data: unknown,
): Promise<Headers> {
  const headers = new Headers();
  // Shell and route `headers` exports are independent — run concurrently.
  // Apply order (shell first, then route) still gives route precedence.
  const [shellHeaders, routeHeaders] = await Promise.all([
    shellModule?.headers ? shellModule.headers(routeArgs) : Promise.resolve(undefined),
    routeModule?.headers
      ? routeModule.headers({ ...routeArgs, data } as any)
      : Promise.resolve(undefined),
  ]);
  if (shellHeaders) {
    applyHeaders(headers, shellHeaders);
  }
  if (routeHeaders) {
    applyHeaders(headers, routeHeaders);
  }

  return headers;
}
