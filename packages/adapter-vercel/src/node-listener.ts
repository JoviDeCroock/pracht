import {
  createISGRegenerationRequest,
  isCacheableISGResponse,
  isDangerousPrerenderHeader,
} from "@pracht/core/server";

import type { VercelExecutionContext, VercelNodeRequest, VercelNodeResponse } from "./types.js";

/**
 * Contexts minted by {@link createVercelNodeListener}, i.e. ISG prerender
 * invocations. A WeakSet keeps adapter bookkeeping hidden from application
 * context factories and impossible for them to forge.
 */
const isgRegenerationContexts = new WeakSet<object>();

export function isVercelISGRegenerationContext(context: unknown): boolean {
  return typeof context === "object" && context !== null && isgRegenerationContexts.has(context);
}

/**
 * Wrap a `fetch`-style handler as the Node request listener the ISG prerender
 * functions run on.
 *
 * Vercel only supports ISR (`.prerender-config.json`) on Serverless Functions,
 * so ISG routes are deployed as Node functions even though the main handler
 * stays on the edge. Both share the same server bundle: it is built against Web
 * APIs only, which Node provides natively.
 *
 * Every invocation here renders into Vercel's prerender cache, which is keyed
 * on the path alone (`allowQuery: []`) and replayed to every later visitor. The
 * listener therefore renders on a sanitized ISG request rather than the
 * visitor's own — the triggering visitor's `Cookie`/`Authorization` headers,
 * query string, and body never reach loaders, so a cache miss cannot
 * materialize a personalized page into shared cache. This mirrors the Node and
 * Cloudflare adapters' regeneration path.
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
        // streaming is not reported as unhandled. The drain still observes it.
        void task.catch(() => {});
        waitUntilTasks.push(task);
      },
    };
    isgRegenerationContexts.add(context);

    try {
      const request = createNodeISGRequest(req);
      const response = await handler(request, context);
      await writeNodeResponse(res, prepareVercelISGResponse(request, response));
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

/** Preserve only Vercel's forwarded origin and the path for shared-cache work. */
function createNodeISGRequest(req: VercelNodeRequest): Request {
  // Vercel terminates TLS and owns these forwarded headers.
  const protocol = readNodeHeader(req, "x-forwarded-proto") ?? "https";
  const host =
    readNodeHeader(req, "x-forwarded-host") ?? readNodeHeader(req, "host") ?? "localhost";
  const url = new URL(req.url ?? "/", `${protocol}://${host}`);

  return createISGRegenerationRequest(url.pathname, url);
}

function readNodeHeader(req: VercelNodeRequest, name: string): string | undefined {
  // Node lowercases incoming header names, but the structural type permits any casing.
  const value = req.headers[name] ?? req.headers[name.toUpperCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Strip credential-bearing headers before Vercel stores an ISG response. A
 * runtime regeneration cannot fail the build, so it logs and keeps serving the
 * sanitized page.
 */
function prepareVercelISGResponse(request: Request, response: Response): Response {
  const pathname = new URL(request.url).pathname;
  const dangerous = [...response.headers.keys()].filter(isDangerousPrerenderHeader);

  let prepared = response;
  if (dangerous.length > 0) {
    const headers = new Headers(response.headers);
    for (const name of dangerous) headers.delete(name);
    console.error(
      `Stripped ${dangerous.map((name) => `"${name}"`).join(", ")} from the ISG response for ` +
        `"${pathname}" before Vercel's prerender cache stored it — cached ISG output is replayed ` +
        "to every visitor. Move cookies and credential headers to API routes, middleware " +
        "responses, or an SSR route.",
    );
    prepared = new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }

  if (prepared.status === 200 && !isCacheableISGResponse(prepared)) {
    console.warn(
      `The ISG response for "${pathname}" marks itself uncacheable (Cache-Control private/no-store ` +
        "or Vary on Cookie/Authorization), but Vercel's prerender cache stores it regardless. " +
        "Render this route as SSR instead if its output is request-specific.",
    );
  }

  return prepared;
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
