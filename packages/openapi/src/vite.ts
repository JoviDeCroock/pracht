import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Connect, Plugin, ViteDevServer } from "vite";

import type { OpenApiDocumentOptions, OpenApiInfo } from "./types.ts";
import type { OpenApiUiProvider } from "./ui.ts";

const PRACHT_SERVER_MODULE_ID = "virtual:pracht/server";
const PRACHT_DEV_MODULE_ID = "virtual:pracht/dev-metadata";

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

interface ResolvedPrachtOpenApiOptions {
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

/**
 * Add live OpenAPI JSON/reference endpoints and matching static build assets
 * without changing ordinary Pracht route authoring.
 */
export function prachtOpenApi(options: PrachtOpenApiOptions): Plugin {
  const resolved = resolvePrachtOpenApiOptions(options);
  const warned = new Set<string>();
  let buildBase = "/";

  return {
    name: "pracht:openapi",

    configResolved(config) {
      buildBase = normalizeBuildBase(config.base);
    },

    configureServer(server) {
      warnPublicArtifactCollisions(server, resolved);
      server.middlewares.use(createOpenApiDevMiddleware(server, resolved, warned));
    },

    transform(code, id) {
      if (!isPrachtGraphModule(id)) return null;
      return {
        code: `${code}\n${createOpenApiServerModuleSource(resolved, buildBase)}`,
        map: null,
      };
    },
  };
}

function normalizeBuildBase(raw: unknown): string {
  if (typeof raw !== "string" || raw === "" || raw === "." || raw === "./") return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw.endsWith("/") ? raw : `${raw}/`;
}

export function resolvePrachtOpenApiOptions(
  options: PrachtOpenApiOptions,
): ResolvedPrachtOpenApiOptions {
  if (!options || typeof options !== "object") {
    throw new TypeError("prachtOpenApi() expects an options object.");
  }
  if (!options.info || typeof options.info.title !== "string" || !options.info.title.trim()) {
    throw new TypeError("prachtOpenApi() info.title must be a non-empty string.");
  }
  if (typeof options.info.version !== "string" || !options.info.version.trim()) {
    throw new TypeError("prachtOpenApi() info.version must be a non-empty string.");
  }

  const documentPath = normalizeEndpointPath(
    options.documentPath ?? "/openapi.json",
    "documentPath",
  );
  if (!documentPath.endsWith(".json")) {
    throw new TypeError(
      "prachtOpenApi() documentPath must end in .json so static hosts send the correct media type.",
    );
  }
  const ui = resolveUiOptions(options.ui);
  if (ui) {
    const documentOutputPath = documentPath.slice(1);
    const uiOutputPath = `${ui.path.slice(1)}/index.html`;
    if (outputPathsOverlap(documentOutputPath, uiOutputPath)) {
      throw new TypeError(
        "prachtOpenApi() UI and document paths must not overlap in static build output.",
      );
    }
  }

  return {
    documentPath,
    document: options.document ? { ...options.document } : {},
    failOnWarnings: options.failOnWarnings ?? false,
    info: { ...options.info },
    ui,
  };
}

function resolveUiOptions(value: PrachtOpenApiOptions["ui"]): ResolvedPrachtOpenApiOptions["ui"] {
  if (value === undefined || value === false) return null;
  if (value === "scalar" || value === "swagger") {
    return { path: "/docs", provider: value };
  }
  if (!value || typeof value !== "object") {
    throw new TypeError(
      'prachtOpenApi() ui must be false, "scalar", "swagger", or an options object.',
    );
  }
  if (value.provider !== "scalar" && value.provider !== "swagger") {
    throw new TypeError('prachtOpenApi() ui.provider must be "scalar" or "swagger".');
  }
  if (value.provider === "scalar" && value.styleUrl !== undefined) {
    throw new TypeError("prachtOpenApi() ui.styleUrl is only supported by Swagger UI.");
  }
  return {
    ...value,
    path: normalizeEndpointPath(value.path ?? "/docs", "ui.path"),
  };
}

function normalizeEndpointPath(path: string, name: string): string {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    pathHasUnsafeSegment(path)
  ) {
    throw new TypeError(`prachtOpenApi() ${name} must be a safe root-relative URL path.`);
  }
  const canonicalPath = new URL(path, "http://pracht.local").pathname.replace(/\/{2,}/g, "/");
  const normalized = canonicalPath.length > 1 ? canonicalPath.replace(/\/+$/, "") : canonicalPath;
  if (normalized === "/") {
    throw new TypeError(`prachtOpenApi() ${name} must not replace the app root.`);
  }
  return normalized;
}

function outputPathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function pathHasUnsafeSegment(path: string): boolean {
  try {
    return path.split("/").some((segment) => {
      const decoded = decodeURIComponent(segment);
      return (
        decoded === "." ||
        decoded === ".." ||
        decoded.includes("/") ||
        decoded.includes("\\") ||
        hasControlCharacter(decoded)
      );
    });
  } catch {
    return true;
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

function isPrachtGraphModule(id: string): boolean {
  const normalized = (id.charCodeAt(0) === 0 ? id.slice(1) : id).split("?")[0];
  return normalized === PRACHT_SERVER_MODULE_ID || normalized === PRACHT_DEV_MODULE_ID;
}

function createOpenApiServerModuleSource(
  options: ResolvedPrachtOpenApiOptions,
  buildBase = "/",
): string {
  const serializable = {
    buildBase,
    documentPath: options.documentPath,
    document: options.document,
    failOnWarnings: options.failOnWarnings,
    info: options.info,
    ui: options.ui,
  };
  return [
    '// Generated by the opt-in "@pracht/openapi/vite" companion plugin.',
    'import { createOpenApiUiHtml as __prachtCreateOpenApiUiHtml, generateOpenApiDocument as __prachtGenerateOpenApiDocument } from "@pracht/openapi";',
    `const __prachtOpenApiConfig = ${JSON.stringify(serializable)};`,
    "async function __prachtLoadOpenApiRoute(file) {",
    "  const load = apiModules[file];",
    '  if (typeof load !== "function") {',
    "    throw new Error(`No API module importer exists for ${JSON.stringify(file)}.`);",
    "  }",
    "  return load();",
    "}",
    "export async function generatePrachtOpenApiArtifacts() {",
    "  const documentOptions = { ...__prachtOpenApiConfig.document };",
    '  if (__prachtOpenApiConfig.buildBase !== "/" && documentOptions.servers === undefined) {',
    "    documentOptions.servers = [{ url: __prachtOpenApiConfig.buildBase.slice(0, -1) }];",
    "  }",
    "  const result = await __prachtGenerateOpenApiDocument({",
    "    info: __prachtOpenApiConfig.info,",
    "    document: documentOptions,",
    "    routes: apiRoutes,",
    "    loadModule: __prachtLoadOpenApiRoute,",
    "  });",
    "  if (__prachtOpenApiConfig.failOnWarnings && result.warnings.length > 0) {",
    '    const summary = result.warnings.map((warning) => `${warning.method ? warning.method + " " : ""}${warning.path}: ${warning.message}`).join("\\n");',
    "    throw new Error(`OpenAPI generation produced ${result.warnings.length} warning(s):\\n${summary}`);",
    "  }",
    "  const artifacts = [{",
    "    path: __prachtOpenApiConfig.documentPath,",
    "    outputPath: __prachtOpenApiConfig.documentPath.slice(1),",
    '    contentType: "application/json; charset=utf-8",',
    '    content: JSON.stringify(result.document, null, 2) + "\\n",',
    "  }];",
    "  if (__prachtOpenApiConfig.ui) {",
    "    artifacts.push({",
    "      path: __prachtOpenApiConfig.ui.path,",
    '      outputPath: __prachtOpenApiConfig.ui.path.slice(1) + "/index.html",',
    '      contentType: "text/html; charset=utf-8",',
    "      content: __prachtCreateOpenApiUiHtml({",
    "        ...__prachtOpenApiConfig.ui,",
    '        documentUrl: __prachtOpenApiConfig.buildBase === "/" ? __prachtOpenApiConfig.documentPath : __prachtOpenApiConfig.buildBase + __prachtOpenApiConfig.documentPath.slice(1),',
    '        title: __prachtOpenApiConfig.ui.title ?? __prachtOpenApiConfig.info.title + " API reference",',
    "      }),",
    "    });",
    "  }",
    "  return { artifacts, warnings: result.warnings };",
    "}",
    "",
  ].join("\n");
}

function createOpenApiDevMiddleware(
  server: ViteDevServer,
  options: ResolvedPrachtOpenApiOptions,
  warned: Set<string>,
): Connect.NextHandleFunction {
  const endpointPaths = new Set([
    options.documentPath,
    ...(options.ui ? [options.ui.path, `${options.ui.path}/`] : []),
  ]);

  return async (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    if (!endpointPaths.has(requestUrl.pathname)) return next();

    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("allow", "GET, HEAD");
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return;
    }

    try {
      const [framework, serverModule] = await Promise.all([
        server.ssrLoadModule("@pracht/core/server"),
        server.ssrLoadModule(PRACHT_DEV_MODULE_ID),
      ]);
      const collisionKey = `route:${requestUrl.pathname}`;
      if (
        !warned.has(collisionKey) &&
        (framework.matchAppRoute?.(serverModule.resolvedApp, requestUrl.pathname) ||
          framework.matchApiRoute?.(serverModule.apiRoutes, requestUrl.pathname))
      ) {
        warned.add(collisionKey);
        server.config.logger.warn(
          `[pracht:openapi] An app route matches reserved path ${requestUrl.pathname}. ` +
            "The OpenAPI endpoint wins while the companion plugin is enabled.",
        );
      }
      const generate = serverModule.generatePrachtOpenApiArtifacts;
      if (typeof generate !== "function") {
        throw new Error(
          "OpenAPI graph hook is missing. Place prachtOpenApi() after pracht() in vite.config.ts.",
        );
      }
      const result = (await generate()) as PrachtOpenApiArtifacts;
      for (const warning of result.warnings) {
        const key = JSON.stringify(warning);
        if (warned.has(key)) continue;
        warned.add(key);
        server.config.logger.warn(
          `[pracht:openapi] ${warning.method ? `${warning.method} ` : ""}${warning.path}: ${warning.message}`,
        );
      }

      const canonicalPath = requestUrl.pathname.endsWith("/")
        ? requestUrl.pathname.slice(0, -1)
        : requestUrl.pathname;
      const artifact = result.artifacts.find((candidate) => candidate.path === canonicalPath);
      if (!artifact) return next();

      res.statusCode = 200;
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-type", artifact.contentType);
      res.setHeader("x-content-type-options", "nosniff");
      res.end(method === "HEAD" ? undefined : artifact.content);
    } catch (error) {
      if (error instanceof Error) server.ssrFixStacktrace(error);
      server.config.logger.error(
        `[pracht:openapi] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      res.statusCode = 500;
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("OpenAPI generation failed");
    }
  };
}

function warnPublicArtifactCollisions(
  server: ViteDevServer,
  options: ResolvedPrachtOpenApiOptions,
): void {
  if (typeof server.config.publicDir !== "string") return;
  const outputPaths = [
    options.documentPath.slice(1),
    ...(options.ui ? [`${options.ui.path.slice(1)}/index.html`] : []),
  ];
  for (const outputPath of outputPaths) {
    if (!existsSync(join(server.config.publicDir, outputPath))) continue;
    server.config.logger.warn(
      `[pracht:openapi] public/${outputPath} collides with a generated OpenAPI artifact. ` +
        "The companion endpoint wins in development and pracht build replaces the public file.",
    );
  }
}
