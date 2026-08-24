import {
  NO_LOCALE,
  type NormalizedContentLocales,
  resolveLocaleOrder,
  resolveRequestedLocale,
} from "./locale.ts";
import { normalizeRoutePath } from "./route-path.ts";
import { normalizeSnapshotFields } from "./snapshot.ts";
import type {
  ContentCollectionSnapshot,
  ContentLocaleOptions,
  ContentLookupOptions,
  ContentResolution,
  ContentRouteAlias,
  ContentRuntimeDocument,
  ContentSnapshotCollection,
} from "./types.ts";

export { contentLoader, markdownRepresentation } from "./integrations.ts";
export type { ContentLoaderArgs, ContentLoaderOptions } from "./integrations.ts";

/** Rehydrate a Vite-generated collection snapshot without filesystem access. */
export function defineSnapshotCollection<
  TFrontmatter extends Record<string, unknown> = Record<string, unknown>,
  TCompiled = string,
>(
  snapshot: ContentCollectionSnapshot<TFrontmatter, TCompiled>,
): ContentSnapshotCollection<TFrontmatter, TCompiled> {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.documents)) {
    throw new TypeError("defineSnapshotCollection() expects a content collection snapshot.");
  }

  const documents: readonly ContentRuntimeDocument<TFrontmatter, TCompiled>[] = Object.freeze(
    snapshot.documents.map((document) =>
      Object.freeze({
        ...document,
        frontmatter: Object.freeze({ ...document.frontmatter }),
        source: `virtual:pracht/content/${encodeURIComponent(snapshot.name)}/${document.relativeSource}`,
      }),
    ),
  );
  const locales = normalizeSnapshotLocales(snapshot.locales);
  const snapshotFields = normalizeSnapshotFields(snapshot.fields);
  const byId = new Map<string, Map<string, ContentRuntimeDocument<TFrontmatter, TCompiled>>>();
  const byRoute = new Map<string, Map<string, ContentRuntimeDocument<TFrontmatter, TCompiled>>>();
  const bySource = new Map<string, ContentRuntimeDocument<TFrontmatter, TCompiled>>();
  const routeAliases = new Map<string, ContentRouteAlias>();

  for (const document of documents) {
    addLookup(byId, document.id, document);
    addLookup(byRoute, document.path, document);
    bySource.set(document.relativeSource, document);
    bySource.set(document.source, document);
  }
  for (const alias of snapshot.routeAliases) routeAliases.set(alias.path, alias);

  const collection: ContentSnapshotCollection<TFrontmatter, TCompiled> = {
    name: snapshot.name,
    root: `virtual:pracht/content/${encodeURIComponent(snapshot.name)}`,
    extensions: Object.freeze([...snapshot.extensions]),
    locales,
    snapshotFields,

    async all() {
      return documents;
    },

    async *iterate() {
      yield* documents;
    },

    async getById(id, options) {
      return (await resolveLookup("id", id, options))?.document;
    },

    async getByRoute(path, options) {
      return (await resolveLookup("route", normalizeRoutePath(path), options))?.document;
    },

    async resolveById(id, options) {
      return resolveLookup("id", id, options);
    },

    async resolveByRoute(path, options) {
      return resolveLookup("route", normalizeRoutePath(path), options);
    },

    async getBySource(source) {
      return bySource.get(cleanSource(source));
    },

    ownsSource(source) {
      return bySource.has(cleanSource(source));
    },
  };

  async function resolveLookup(
    kind: "id" | "route",
    key: string,
    options: ContentLookupOptions = {},
  ): Promise<
    | ContentResolution<TFrontmatter, TCompiled, ContentRuntimeDocument<TFrontmatter, TCompiled>>
    | undefined
  > {
    const directRoute = kind === "route" ? byRoute.get(key) : undefined;
    const alias = kind === "route" && !directRoute ? routeAliases.get(key) : undefined;
    const localized =
      kind === "id" ? byId.get(key) : (directRoute ?? (alias ? byId.get(alias.id) : undefined));
    if (!localized) return undefined;

    const requestedLocale = resolveRequestedLocale(
      options.locale ?? alias?.locale,
      locales,
      localized,
      kind === "route" && locales?.routePrefix !== "never",
    );
    for (const locale of resolveLocaleOrder(requestedLocale, options.fallback !== false, locales)) {
      const document = localized.get(locale ?? NO_LOCALE);
      if (!document) continue;
      return { document, fallback: locale !== requestedLocale, requestedLocale };
    }
    return undefined;
  }

  return Object.freeze(collection);
}

function addLookup<TFrontmatter extends Record<string, unknown>, TCompiled>(
  lookup: Map<string, Map<string, ContentRuntimeDocument<TFrontmatter, TCompiled>>>,
  key: string,
  document: ContentRuntimeDocument<TFrontmatter, TCompiled>,
): void {
  const localized = lookup.get(key) ?? new Map();
  localized.set(document.locale ?? NO_LOCALE, document);
  lookup.set(key, localized);
}

function cleanSource(source: string): string {
  return source.split("?")[0].replace(/^\.\//, "");
}

function normalizeSnapshotLocales(
  locales: ContentLocaleOptions | undefined,
): NormalizedContentLocales | undefined {
  return locales ? { ...locales, supported: Object.freeze([...locales.supported]) } : undefined;
}
