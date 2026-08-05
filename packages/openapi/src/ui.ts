export type OpenApiUiProvider = "scalar" | "swagger";

export interface CreateOpenApiUiHtmlOptions {
  provider: OpenApiUiProvider;
  documentUrl: string;
  title?: string;
  /**
   * Override the browser bundle URL. Pin this in production when the default
   * CDN delivery is acceptable, or self-host the corresponding bundle.
   */
  scriptUrl?: string;
  /** Swagger UI only. Override the stylesheet URL to self-host its assets. */
  styleUrl?: string;
}

const DEFAULT_SCALAR_SCRIPT =
  "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.64.0/dist/browser/standalone.js";
const DEFAULT_SWAGGER_SCRIPT =
  "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.32.12/swagger-ui-bundle.js";
const DEFAULT_SWAGGER_STYLE = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.32.12/swagger-ui.css";

/** Create a small, static HTML shell that reads the generated OpenAPI JSON endpoint. */
export function createOpenApiUiHtml(options: CreateOpenApiUiHtmlOptions): string {
  assertAbsolutePath(options.documentUrl, "documentUrl");
  const title = escapeHtml(options.title?.trim() || "API reference");

  if (options.provider === "scalar") {
    const scriptUrl = escapeHtml(options.scriptUrl ?? DEFAULT_SCALAR_SCRIPT);
    const configuration = scriptJson({ url: options.documentUrl });
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body>
    <div id="api-reference"></div>
    <script src="${scriptUrl}"></script>
    <script>
      Scalar.createApiReference("#api-reference", ${configuration});
    </script>
  </body>
</html>
`;
  }

  const scriptUrl = escapeHtml(options.scriptUrl ?? DEFAULT_SWAGGER_SCRIPT);
  const styleUrl = escapeHtml(options.styleUrl ?? DEFAULT_SWAGGER_STYLE);
  const configuration = scriptJson({
    deepLinking: true,
    dom_id: "#swagger-ui",
    url: options.documentUrl,
    validatorUrl: null,
  });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="${styleUrl}" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${scriptUrl}" crossorigin></script>
    <script>
      SwaggerUIBundle(${configuration});
    </script>
  </body>
</html>
`;
}

function assertAbsolutePath(value: string, name: string): void {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(`createOpenApiUiHtml() ${name} must be a root-relative URL path.`);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }

  return false;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
