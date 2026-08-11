import type { ContentCollection, ContentDocument } from "./types.ts";

export interface ContentLoaderArgs {
  params: Record<string, string>;
  request: Request;
  url?: URL;
}

export interface ContentLoaderOptions<
  TFrontmatter extends Record<string, unknown>,
  TCompiled,
  TOutput,
> {
  /** Resolve the collection route from loader args. Defaults to the request pathname. */
  path?: (args: ContentLoaderArgs) => string;
  locale?: (args: ContentLoaderArgs) => string | undefined;
  select?: (document: ContentDocument<TFrontmatter, TCompiled>) => TOutput;
  /** Called for a missing document. Defaults to throwing a 404 Response. */
  notFound?: (path: string) => unknown;
}

/** Create a structural Pracht loader without coupling the package to @pracht/core. */
export function contentLoader<
  TFrontmatter extends Record<string, unknown>,
  TCompiled,
  TOutput = ContentDocument<TFrontmatter, TCompiled>,
>(
  collection: ContentCollection<TFrontmatter, TCompiled>,
  options: ContentLoaderOptions<TFrontmatter, TCompiled, TOutput> = {},
): (args: ContentLoaderArgs) => Promise<TOutput> {
  return async (args) => {
    const path = options.path?.(args) ?? new URL(args.request.url).pathname;
    const document = await collection.getByRoute(path, { locale: options.locale?.(args) });
    if (!document) {
      if (options.notFound) throw options.notFound(path);
      throw new Response("Not Found", { status: 404 });
    }
    return options.select ? options.select(document) : (document as unknown as TOutput);
  };
}

/** Select the server-only representation a route module exports as `markdown`. */
export function markdownRepresentation<TFrontmatter extends Record<string, unknown>, TCompiled>(
  document: ContentDocument<TFrontmatter, TCompiled>,
  representation: "raw" | "body" = "raw",
): string {
  return representation === "body" ? document.body : document.raw;
}
