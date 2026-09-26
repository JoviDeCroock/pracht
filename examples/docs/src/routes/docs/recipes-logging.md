---
title: Logging & Observability
lead: Capture request duration, status, and failures from loaders and API routes with one wrap-around middleware — no per-handler instrumentation.
breadcrumb: Logging
prev:
  href: /docs/recipes/testing
  title: Testing
next:
  href: /docs/recipes/streaming
  title: Server-Sent Events & WebSockets
---

## What pracht Logs on Its Own

A loader, render, or API handler that throws answers 500 and prints one line to
the server's console before anything of yours runs:

```text
[pracht] loader error in route "blog" (./routes/blog.tsx) at /blog/hello: post 42 is gone
```

It names the phase, route id, source file, request path, and message, followed
by the stack, and reads the same in `pracht dev` and production. A
`throw notFound()` is a routing outcome, not a crash, and stays quiet.

That line has no request id, no duration, no status for successful requests,
and no way to reach your sink. Add the middleware below for those.

---

## Recommended Shape

Pracht middleware wraps the rest of the request via `next()`, so one
middleware can `try / catch / finally` around every loader and API handler.
Put request logging, OpenTelemetry spans, and anything else that needs the
final status or a thrown error there.

- **Manifest apps** (those with `routes.ts`): use a tracing/logging middleware
  registered with `defineApp`. One middleware covers loaders, API routes, and
  inner middleware in one wrapper.
- **Pages router** apps: `src/pages/_middleware.ts` is one wrapper around every
  page route, but it does not wrap API routes, capability HTTP endpoints, or
  `/mcp` — wrap those handlers with a small higher-order function instead.
- **Adapter-level wrappers** are only needed when you want to observe the
  outer HTTP cycle including framework-internal failures, since pracht
  converts loader/handler errors into responses before they leave its
  runtime.

---

## Create a Request Logger in Context

Adapters load a context factory from `createContextFrom`. Create the request
id and logger there, shared by loaders, middleware, and API handlers.

```ts [vite.config.ts]
import { nodeAdapter } from "@pracht/adapter-node";
import { pracht } from "@pracht/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    pracht({
      adapter: nodeAdapter({ createContextFrom: "/src/server/context.ts" }),
    }),
  ],
});
```

```ts [src/server/context.ts]
import { createRequestLogger } from "./logger";

export function createContext({ request }: { request: Request }) {
  const url = new URL(request.url);
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  return {
    logger: createRequestLogger({
      method: request.method,
      path: url.pathname,
      requestId,
    }),
    requestId,
  };
}
```

Register the context type once so `args.context.logger` is typed everywhere:

```ts [src/env.d.ts]
import "@pracht/core";

/** Whatever `createRequestLogger()` returns — swap in your logger's type. */
interface RequestLogger {
  /** Buffers one structured record; `flush()` ships them. */
  event(fields: Record<string, unknown>): void;
  flush(): Promise<void>;
}

declare module "@pracht/core" {
  interface Register {
    context: {
      logger: RequestLogger;
      requestId: string;
    };
  }
}
```

---

## Wrap-Around Logging Middleware

Register the middleware once in the manifest. Apply it globally for API
routes via `api.middleware`, and on a group/route for page routes:

```ts [src/routes.ts]
import { defineApp, group, route } from "@pracht/core";

export const app = defineApp({
  middleware: {
    requestLog: "./middleware/request-log.ts",
  },
  api: {
    middleware: ["requestLog"],
  },
  routes: [
    group({ middleware: ["requestLog"] }, [
      route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" }),
      route("/projects/:id", "./routes/project.tsx", { render: "ssr" }),
    ]),
  ],
});
```

```ts [src/middleware/request-log.ts]
import type { MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async (
  { context, request, route, url, waitUntil },
  next,
) => {
  const startedAt = performance.now();
  let response: Response | undefined;
  let thrown: unknown;

  try {
    response = await next();
    return response;
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    const durationMs = Math.round(performance.now() - startedAt);
    const status = response?.status ?? 500;

    context.logger.event({
      durationMs,
      error: serializeError(thrown),
      method: request.method,
      path: url.pathname,
      requestId: context.requestId,
      route: route.path,
      status,
    });

    // Hand the flush off so the response can return immediately. Every
    // adapter keeps the request alive for it (ctx.waitUntil on Cloudflare,
    // context.waitUntil on Netlify and Vercel, a drained pending set on
    // Node), and a failed flush is reported instead of crashing anything.
    waitUntil(context.logger.flush());
  }
};

function serializeError(error: unknown) {
  if (!error) return undefined;
  if (error instanceof Error) {
    return { message: error.message, name: error.name, stack: error.stack };
  }
  return { message: String(error), name: "Error" };
}
```

The middleware sees the final response status and any thrown error, and
`finally` runs as part of the request.

> [!NOTE]
> On Cloudflare the worker can be torn down once the response is returned.
> `await flush()` blocks the response, and fire-and-forget can be cut off.
> `context.executionContext.waitUntil(flushPromise)` sends the response and
> keeps the worker alive until the flush resolves; `deferFlush` above uses it
> when available.

---

## Pages Router: Higher-Order Wrapper

`src/pages/_middleware.ts` covers every page route with the same `MiddlewareFn`
a manifest registers. It does not cover API routes, capability HTTP endpoints,
or `/mcp`, so log those by wrapping the handlers:

```ts [src/lib/with-request-logging.ts]
import type { ApiRouteHandler } from "@pracht/core";

export function withRequestLogging(handler: ApiRouteHandler): ApiRouteHandler {
  return async (args) => {
    const startedAt = performance.now();
    let response: Response | undefined;
    let thrown: unknown;

    try {
      response = await handler(args);
      return response;
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      args.context.logger.event({
        durationMs: Math.round(performance.now() - startedAt),
        error: thrown ? String(thrown) : undefined,
        method: args.request.method,
        path: args.url.pathname,
        requestId: args.context.requestId,
        route: args.route.path,
        status: response?.status ?? 500,
      });
      // Ship the events after the response instead of blocking it.
      args.waitUntil(args.context.logger.flush());
    }
  };
}
```

```ts [src/api/projects.ts]
import { withRequestLogging } from "../lib/with-request-logging";

export const POST = withRequestLogging(async ({ request, context }) => {
  const body = await request.json();
  context.logger.event({ action: "project.create" });
  const project = await createProject(body);
  return Response.json({ project }, { status: 201 });
});
```

Multiple wrappers compose: `withRequestLogging(withAuth(handler))`.

---

## Agent Traffic

Capability dispatches get their own structured event: one per call, on every transport, including nested `invokeCapability()` calls. No per-capability instrumentation is needed.

```ts [src/server/audit.ts]
import { addCapabilityAuditListener } from "@pracht/core/server";

const stopAuditLog = addCapabilityAuditListener("audit-log", (event) => {
  console.log(
    JSON.stringify({
      msg: "capability",
      at: new Date().toISOString(),
      capability: event.capability,
      effect: event.effect,
      transport: event.transport, // "http" | "webmcp" | "mcp" | "server"
      via: event.via, // causal transport for nested dispatches
      outcome: event.outcome, // "ok" or the envelope error code
      status: event.status,
      durationMs: Math.round(event.durationMs),
      agent: event.agent?.agentDomain ?? event.agent?.keyId ?? null,
      account: event.tokenAuth,
    }),
  );
});

if (import.meta.hot) {
  import.meta.hot.dispose(stopAuditLog);
}
```

Import it from an eagerly loaded module: add `import "./audit.ts"` to the `createContextFrom` module above, or import it from a custom server entry. Route, API route, middleware, and `src/server/` registry modules load lazily and can miss earlier calls. Keep the HMR `dispose` hook so the dev server never keeps a stale listener.

Sinks run synchronously, so keep the work before the first `await` cheap. A returned promise is not awaited, and a sink that throws is swallowed, with one `console.warn` per named registration. On Cloudflare Workers, flush a batching exporter within the request or pass it the execution context yourself; pracht does not call `ctx.waitUntil()` for sinks.

The three metrics worth deriving from these events:

| Metric | Derivation | What it tells you |
| --- | --- | --- |
| Activation | Count verified identities, MCP, and MCP-caused composition; keep top-level unsigned HTTP, HTTP-caused composition, and client-declared WebMCP separate | Whether attributable agents are visiting, without trusting spoofable client markers or counting human forms as agents |
| Task completion | Ratio where `outcome === "ok"` or status is 2xx, per `capability` | Whether they can finish what they came for, including successful middleware short-circuits without counting middleware redirects |
| Contract failures | Count of `invalid_input` / `invalid_output` / `unauthorized` | Whether your schemas or auth are what is blocking them |

In development, the **Agents** section of `/_pracht` shows the last 200 dispatches, and `/_pracht.json` exposes them under `agentTraffic`. Adapter-owned dev servers such as Cloudflare `workerd` return 404 for both; check the sink's own output there. See [Agent trust](/docs/agent-trust#audit-trail) for the full event shape and an OpenTelemetry recipe.
