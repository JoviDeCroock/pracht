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
  ContentDocumentPayload,
  ContentLocaleOptions,
  ContentLookupOptions,
  ContentResolution,
  ContentRouteAlias,
  ContentRuntimeDocument,
  ContentSnapshotCollection,
  ContentSnapshotDocument,
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

  type Entry = ContentSnapshotDocument<TFrontmatter, TCompiled> & { source: string };
  type Document = ContentRuntimeDocument<TFrontmatter, TCompiled>;

  const entries: readonly Entry[] = Object.freeze(
    snapshot.documents.map((document) => {
      if (document.compiled === undefined && typeof document.load !== "function") {
        throw new TypeError(
          `defineSnapshotCollection() received a document without compiled output or a loader: ${JSON.stringify(document.relativeSource)}.`,
        );
      }
      return Object.freeze({
        ...document,
        source: `virtual:pracht/content/${encodeURIComponent(snapshot.name)}/${document.relativeSource}`,
      });
    }),
  );
  const locales = normalizeSnapshotLocales(snapshot.locales);
  const snapshotFields = normalizeSnapshotFields(snapshot.fields);
  const byId = new Map<string, Map<string, Entry>>();
  const byRoute = new Map<string, Map<string, Entry>>();
  const bySource = new Map<string, Entry>();
  const routeAliases = new Map<string, ContentRouteAlias>();
  // Materialization is memoized per entry rather than per lookup so concurrent
  // requests for the same document share one chunk load, and a document loaded
  // during prerender stays loaded for the rest of the build.
  const materialized = new Map<Entry, Promise<Document>>();

  for (const document of entries) {
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
      return Object.freeze(await Promise.all(entries.map(materialize)));
    },

    async *iterate() {
      // One document in flight at a time: a caller streaming a large collection
      // should not be forced to hold every deferred chunk in memory at once.
      for (const entry of entries) yield await materialize(entry);
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
      const entry = bySource.get(cleanSource(source));
      return entry && materialize(entry);
    },

    ownsSource(source) {
      return bySource.has(cleanSource(source));
    },
  };

  function materialize(entry: Entry): Promise<Document> {
    let pending = materialized.get(entry);
    if (!pending) {
      pending = loadDocument(entry).catch((error: unknown) => {
        // A transient chunk-load failure must not poison every later lookup.
        materialized.delete(entry);
        throw error;
      });
      materialized.set(entry, pending);
    }
    return pending;
  }

  async function loadDocument(entry: Entry): Promise<Document> {
    const { load, ...document } = entry;
    const payload = load ? unwrapPayload<TCompiled>(await load(), entry.relativeSource) : undefined;
    return Object.freeze({
      ...document,
      ...payload,
      frontmatter: Object.freeze({ ...entry.frontmatter }),
    }) as Document;
  }

  async function resolveLookup(
    kind: "id" | "route",
    key: string,
    options: ContentLookupOptions = {},
  ): Promise<ContentResolution<TFrontmatter, TCompiled, Document> | undefined> {
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
      const entry = localized.get(locale ?? NO_LOCALE);
      if (!entry) continue;
      return {
        document: await materialize(entry),
        fallback: locale !== requestedLocale,
        requestedLocale,
      };
    }
    return undefined;
  }

  return Object.freeze(collection);
}

function unwrapPayload<TCompiled>(
  loaded: ContentDocumentPayload<TCompiled> | { default: ContentDocumentPayload<TCompiled> },
  relativeSource: string,
): ContentDocumentPayload<TCompiled> {
  const payload =
    loaded && typeof loaded === "object" && "default" in loaded
      ? (loaded as { default: ContentDocumentPayload<TCompiled> }).default
      : (loaded as ContentDocumentPayload<TCompiled>);
  if (!payload || typeof payload !== "object" || !("compiled" in payload)) {
    throw new TypeError(
      `Content document ${JSON.stringify(relativeSource)} loaded a payload without compiled output.`,
    );
  }
  return payload;
}

function addLookup<TEntry extends { locale?: string }>(
  lookup: Map<string, Map<string, TEntry>>,
  key: string,
  document: TEntry,
): void {
  const localized = lookup.get(key) ?? new Map<string, TEntry>();
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
