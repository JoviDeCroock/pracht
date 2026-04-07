import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";

import type { PreviteAdapter } from "@previte/vite-plugin";
import {
  applyDefaultSecurityHeaders,
  handlePreviteRequest,
  type HandlePreviteRequestOptions,
  type ISGManifestEntry,
  type ModuleRegistry,
  type ResolvedApiRoute,
  type PreviteApp,
} from "previte";

export interface NodeAdapterContextArgs {
  request: Request;
  req: IncomingMessage;
  res: ServerResponse;
}

export interface NodeAdapterOptions<TContext = unknown> {
  app: PreviteApp;
  registry?: ModuleRegistry;
  staticDir?: string;
  viteManifest?: unknown;
  isgManifest?: Record<string, ISGManifestEntry>;
  apiRoutes?: ResolvedApiRoute[];
  clientEntryUrl?: string;
  cssUrls?: string[];
  cssManifest?: Record<string, string[]>;
  jsManifest?: Record<string, string[]>;
  createContext?: (args: NodeAdapterContextArgs) => TContext | Promise<TContext>;
}

export interface NodeServerEntryModuleOptions {
  port?: number;
}

export function createNodeRequestHandler<TContext = unknown>(
  options: NodeAdapterOptions<TContext>,
) {
  const isgManifest = options.isgManifest ?? {};
  const staticDir = options.staticDir;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let request: Request;
    try {
      request = await createWebRequest(req);
    } catch (err) {
      if (err instanceof Error && err.message === "Request body too large") {
        res.statusCode = 413;
        res.end("Payload Too Large");
        return;
      }
      throw err;
    }
    const url = new URL(request.url);

    // --- ISG stale-while-revalidate for GET requests ---
    if (staticDir && request.method === "GET" && url.pathname in isgManifest) {
      const entry = isgManifest[url.pathname];
      const htmlPath =
        url.pathname === "/"
          ? join(staticDir, "index.html")
          : join(staticDir, url.pathname, "index.html");

      if (existsSync(htmlPath)) {
        const stat = statSync(htmlPath);
        const ageMs = Date.now() - stat.mtimeMs;
        const isStale = entry.revalidate.kind === "time" && ageMs > entry.revalidate.seconds * 1000;

        // Serve the cached file
        const html = await readFile(htmlPath, "utf-8");
        res.statusCode = 200;
        const headers = applyDefaultSecurityHeaders(
          new Headers({
            "content-type": "text/html; charset=utf-8",
            "x-previte-isg": isStale ? "stale" : "fresh",
          }),
        );
        headers.forEach((value, key) => {
          res.setHeader(key, value);
        });
        res.end(html);

        // Background regeneration if stale
        if (isStale) {
          regenerateISGPage(options, url.pathname, htmlPath).catch((err) => {
            console.error(`ISG regeneration failed for ${url.pathname}:`, err);
          });
        }

        return;
      }
    }

    const context = options.createContext
      ? await options.createContext({ request, req, res })
      : undefined;

    const response = await handlePreviteRequest({
      app: options.app,
      context,
      registry: options.registry,
      request,
      apiRoutes: options.apiRoutes,
      clientEntryUrl: options.clientEntryUrl,
      cssManifest: options.cssManifest,
      jsManifest: options.jsManifest,
    } satisfies HandlePreviteRequestOptions<TContext>);

    // Cache ISG responses on first render
    if (
      staticDir &&
      request.method === "GET" &&
      url.pathname in isgManifest &&
      response.status === 200
    ) {
      const html = await response.clone().text();
      const htmlPath =
        url.pathname === "/"
          ? join(staticDir, "index.html")
          : join(staticDir, url.pathname, "index.html");
      mkdirSync(dirname(htmlPath), { recursive: true });
      writeFileSync(htmlPath, html, "utf-8");
    }

    await writeWebResponse(res, response);
  };
}

async function regenerateISGPage<TContext>(
  options: NodeAdapterOptions<TContext>,
  pathname: string,
  htmlPath: string,
): Promise<void> {
  const url = new URL(pathname, "http://localhost");
  const request = new Request(url, { method: "GET" });

  const response = await handlePreviteRequest({
    app: options.app,
    registry: options.registry,
    request,
    clientEntryUrl: options.clientEntryUrl,
    cssManifest: options.cssManifest,
    jsManifest: options.jsManifest,
  });

  if (response.status === 200) {
    const html = await response.text();
    mkdirSync(dirname(htmlPath), { recursive: true });
    writeFileSync(htmlPath, html, "utf-8");
  }
}

export function createNodeServerEntryModule(options: NodeServerEntryModuleOptions = {}): string {
  const port = options.port ?? 3000;

  return [
    'import { existsSync, readFileSync } from "node:fs";',
    'import { createServer } from "node:http";',
    'import { dirname, resolve } from "node:path";',
    'import { fileURLToPath, pathToFileURL } from "node:url";',
    'import { createNodeRequestHandler } from "@previte/adapter-node";',
    "",
    "const serverDir = dirname(fileURLToPath(import.meta.url));",
    'const staticDir = resolve(serverDir, "../client");',
    'const isgManifestPath = resolve(serverDir, "isg-manifest.json");',
    "const isgManifest = existsSync(isgManifestPath)",
    '  ? JSON.parse(readFileSync(isgManifestPath, "utf-8"))',
    "  : {};",
    "",
    "export const handler = createNodeRequestHandler({",
    "  app: resolvedApp,",
    "  registry,",
    "  staticDir,",
    "  isgManifest,",
    "  apiRoutes,",
    "  clientEntryUrl: clientEntryUrl ?? undefined,",
    "  cssManifest,",
    "  jsManifest,",
    "});",
    "",
    "const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;",
    "if (entryHref && import.meta.url === entryHref) {",
    "  const server = createServer(handler);",
    `  const port = Number(process.env.PORT ?? ${port});`,
    "  server.listen(port, () => {",
    "    console.log(`previte node server listening on http://localhost:${port}`);",
    "  });",
    "}",
    "",
  ].join("\n");
}

async function createWebRequest(req: IncomingMessage): Promise<Request> {
  const protocol = getFirstHeaderValue(req.headers["x-forwarded-proto"]) ?? "http";
  const host = getFirstHeaderValue(req.headers.host) ?? "localhost";
  const url = new URL(req.url ?? "/", `${protocol}://${host}`);
  const method = req.method ?? "GET";
  const headers = createHeaders(req.headers);
  const init: RequestInit = {
    headers,
    method,
  };

  if (!BODYLESS_METHODS.has(method.toUpperCase())) {
    const body = await readRequestBody(req);
    if (body.byteLength > 0) {
      const exactBody = new Uint8Array(body.byteLength);
      exactBody.set(body);
      init.body = exactBody.buffer;
    }
  }

  return new Request(url, init);
}

function createHeaders(headers: IncomingMessage["headers"]): Headers {
  const result = new Headers();

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "undefined") {
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        result.append(key, entry);
      }

      continue;
    }

    result.set(key, value);
  }

  return result;
}

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

async function readRequestBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    totalSize += buf.byteLength;
    if (totalSize > MAX_BODY_SIZE) {
      req.destroy();
      throw new Error("Request body too large");
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks);
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;

  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

function getFirstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

/**
 * Create a previte adapter for Node.js.
 *
 * ```ts
 * import { nodeAdapter } from "@previte/adapter-node";
 * previte({ adapter: nodeAdapter() })
 * ```
 */
export function nodeAdapter(options: NodeServerEntryModuleOptions = {}): PreviteAdapter {
  return {
    id: "node",
    serverImports: 'import { resolveApp, resolveApiRoutes } from "previte";',
    createServerEntryModule() {
      return createNodeServerEntryModule(options);
    },
  };
}
