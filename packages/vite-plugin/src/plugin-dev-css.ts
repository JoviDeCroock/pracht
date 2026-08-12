/** Development stylesheet discovery and injection for Vite and adapter-owned servers. */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Connect, EnvironmentModuleNode, ViteDevServer } from "vite";
import type { ModuleRegistry, ResolvedPrachtApp, ResolvedRoute } from "@pracht/core";

import { PRACHT_DEV_MODULE_ID } from "./plugin-assets.ts";

const CSS_MODULE_URL_RE = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;

/**
 * Build the development equivalent of the production CSS manifest for the
 * current route. Vite turns CSS imports into client-side style injection by
 * default; resolving the same imports through the active server environment
 * graphs lets pracht put real stylesheet links in the initial document and
 * avoid a first-paint FOUC.
 */
export async function createDevCssManifest(
  server: ViteDevServer,
  options: {
    app: ResolvedPrachtApp;
    matchAppRoute: (
      app: ResolvedPrachtApp,
      pathname: string,
    ) => { route: ResolvedRoute } | undefined;
    pathname: string;
    registry: ModuleRegistry;
  },
): Promise<Record<string, string[]>> {
  const route = options.matchAppRoute(options.app, options.pathname)?.route ?? options.app.notFound;
  if (!route) return {};

  const manifest: Record<string, string[]> = {};
  const modules = [
    ...(route.shellFile
      ? [{ file: route.shellFile, registry: options.registry.shellModules }]
      : []),
    { file: route.file, registry: options.registry.routeModules },
  ];

  const results = await Promise.all(
    modules.map(async ({ file, registry }) => {
      if (!registry) return { file, urls: [] };
      const moduleKey = findRegistryModuleKey(registry, file);
      if (!moduleKey) return { file, urls: [] };

      // Adapters can name their server environment (for example, Cloudflare
      // does), so inspect every graph instead of assuming `ssr`.
      const entries = await Promise.all(
        Object.values(server.environments).map((environment) =>
          environment.moduleGraph.getModuleByUrl(moduleKey),
        ),
      );
      const urls = [...new Set(entries.flatMap((entry) => collectDevCssUrls(entry)))];
      return { file, urls };
    }),
  );

  for (const { file, urls } of results) {
    if (urls.length > 0) manifest[file] = urls;
  }

  return manifest;
}

function findRegistryModuleKey(
  modules: Record<string, () => Promise<unknown>> | undefined,
  file: string,
): string | undefined {
  if (!modules) return undefined;
  if (file in modules) return file;

  const suffix = `/${file
    .split("?")[0]
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")}`;
  return Object.keys(modules).find((key) => key.split("?")[0].replace(/\\/g, "/").endsWith(suffix));
}

export function collectDevCssUrls(entry: EnvironmentModuleNode | undefined): string[] {
  if (!entry) return [];

  const urls = new Set<string>();
  const visited = new Set<EnvironmentModuleNode>();
  const pending = [entry];

  while (pending.length > 0) {
    const module = pending.pop()!;
    if (visited.has(module)) continue;
    visited.add(module);

    // SSR transforms CSS imports into JavaScript modules, so Vite can label
    // these nodes as `js`. The URL remains the reliable signal for CSS and
    // preprocessor requests; asset/string queries are intentionally excluded.
    if (
      (module.type === "css" || CSS_MODULE_URL_RE.test(module.url)) &&
      !/[?&](?:inline|raw|url)(?:[=&]|$)/.test(module.url)
    ) {
      urls.add(module.url);
    }
    pending.push(...[...module.importedModules].reverse());
  }

  return [...urls];
}

export function injectDevCssLinks(html: string, manifest: Record<string, string[]>): string {
  if (!html.includes("</head>")) return html;

  const urls = [...new Set(Object.values(manifest).flat())];
  const tags = urls
    .map((url) => escapeHtmlAttribute(url))
    .filter((escapedUrl) => !html.includes(`href="${escapedUrl}"`))
    .map((escapedUrl) => `<link rel="stylesheet" href="${escapedUrl}">`);
  if (tags.length === 0) return html;

  return html.replace("</head>", `    ${tags.join("\n    ")}\n  </head>`);
}

export async function injectDevCssForPath(
  server: ViteDevServer,
  path: string,
  html: string,
): Promise<string> {
  const context = await resolveDevCssContextForPath(server, path);
  const manifest = await createDevCssManifest(server, context);
  return injectDevCssLinks(html, manifest);
}

async function resolveDevCssContextForPath(
  server: ViteDevServer,
  path: string,
): Promise<Parameters<typeof createDevCssManifest>[1]> {
  const [framework, serverMod] = await Promise.all([
    server.ssrLoadModule("@pracht/core/server"),
    server.ssrLoadModule(PRACHT_DEV_MODULE_ID),
  ]);
  const pathname = new URL(path, "http://localhost").pathname;
  return {
    app: serverMod.resolvedApp,
    matchAppRoute: framework.matchAppRoute,
    pathname,
    registry: serverMod.registry,
  };
}

/**
 * Adapter-owned dev servers (for example Cloudflare's worker runtime) bypass
 * Vite's HTML transform hooks. Install this before the adapter middleware so
 * document responses still receive the same parser-blocking stylesheet links.
 */
export function createDevCssInjectionMiddleware(server: ViteDevServer): Connect.NextHandleFunction {
  let warned = false;
  return (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const method = (req.method ?? "GET").toUpperCase();
    const accept = readRequestHeader(req.headers.accept).toLowerCase();
    if (method !== "GET" || !accept.includes("text/html")) {
      next();
      return;
    }

    // Resolve the route before the adapter begins its request. Remote dev
    // runtimes can serialize module-runner work while a response is open. CSS
    // traversal itself waits until res.end(), after that runtime has populated
    // its environment graph with the matched route and shell.
    const contextPromise = resolveDevCssContextForPath(server, req.url ?? "/").catch((error) => {
      if (!warned) {
        warned = true;
        server.config.logger.warn(
          `[pracht] Could not discover development stylesheets: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    });
    const chunks: Buffer[] = [];
    const originalEnd = res.end.bind(res);
    const originalWriteHead = res.writeHead.bind(res);

    res.writeHead = ((statusCode: number, ...args: unknown[]) => {
      res.removeHeader("content-length");
      return Reflect.apply(originalWriteHead, res, [
        statusCode,
        ...args.map(stripContentLengthHeader),
      ]);
    }) as typeof res.writeHead;

    res.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
      chunks.push(toBuffer(chunk, encodingOrCallback));
      const done: (() => void) | undefined =
        typeof encodingOrCallback === "function"
          ? (encodingOrCallback as () => void)
          : typeof callback === "function"
            ? (callback as () => void)
            : undefined;
      done?.();
      return true;
    }) as typeof res.write;

    res.end = ((chunk?: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
      if (chunk != null) chunks.push(toBuffer(chunk, encodingOrCallback));
      const done: (() => void) | undefined =
        typeof encodingOrCallback === "function"
          ? (encodingOrCallback as () => void)
          : typeof callback === "function"
            ? (callback as () => void)
            : undefined;

      void (async () => {
        const body = Buffer.concat(chunks);
        const contentType = String(res.getHeader("content-type") ?? "");
        if (!contentType.includes("text/html")) {
          originalEnd(body, done);
          return;
        }

        try {
          const context = await contextPromise;
          const manifest = context ? await createDevCssManifest(server, context) : null;
          const html = manifest
            ? injectDevCssLinks(body.toString("utf-8"), manifest)
            : body.toString("utf-8");
          originalEnd(html, done);
        } catch {
          originalEnd(body, done);
        }
      })();

      return res;
    }) as typeof res.end;

    next();
  };
}

function toBuffer(chunk: unknown, encoding: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(
    String(chunk),
    typeof encoding === "string" ? (encoding as BufferEncoding) : undefined,
  );
}

function stripContentLengthHeader(value: unknown): unknown {
  if (Array.isArray(value)) {
    const headers: unknown[] = [];
    for (let index = 0; index < value.length; index += 2) {
      if (String(value[index]).toLowerCase() !== "content-length") {
        headers.push(value[index], value[index + 1]);
      }
    }
    return headers;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([name]) => name.toLowerCase() !== "content-length"),
    );
  }

  return value;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readRequestHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(", ") : (value ?? "");
}
