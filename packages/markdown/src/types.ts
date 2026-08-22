import type {
  ContentArtifactGenerator,
  ContentCompileInput,
  ContentLocaleOptions,
  ContentPathContext,
  ContentSource,
  MaybePromise,
  ParsedContent,
} from "@pracht/content";
import type { Marked } from "marked";

export interface MarkdownImageDescriptor {
  source: string;
  alt: string;
  title?: string;
  marker: string;
}

export interface MarkdownImageOptions {
  /** Browser layout hint. Defaults to `100vw`. */
  sizes?: string;
  /** Opt into the build-generated blur placeholder. Defaults to `empty`. */
  placeholder?: "blur" | "empty";
  /** Quality passed to runtime loaders when static variants are unavailable. */
  quality?: number;
}

export interface CompiledMarkdown {
  html: string;
  images: readonly MarkdownImageDescriptor[];
  head?: Record<string, unknown>;
}

export interface MarkdownRenderContext<TFrontmatter extends Record<string, unknown>> {
  html: string;
  input: ContentCompileInput<TFrontmatter>;
}

export interface DefineMarkdownCollectionOptions<
  TFrontmatter extends Record<string, unknown> = Record<string, unknown>,
> {
  name: string;
  root: string | URL;
  sources?: readonly ContentSource[];
  extensions?: readonly string[];
  routeBase?: string;
  route?: (context: ContentPathContext) => string | false;
  locales?: ContentLocaleOptions;
  parse?: (raw: string, source: string) => MaybePromise<ParsedContent<TFrontmatter>>;
  /** Create a fresh parser per document. This keeps custom renderers concurrency-safe. */
  createMarked?: () => Marked;
  /** Wrap or otherwise post-process the compiled Markdown HTML. */
  render?: (context: MarkdownRenderContext<TFrontmatter>) => MaybePromise<string>;
  /** Produce the serializable Pracht head object exported by the route module. */
  head?: (
    context: MarkdownRenderContext<TFrontmatter>,
  ) => MaybePromise<Record<string, unknown> | undefined>;
  images?: MarkdownImageOptions;
  artifacts?: readonly ContentArtifactGenerator<TFrontmatter, CompiledMarkdown>[];
}
