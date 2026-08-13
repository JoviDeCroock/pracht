import { applyHeaders } from "./runtime-header-values.ts";
import type { BaseRouteArgs, HeadMetadata, RouteModule, ShellModule } from "./types.ts";

/** Resolve shell and route head exports concurrently, then merge route last. */
export async function mergeHeadMetadata(
  shellModule: ShellModule | undefined,
  routeModule: RouteModule | undefined,
  routeArgs: BaseRouteArgs<unknown>,
  data: unknown,
): Promise<HeadMetadata> {
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
    script: [...(shellHead.script ?? []), ...(routeHead.script ?? [])],
  };
}

/** Resolve document header exports concurrently, then apply route last. */
export async function mergeDocumentHeaders(
  shellModule: ShellModule | undefined,
  routeModule: RouteModule | undefined,
  routeArgs: BaseRouteArgs<unknown>,
  data: unknown,
): Promise<Headers> {
  const headers = new Headers();
  const [shellHeaders, routeHeaders] = await Promise.all([
    shellModule?.headers ? shellModule.headers(routeArgs) : Promise.resolve(undefined),
    routeModule?.headers
      ? routeModule.headers({ ...routeArgs, data } as any)
      : Promise.resolve(undefined),
  ]);
  if (shellHeaders) applyHeaders(headers, shellHeaders);
  if (routeHeaders) applyHeaders(headers, routeHeaders);
  return headers;
}
