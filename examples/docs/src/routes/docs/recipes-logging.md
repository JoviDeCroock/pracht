---
title: Logging & Observability
lead: Capture request duration, status, and failures from loaders and API routes with one wrap-around middleware — no per-handler instrumentation.
breadcrumb: Logging
prev:
  href: /docs/recipes/testing
  title: Testing
next:
  href: /docs/recipes/streaming
  title: Streaming
---

## Recommended Shape

Pracht middleware wraps the rest of the request via `next()`, so a single
middleware can `try / catch / finally` around every loader and API handler.
This is the right place for Honeycomb-style request logging, OpenTelemetry
spans, or anything that needs to observe the final status and any thrown
error.

- **Manifest apps** (those with `routes.ts`): use a tracing/logging middleware
  registered with `defineApp`. One middleware covers loaders, API routes, and
  inner middleware in one wrapper.
- **Pages router** apps: there is no manifest, so wrap individual API
  handlers with a small higher-order function instead.
- **Adapter-level wrappers** are only needed when you want to observe the
  outer HTTP cycle including framework-internal failures, since pracht
  converts loader/handler errors into responses before they leave its
  runtime.

---

## Create a Request Logger in Context

Adapters can import a context factory with `createContextFrom`. This is a
good place to create a request id and logger instance shared by loaders,
middleware, and API handlers.

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
import type { RequestLogger } from "./server/logger";

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

export const middleware: MiddlewareFn = async ({ context, request, route, url }, next) => {
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

    // Hand the flush off to the runtime so the response can return
    // immediately. On Cloudflare this keeps the worker alive long enough
    // for the events to ship; on Node the helper just awaits the promise.
    deferFlush(context, context.logger.flush());
  }
};

function serializeError(error: unknown) {
  if (!error) return undefined;
  if (error instanceof Error) {
    return { message: error.message, name: error.name, stack: error.stack };
  }
  return { message: String(error), name: "Error" };
}

// Cloudflare's executionContext.waitUntil keeps the worker alive past the
// response. On Node there's no equivalent — `await` would delay the
// response, and bare fire-and-forget would lose unhandled rejections, so
// just attach a catch handler.
function deferFlush(context: { executionContext?: { waitUntil(p: Promise<unknown>): void } }, flushPromise: Promise<unknown>) {
  if (context.executionContext?.waitUntil) {
    context.executionContext.waitUntil(
      flushPromise.catch((err) => console.error("[pracht] log flush failed", err)),
    );
    return;
  }
  flushPromise.catch((err) => console.error("[pracht] log flush failed", err));
}
```

This is the same `try / catch / finally` shape Hono and Koa users are
accustomed to. The middleware sees the final response status and any thrown
error, and `finally` runs as part of the request — exactly what
Honeycomb / Beeline-style libraries need.

> **Cloudflare:** the `fetch` handler returns once the middleware does, and
> the worker can be torn down at any point afterward. `await flush()` inside
> `finally` works but blocks the response on the flush; bare fire-and-forget
> risks the worker terminating mid-flight. The recommended pattern is
> `context.executionContext.waitUntil(flushPromise)` — the response goes out
> immediately and the runtime keeps the worker alive until the flush
> resolves. The `deferFlush` helper above handles both runtimes.

---

## Pages Router: Higher-Order Wrapper

The pages router does not use the manifest, so register logging by wrapping
individual handlers:

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
      // On Cloudflare, prefer
      // `args.context.executionContext.waitUntil(args.context.logger.flush())`
      // so the response is not blocked on the flush. On Node, `await` is fine.
      await args.context.logger.flush();
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

Request logging covers pages and API routes. Capability dispatches get their own structured event — one per call, on every transport, including nested `invokeCapability()` composition — so agent traffic is observable without instrumenting each capability.

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
    }),
  );
});

if (import.meta.hot) {
  import.meta.hot.dispose(stopAuditLog);
}
```

Import the module from an eagerly loaded server module. The `createContextFrom` module configured earlier on this page is loaded with the generated adapter entry, so adding `import "./audit.ts"` there registers the sink before request handling. A custom server entry can import it directly. Do not rely on an unrelated route, API route, middleware, or `src/server/` registry module: those modules are lazy and can miss earlier capability calls. Keep the HMR disposal hook so removing the module or renaming the sink cannot leave a stale listener in the dev server.

Sinks are invoked synchronously, so keep work before the callback returns or reaches its first `await` cheap. A returned promise is never awaited, and a sink that throws synchronously is swallowed (the first failure per named registration is reported once via `console.warn`). On Cloudflare Workers, a batching exporter must flush within the request or be handed the execution context by your own code — pracht does not call `ctx.waitUntil()` on a sink's behalf.

The three metrics worth deriving from these events:

| Metric | Derivation | What it tells you |
| --- | --- | --- |
| Activation | Count verified identities, MCP, and MCP-caused composition; keep top-level unsigned HTTP, HTTP-caused composition, and client-declared WebMCP separate | Whether attributable agents are visiting, without trusting spoofable client markers or counting human forms as agents |
| Task completion | Ratio where `outcome === "ok"` or status is 2xx, per `capability` | Whether they can finish what they came for, including successful middleware short-circuits without counting middleware redirects |
| Contract failures | Count of `invalid_input` / `invalid_output` / `unauthorized` | Whether your schemas or auth are what is blocking them |

In development, the same events are already collected for you: the **Agents** section of `/_pracht` shows the last 200 dispatches, and `/_pracht.json` exposes them under `agentTraffic`. Adapter-owned dev servers do not register that middleware, so Cloudflare `workerd` returns 404 for both paths; validate the sink from its own output there. See [Agent trust](/docs/agent-trust#audit-trail) for the full event shape and an OpenTelemetry recipe.
