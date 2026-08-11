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
}

export interface ContentLookupOptions {
  locale?: string;
  /** Defaults to true. */
  fallback?: boolean;
}

export interface ContentResolution<TFrontmatter extends Record<string, unknown>, TCompiled> {
  document: ContentDocument<TFrontmatter, TCompiled>;
  fallback: boolean;
  requestedLocale?: string;
}

export interface ContentCollection<
  TFrontmatter extends Record<string, unknown> = Record<string, unknown>,
  TCompiled = string,
> {
  readonly name: string;
  readonly root: string;
  readonly extensions: readonly string[];
  all(): Promise<readonly ContentDocument<TFrontmatter, TCompiled>[]>;
  iterate(): AsyncGenerator<ContentDocument<TFrontmatter, TCompiled>, void, void>;
  getById(
    id: string,
    options?: ContentLookupOptions,
  ): Promise<ContentDocument<TFrontmatter, TCompiled> | undefined>;
  getByRoute(
    path: string,
    options?: ContentLookupOptions,
  ): Promise<ContentDocument<TFrontmatter, TCompiled> | undefined>;
  resolveById(
    id: string,
    options?: ContentLookupOptions,
  ): Promise<ContentResolution<TFrontmatter, TCompiled> | undefined>;
  resolveByRoute(
    path: string,
    options?: ContentLookupOptions,
  ): Promise<ContentResolution<TFrontmatter, TCompiled> | undefined>;
  getBySource(source: string): Promise<ContentDocument<TFrontmatter, TCompiled> | undefined>;
  ownsSource(source: string): boolean;
  loadSource(source: string, raw?: string): Promise<ContentDocument<TFrontmatter, TCompiled>>;
  renderModule(source: string, raw?: string): Promise<string | undefined>;
  emitArtifacts(): Promise<readonly ContentArtifact[]>;
  invalidate(source?: string): void;
}
