export type MaybePromise<T> = T | Promise<T>;

export interface ContentSource {
  /** Locale-neutral identity used for fallback lookup. Derived from the file name when omitted. */
  id?: string;
  /** Public route path. Derived from the file name and routeBase when omitted. */
  path?: string;
  /** File path relative to the collection root. */
  source: string;
  /** Source locale. Defaults to locales.default when localization is configured. */
  locale?: string;
}

export interface ContentLocaleOptions {
  default: string;
  supported: readonly string[];
  /**
   * Locale fallback order. A string/array applies to every non-default locale;
   * a record configures each requested locale independently.
   */
  fallback?: string | readonly string[] | Readonly<Record<string, string | readonly string[]>>;
  /** Detect locale directories while scanning. Defaults to true. */
  sourceDirectories?: boolean;
  /** Prefix generated routes with every locale, only non-default locales, or none. */
  routePrefix?: "always" | "non-default" | "never";
}

export interface ContentPathContext {
  id: string;
  locale?: string;
  relativePath: string;
}

export interface ParsedContent<TFrontmatter extends Record<string, unknown>> {
  body: string;
  frontmatter: TFrontmatter;
}

export interface ContentCompileInput<
  TFrontmatter extends Record<string, unknown>,
> extends ParsedContent<TFrontmatter> {
  id: string;
  locale?: string;
  path: string;
  raw: string;
  relativeSource: string;
  source: string;
}

export interface ContentDocument<
  TFrontmatter extends Record<string, unknown> = Record<string, unknown>,
  TCompiled = string,
> extends ContentCompileInput<TFrontmatter> {
  compiled: TCompiled;
}

export interface ContentArtifact {
  /** Public URL and static output path, for example `/llms.txt`. */
  path: string;
  source: string | Uint8Array;
  /** Valid portable HTTP media type; malformed values and control characters are rejected. */
  contentType?: string;
}

export interface ContentArtifactContext<TFrontmatter extends Record<string, unknown>, TCompiled> {
  collection: ContentCollection<TFrontmatter, TCompiled>;
  documents: readonly ContentDocument<TFrontmatter, TCompiled>[];
}

export type ContentArtifactGenerator<TFrontmatter extends Record<string, unknown>, TCompiled> = (
  context: ContentArtifactContext<TFrontmatter, TCompiled>,
) => MaybePromise<ContentArtifact | readonly ContentArtifact[] | null | undefined>;

export interface DefineCollectionOptions<TFrontmatter extends Record<string, unknown>, TCompiled> {
  name: string;
  /** Absolute path or file URL containing the collection sources. */
  root: string | URL;
  /** Explicit registry. When omitted, the root is scanned recursively. */
  sources?: readonly ContentSource[];
  /** Extensions included during scans. Defaults to `.md` and `.mdx`. */
  extensions?: readonly string[];
  /** Base path for generated routes. Defaults to `/`. */
  routeBase?: string;
  /** Override generated route paths or return false to omit a source. */
  route?: (context: ContentPathContext) => string | false;
  locales?: ContentLocaleOptions;
  parse?: (raw: string, source: string) => MaybePromise<ParsedContent<TFrontmatter>>;
  compile?: (input: ContentCompileInput<TFrontmatter>) => MaybePromise<TCompiled>;
  /** Turn a compiled document into a Vite route module. */
  module?: (document: ContentDocument<TFrontmatter, TCompiled>) => MaybePromise<string>;
  /** Opt-in static files generated from the complete registry. */
  artifacts?: readonly ContentArtifactGenerator<TFrontmatter, TCompiled>[];
  /**
   * Drop source representations from the generated runtime snapshot. Both
   * fields default to true; the authoring collection always keeps them.
   */
  snapshot?: ContentSnapshotOptions;
}

export interface ContentLookupOptions {
  locale?: string;
  /** Defaults to true. */
  fallback?: boolean;
}

export interface ContentResolution<
  TFrontmatter extends Record<string, unknown>,
  TCompiled,
  TDocument extends ContentRuntimeDocument<TFrontmatter, TCompiled> = ContentDocument<
    TFrontmatter,
    TCompiled
  >,
> {
  document: TDocument;
  fallback: boolean;
  requestedLocale?: string;
}

export interface ContentRouteAlias {
  id: string;
  locale: string;
  path: string;
}

/**
 * Which source representations a snapshot embeds. `raw` and `body` are roughly
 * two thirds of a snapshot's size; a collection that never negotiates Markdown
 * or searches bodies can drop them from the server bundle.
 */
export interface ContentSnapshotFields {
  body: boolean;
  raw: boolean;
}

/** Per-collection snapshot trimming. Every field defaults to true. */
export type ContentSnapshotOptions = Partial<ContentSnapshotFields>;

export type ContentSnapshotDocument<
  TFrontmatter extends Record<string, unknown> = Record<string, unknown>,
  TCompiled = string,
> = Omit<ContentDocument<TFrontmatter, TCompiled>, "body" | "raw" | "source"> & {
  /** Absent when the collection was defined with `snapshot: { body: false }`. */
  body?: string;
  /** Absent when the collection was defined with `snapshot: { raw: false }`. */
  raw?: string;
};

/**
 * The representations a snapshot document can defer. Everything else — ids,
 * routes, locales, frontmatter — stays in the index so lookup never needs a
 * chunk it has not loaded.
 */
export interface ContentDocumentPayload<TCompiled = string> {
  compiled: TCompiled;
  body?: string;
  raw?: string;
}

export type ContentDocumentPayloadLoader<TCompiled = string> = () => Promise<
  ContentDocumentPayload<TCompiled> | { default: ContentDocumentPayload<TCompiled> }
>;

/**
 * A document rehydrated from a filesystem-free runtime snapshot. Deferred
 * representations are already resolved: every accessor that hands one out is
 * asynchronous, so a caller never observes a half-loaded document.
 */
export type ContentRuntimeDocument<
  TFrontmatter extends Record<string, unknown> = Record<string, unknown>,
  TCompiled = string,
> = Omit<ContentDocument<TFrontmatter, TCompiled>, "body" | "raw" | "source"> & {
  /** Absent when the collection was defined with `snapshot: { body: false }`. */
  body?: string;
  /** Absent when the collection was defined with `snapshot: { raw: false }`. */
  raw?: string;
  /** Stable virtual identity replacing the authoring collection's absolute source path. */
  source: string;
};

/** Portable, filesystem-free collection data generated by the Vite plugin. */
export interface ContentCollectionSnapshot<
  TFrontmatter extends Record<string, unknown> = Record<string, unknown>,
  TCompiled = string,
> {
  name: string;
  extensions: readonly string[];
  locales?: ContentLocaleOptions;
  /** Omitted when every field is embedded. */
  fields?: ContentSnapshotOptions;
  documents: readonly ContentSnapshotDocument<TFrontmatter, TCompiled>[];
  routeAliases: readonly ContentRouteAlias[];
}

export interface ContentRegistry<
  TFrontmatter extends Record<string, unknown> = Record<string, unknown>,
  TCompiled = string,
  TDocument extends ContentRuntimeDocument<TFrontmatter, TCompiled> = ContentDocument<
    TFrontmatter,
    TCompiled
  >,
> {
  readonly name: string;
  readonly root: string;
  readonly extensions: readonly string[];
  readonly locales?: ContentLocaleOptions;
  /**
   * Which source representations this collection's documents carry. An
   * authoring collection always carries all of them; a snapshot collection
   * reports what `defineCollection({ snapshot })` embedded.
   */
  readonly snapshotFields: ContentSnapshotFields;
  all(): Promise<readonly TDocument[]>;
  iterate(): AsyncGenerator<TDocument, void, void>;
  getById(id: string, options?: ContentLookupOptions): Promise<TDocument | undefined>;
  getByRoute(path: string, options?: ContentLookupOptions): Promise<TDocument | undefined>;
  resolveById(
    id: string,
    options?: ContentLookupOptions,
  ): Promise<ContentResolution<TFrontmatter, TCompiled, TDocument> | undefined>;
  resolveByRoute(
    path: string,
    options?: ContentLookupOptions,
  ): Promise<ContentResolution<TFrontmatter, TCompiled, TDocument> | undefined>;
  getBySource(source: string): Promise<TDocument | undefined>;
  ownsSource(source: string): boolean;
}

export type ContentSnapshotCollection<
  TFrontmatter extends Record<string, unknown> = Record<string, unknown>,
  TCompiled = string,
> = ContentRegistry<TFrontmatter, TCompiled, ContentRuntimeDocument<TFrontmatter, TCompiled>>;

/** Filesystem-backed authoring collection used by compilers and build tooling. */
export interface ContentCollection<
  TFrontmatter extends Record<string, unknown> = Record<string, unknown>,
  TCompiled = string,
> extends ContentRegistry<TFrontmatter, TCompiled, ContentDocument<TFrontmatter, TCompiled>> {
  loadSource(source: string, raw?: string): Promise<ContentDocument<TFrontmatter, TCompiled>>;
  renderModule(source: string, raw?: string): Promise<string | undefined>;
  emitArtifacts(): Promise<readonly ContentArtifact[]>;
  snapshot(): Promise<ContentCollectionSnapshot<TFrontmatter, TCompiled>>;
  invalidate(source?: string): void;
}
