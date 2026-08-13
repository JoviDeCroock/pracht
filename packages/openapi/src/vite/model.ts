import type { OpenApiDocumentOptions, OpenApiInfo } from "../types.ts";
import type { OpenApiUiProvider } from "../ui.ts";

export interface PrachtOpenApiUiOptions {
  provider: OpenApiUiProvider;
  /** URL path for the reference page. Defaults to `/docs`. */
  path?: string;
  title?: string;
  /** Override the provider's pinned jsDelivr browser bundle. */
  scriptUrl?: string;
  /** Swagger UI only. Override the provider's pinned jsDelivr stylesheet. */
  styleUrl?: string;
}

export interface PrachtOpenApiOptions {
  info: OpenApiInfo;
  /** Document-level servers, tags, security schemes, and reusable components. */
  document?: OpenApiDocumentOptions;
  /** JSON endpoint and emitted asset path. Defaults to `/openapi.json`. */
  documentPath?: string;
  /** Opt into a static Scalar or Swagger UI page backed by the JSON endpoint. */
  ui?: false | OpenApiUiProvider | PrachtOpenApiUiOptions;
  /** Turn best-effort generation warnings into build/dev request failures. */
  failOnWarnings?: boolean;
}

export interface ResolvedPrachtOpenApiOptions {
  documentPath: string;
  document: OpenApiDocumentOptions;
  failOnWarnings: boolean;
  info: OpenApiInfo;
  ui:
    | (Required<Pick<PrachtOpenApiUiOptions, "path" | "provider">> &
        Omit<PrachtOpenApiUiOptions, "path" | "provider">)
    | null;
}

export interface PrachtOpenApiArtifact {
  content: string;
  contentType: string;
  outputPath: string;
  path: string;
}

export interface PrachtOpenApiArtifacts {
  artifacts: PrachtOpenApiArtifact[];
  warnings: Array<{ code: string; file: string; message: string; method?: string; path: string }>;
}
