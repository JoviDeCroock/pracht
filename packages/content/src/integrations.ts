import { normalizeRoutePath } from "./route-path.ts";
import type { ContentDocument, ContentRegistry, ContentRuntimeDocument } from "./types.ts";

export interface ContentLoaderArgs {
  params: Record<string, string>;
  request: Request;
  url?: URL;
  /** Matched route pathname with the configured deployment base removed. */
  pathname?: string;
}

export interface ContentLoaderOptions<
  TFrontmatter extends Record<string, unknown>,
  TCompiled,
  TOutput,
  TDocument extends ContentRuntimeDocument<TFrontmatter, TCompiled> = ContentDocument<
    TFrontmatter,
    TCompiled
  >,
> {
  /** Resolve the collection route from loader args. Defaults to the matched route pathname. */
  path?: (args: ContentLoaderArgs) => string;
  locale?: (args: ContentLoaderArgs) => string | undefined;
  select?: (document: TDocument) => TOutput;
  /** Called for a missing document. Defaults to throwing a 404 Response. */
  notFound?: (path: string) => unknown;
}

/** Create a structural Pracht loader without coupling the package to @pracht/core. */
export function contentLoader<
  TFrontmatter extends Record<string, unknown>,
  TCompiled,
  TDocument extends ContentRuntimeDocument<TFrontmatter, TCompiled> = ContentDocument<
    TFrontmatter,
    TCompiled
  >,
  TOutput = TDocument,
>(
  collection: ContentRegistry<TFrontmatter, TCompiled, TDocument>,
  options: ContentLoaderOptions<TFrontmatter, TCompiled, TOutput, TDocument> = {},
): (args: ContentLoaderArgs) => Promise<TOutput> {
  return async (args) => {
    const path = options.path?.(args) ?? args.pathname ?? new URL(args.request.url).pathname;
    function missing(): never {
      if (options.notFound) throw options.notFound(path);
      throw new Response("Not Found", { status: 404 });
    }

    // A dynamic app route such as `/docs/:slug` happily matches and forwards an
    // attacker-shaped pathname like `/docs/%2e%2e`. Route normalization rejects
    // those, which would surface as a 500; they name no document, so answer
    // exactly as a missing one does.
    let route: string;
    try {
      route = normalizeRoutePath(path);
    } catch {
      missing();
    }
    const locale = options.locale?.(args);
    if (
      locale !== undefined &&
      collection.locales &&
      !collection.locales.supported.includes(locale)
    ) {
      missing();
    }
    const document = await collection.getByRoute(route, { locale });
    if (!document) missing();
    return options.select ? options.select(document) : (document as unknown as TOutput);
  };
}

/** Select the server-only representation a route module exports as `markdown`. */
export function markdownRepresentation<TFrontmatter extends Record<string, unknown>, TCompiled>(
  document: Pick<ContentRuntimeDocument<TFrontmatter, TCompiled>, "body" | "raw">,
  representation: "raw" | "body" = "raw",
): string {
  const value = representation === "body" ? document.body : document.raw;
  if (typeof value !== "string") {
    throw new Error(
      `markdownRepresentation() needs document ${representation}, but this runtime snapshot omitted it. ` +
        `Enable \`snapshot: { ${representation}: true }\` for the collection or select an embedded representation.`,
    );
  }
  return value;
}
