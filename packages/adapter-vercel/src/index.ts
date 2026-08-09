import type { PrachtAdapter } from "@pracht/vite-plugin";
import {
  handlePrachtRequest,
  hasWebhookRevalidate,
  type HandlePrachtRequestOptions,
  jsonResponse,
  matchAppRoute,
  type ModuleRegistry,
  PRACHT_REVALIDATE_ENDPOINT,
  PRACHT_REVALIDATE_TOKEN_ENV,
  type ResolvedApiRoute,
  readRevalidationRequest,
  type PrachtApp,
} from "@pracht/core/server";

export interface VercelExecutionContext {
  waitUntil?(promise: Promise<unknown>): void;
  [key: string]: unknown;
}

export interface VercelContextArgs<
  TVercelContext extends VercelExecutionContext = VercelExecutionContext,
> {
  request: Request;
  context: TVercelContext;
}

export interface VercelAdapterOptions<
  TVercelContext extends VercelExecutionContext = VercelExecutionContext,
  TContext = TVercelContext,
> {
  app: PrachtApp;
  registry?: ModuleRegistry;
  apiRoutes?: ResolvedApiRoute[];
  clientEntryUrl?: string;
  cssManifest?: Record<string, string[]>;
  jsManifest?: Record<string, string[]>;
  createContext?: (args: VercelContextArgs<TVercelContext>) => TContext | Promise<TContext>;
}

export interface VercelServerEntryModuleOptions {
  functionName?: string;
  regions?: string | string[];
  /** Vite-resolvable module path exporting `createContext(args)`. */
  createContextFrom?: string;
}

/**
 * Structural subset of Node's `IncomingMessage` used by the serverless
 * launcher. Typed inline so this edge-targeted package keeps no dependency on
 * `@types/node`.
 */
export interface VercelNodeRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array | string>;
}

/** Structural subset of Node's `ServerResponse` used by the serverless launcher. */
export interface VercelNodeResponse {
  statusCode: number;
  statusMessage?: string;
  setHeader(name: string, value: string | string[]): unknown;
  write(chunk: Uint8Array): unknown;
  end(): unknown;
}

export function createVercelEdgeHandler<
  TVercelContext extends VercelExecutionContext = VercelExecutionContext,
  TContext = TVercelContext,
>(options: VercelAdapterOptions<TVercelContext, TContext>) {
  return async (request: Request, context: TVercelContext): Promise<Response> => {
    if (new URL(request.url).pathname === PRACHT_REVALIDATE_ENDPOINT) {
      return handleVercelRevalidationEndpoint(request, options.app);
    }

    const prachtContext = options.createContext
      ? await options.createContext({ request, context })
      : (context as unknown as TContext);

    return handlePrachtRequest({
      app: options.app,
      registry: options.registry,
      request,
      context: prachtContext,
      apiRoutes: options.apiRoutes,
      clientEntryUrl: options.clientEntryUrl,
      cssManifest: options.cssManifest,
      jsManifest: options.jsManifest,
    } satisfies HandlePrachtRequestOptions<TContext>);
  };
}

/**
 * Wrap a `fetch`-style handler as a Node request listener.
 *
 * Vercel only supports ISR (`.prerender-config.json`) on Serverless Functions,
 * so ISG routes are deployed as Node functions even though the main handler
 * stays on the edge. Both share the same server bundle: it is built against Web
 * APIs only, which Node provides natively.
 *
 * Only web globals are used here — pulling in `node:http`/`node:stream` would
 * break the webworker-targeted bundle the edge function is built from.
 */
export function createVercelNodeListener(
  handler: (request: Request, context: VercelExecutionContext) => Promise<Response>,
): (req: VercelNodeRequest, res: VercelNodeResponse) => Promise<void> {
  return async (req, res) => {
    const waitUntilTasks: Promise<unknown>[] = [];
    const context: VercelExecutionContext = {
      waitUntil(promise) {
        const task = Promise.resolve(promise);
        // Attach a rejection handler immediately so a task that rejects while
        // the response is streaming is not reported as unhandled. The drain
        // below still observes the original promise's final state.
        void task.catch(() => {});
        waitUntilTasks.push(task);
      },
    };

    try {
      const response = await handler(await createNodeWebRequest(req), context);
      await writeNodeResponse(res, response);
    } finally {
      await drainWaitUntilTasks(waitUntilTasks);
    }
  };
}

async function drainWaitUntilTasks(tasks: Promise<unknown>[]): Promise<void> {
  let drained = 0;
  while (drained < tasks.length) {
    const batch = tasks.slice(drained);
    drained = tasks.length;
    await Promise.allSettled(batch);
  }
}

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

async function createNodeWebRequest(req: VercelNodeRequest): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
      continue;
    }
    headers.set(key, value);
  }

  // Vercel terminates TLS in front of the function and always sets the
  // forwarded headers itself, so there is no untrusted hop to distrust here.
  const protocol = headers.get("x-forwarded-proto") ?? "https";
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? "localhost";
  const url = new URL(req.url ?? "/", `${protocol}://${host}`);
  const method = req.method ?? "GET";
  const init: RequestInit = { headers, method };

  if (!BODYLESS_METHODS.has(method.toUpperCase())) {
    const body = await readNodeRequestBody(req);
    if (body.byteLength > 0) init.body = body;
  }

  return new Request(url, init);
}

async function readNodeRequestBody(req: VercelNodeRequest): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;

  for await (const chunk of req) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    chunks.push(bytes);
    size += bytes.byteLength;
  }

  const body = new ArrayBuffer(size);
  const view = new Uint8Array(body);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

async function writeNodeResponse(res: VercelNodeResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  if (response.statusText) res.statusMessage = response.statusText;

  const setCookie =
    (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.call(
      response.headers,
    ) ?? [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie" && setCookie.length > 0) return;
    res.setHeader(key, value);
  });
  if (setCookie.length > 0) res.setHeader("set-cookie", setCookie);

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(value);
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

export function createVercelServerEntryModule(
  options: VercelServerEntryModuleOptions = {},
): string {
  const functionName = options.functionName ?? "render";
  const regions = options.regions;
  const contextImport = options.createContextFrom
    ? `import { createContext as createPrachtContext } from ${JSON.stringify(options.createContextFrom)};`
    : "const createPrachtContext = undefined;";

  return [
    contextImport,
    `export const vercelFunctionName = ${JSON.stringify(functionName)};`,
    `export const vercelRegions = ${JSON.stringify(regions ?? null)};`,
    "",
    "export default async function handle(request, context) {",
    "  const handler = createVercelEdgeHandler({",
    "    app: resolvedApp,",
    "    registry,",
    "    apiRoutes,",
    "    clientEntryUrl: clientEntryUrl ?? undefined,",
    "    cssManifest,",
    "    jsManifest,",
    "    createContext: createPrachtContext,",
    "  });",
    "  return handler(request, context);",
    "}",
    "",
    "// Entry point of the Node serverless functions emitted for ISG routes;",
    "// Vercel rejects `.prerender-config.json` next to an edge function.",
    "export const nodeListener = createVercelNodeListener(handle);",
    "",
  ].join("\n");
}

/**
 * `x-vercel-cache` values that prove the prerender cache was actually
 * refreshed. A `HIT`/`STALE` on a bypass request means Vercel ignored the
 * `x-prerender-revalidate` header — the runtime token does not match the
 * `bypassToken` baked into the build's `*.prerender-config.json`.
 */
const VERCEL_CACHE_REFRESH_STATUSES = new Set(["MISS", "REVALIDATED", "BYPASS"]);

async function handleVercelRevalidationEndpoint(
  request: Request,
  app: PrachtApp,
): Promise<Response> {
  const token = getRuntimeRevalidationToken();
  const parsed = await readRevalidationRequest(request, token);
  if (!parsed.ok) return parsed.response;

  const revalidated: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const pathname of parsed.paths) {
    const match = matchAppRoute(app, pathname);
    if (!match || match.route.render !== "isg" || !hasWebhookRevalidate(match.route.revalidate)) {
      skipped.push(pathname);
      continue;
    }

    // A failed regeneration keeps Vercel's cached prerender output and is
    // reported in `failed` instead of aborting the whole batch with a 500.
    try {
      const revalidateUrl = new URL(pathname, request.url);
      const response = await fetch(revalidateUrl, {
        headers: {
          accept: "text/html",
          "x-prerender-revalidate": token!,
        },
        method: "GET",
      });

      if (!response.ok) {
        failed.push(pathname);
        continue;
      }

      // A 200 alone does not prove the cache was refreshed: when the runtime
      // token differs from the build-time bypassToken, Vercel serves the
      // cached prerender output (x-vercel-cache: HIT/STALE) and the page was
      // never regenerated. Treat an absent header conservatively as success
      // (non-Vercel/test environments don't set it).
      const cacheStatus = response.headers.get("x-vercel-cache");
      if (cacheStatus === null || VERCEL_CACHE_REFRESH_STATUSES.has(cacheStatus.toUpperCase())) {
        revalidated.push(pathname);
      } else {
        console.error(
          `ISG webhook revalidation failed for ${pathname}: x-vercel-cache was "${cacheStatus}" — ` +
            "the revalidation token did not match the build-time bypass token; " +
            `rebuild with ${PRACHT_REVALIDATE_TOKEN_ENV} set.`,
        );
        failed.push(pathname);
      }
    } catch (err) {
      console.error(`ISG webhook revalidation failed for ${pathname}:`, err);
      failed.push(pathname);
    }
  }

  return jsonResponse({ failed, revalidated, skipped });
}

function getRuntimeRevalidationToken(): string | undefined {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env?.[PRACHT_REVALIDATE_TOKEN_ENV];
}

/**
 * Create a pracht adapter for Vercel Edge Functions.
 *
 * ```ts
 * import { vercelAdapter } from "@pracht/adapter-vercel";
 * pracht({ adapter: vercelAdapter() })
 * ```
 */
export function vercelAdapter(options: VercelServerEntryModuleOptions = {}): PrachtAdapter {
  return {
    id: "vercel",
    edge: true,
    serverImports:
      'import { resolveApp, resolveApiRoutes } from "@pracht/core/server";\nimport { createVercelEdgeHandler, createVercelNodeListener } from "@pracht/adapter-vercel";',
    createServerEntryModule() {
      return createVercelServerEntryModule(options);
    },
  };
}
