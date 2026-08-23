import {
  NO_LOCALE,
  type NormalizedContentLocales,
  resolveLocaleOrder,
  resolveRequestedLocale,
} from "./locale.ts";
import { normalizeRoutePath } from "./route-path.ts";
import { normalizeSnapshotFields } from "./snapshot.ts";
import type {
  ContentCollection,
  ContentCollectionSnapshot,
  ContentDocument,
  ContentLocaleOptions,
  ContentLookupOptions,
  ContentResolution,
  ContentRouteAlias,
} from "./types.ts";

/** Rehydrate a Vite-generated collection snapshot without filesystem access. */
export function defineSnapshotCollection<
  TFrontmatter extends Record<string, unknown> = Record<string, unknown>,
  TCompiled = string,
>(
  snapshot: ContentCollectionSnapshot<TFrontmatter, TCompiled>,
): ContentCollection<TFrontmatter, TCompiled> {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.documents)) {
    throw new TypeError("defineSnapshotCollection() expects a content collection snapshot.");
  }

  // `raw` and `body` are absent when the collection opted out of embedding
  // them. Every other reader keeps the plain `ContentDocument` shape, so the
  // narrowing stays a documented property of that collection rather than an
  // optional field every consumer has to handle.
  const documents = Object.freeze(
    snapshot.documents.map((document) =>
      Object.freeze({
        ...document,
        frontmatter: Object.freeze({ ...document.frontmatter }),
        source: `virtual:pracht/content/${encodeURIComponent(snapshot.name)}/${document.relativeSource}`,
      }),
    ),
  ) as readonly ContentDocument<TFrontmatter, TCompiled>[];
  const locales = normalizeSnapshotLocales(snapshot.locales);
  const snapshotFields = normalizeSnapshotFields(snapshot.fields);
  const byId = new Map<string, Map<string, ContentDocument<TFrontmatter, TCompiled>>>();
  const byRoute = new Map<string, Map<string, ContentDocument<TFrontmatter, TCompiled>>>();
  const bySource = new Map<string, ContentDocument<TFrontmatter, TCompiled>>();
  const routeAliases = new Map<string, ContentRouteAlias>();

  for (const document of documents) {
    addLookup(byId, document.id, document);
    addLookup(byRoute, document.path, document);
    bySource.set(document.relativeSource, document);
    bySource.set(document.source, document);
  }
  for (const alias of snapshot.routeAliases) routeAliases.set(alias.path, alias);

  const collection: ContentCollection<TFrontmatter, TCompiled> = {
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

    async loadSource(source, raw) {
      const document = bySource.get(cleanSource(source));
      if (!document) {
        throw new Error(
          `Source ${JSON.stringify(source)} is not registered in content collection ${JSON.stringify(snapshot.name)}.`,
        );
      }
      if (raw !== undefined && raw !== document.raw) {
        throw new Error("A generated content snapshot cannot compile updated source text.");
      }
      return document;
    },

    async renderModule() {
      return undefined;
    },

    async emitArtifacts() {
      return [];
    },

    async snapshot() {
      return snapshot;
    },

    invalidate() {},
  };

  async function resolveLookup(
    kind: "id" | "route",
    key: string,
    options: ContentLookupOptions = {},
  ): Promise<ContentResolution<TFrontmatter, TCompiled> | undefined> {
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
  lookup: Map<string, Map<string, ContentDocument<TFrontmatter, TCompiled>>>,
  key: string,
  document: ContentDocument<TFrontmatter, TCompiled>,
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
