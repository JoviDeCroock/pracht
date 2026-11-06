---
title: Logging
lead: Record request duration, status, and failures from loaders and API routes with one wrap-around middleware.
---

This recipe adds one structured log record per request, with a request id, duration, status, and any thrown error, shipped to your sink after the response.

## What pracht logs by default

A loader, render, or API handler that throws answers 500 and prints one line, followed by the stack, to the server console:

```text
[pracht] loader error in route "blog" (./routes/blog.tsx) at /blog/hello: post 42 is gone
```

The line names the phase, route id, source file, request path, and message, and reads the same in `pracht dev` and production. `throw notFound()` is a routing outcome and logs nothing.

The default line has no request id, no duration, no record of successful requests, and no way to reach your sink. The steps below add those.

## 1. Create a request logger in context

Adapters load a context factory from `createContextFrom`. Create the request id and logger there, so loaders, middleware, and API handlers share them:

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

## 2. Write the logging middleware

Middleware wraps the rest of the request through `next()`, so one `try / catch / finally` sees the final status and any thrown error from every loader, API handler, and inner middleware:

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

    // Ship the events after the response instead of blocking it.
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

[`waitUntil()`](/docs/data-loading#waituntil) sends the response first and keeps the flush alive on every adapter; `await flush()` would delay the response.

## 3. Register the middleware

Apply it to API routes through `api.middleware` and to page routes on a group:

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

Request `/dashboard`: your sink receives one record with `route: "/dashboard"`, the status, and the duration. A loader that throws produces a record with `status: 500` and the serialized error.

pracht turns loader and handler errors into responses inside its runtime. To observe the outer HTTP cycle, including framework-internal failures, wrap the adapter's server instead.

## Pages router: wrap API handlers

In a [pages router](/docs/routing) app, `src/pages/_middleware.ts` wraps every page route with the same `MiddlewareFn`. It does not wrap API routes, capability HTTP endpoints, or `/mcp`, so log those with a higher-order handler:

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

Wrappers compose: `withRequestLogging(withAuth(handler))`.

## Log agent traffic

Register a capability audit listener to get one structured event per capability call, on every transport, including nested `invokeCapability()` calls:

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

Import it from an eagerly loaded module: add `import "./audit.ts"` to the `createContextFrom` module above, or to a custom server entry. Route, API route, middleware, and `src/server/` registry modules load lazily and can miss earlier calls. The HMR `dispose` hook stops the dev server from keeping a stale listener.

Listeners run synchronously, so keep the work before the first `await` cheap. A returned promise goes to [`waitUntil()`](/docs/data-loading#waituntil), so an `async` exporter finishes after the response. A listener that throws is swallowed, with one `console.warn` per named registration.

Metrics to derive from these events:

| Metric | Derivation | What it tells you |
| --- | --- | --- |
| Activation | Count verified identities, MCP calls, and compositions MCP caused. Count unsigned HTTP, HTTP-caused composition, and client-declared WebMCP separately | Whether attributable agents are visiting, without trusting spoofable client markers or counting human form posts |
| Task completion | Share of calls per `capability` where `outcome === "ok"` or the status is 2xx | Whether agents finish what they came for |
| Contract failures | Count of `invalid_input`, `invalid_output`, and `unauthorized` | Whether your schemas or auth are blocking them |

In development, the **Agents** section of `/_pracht` shows the last 200 dispatches, and `/_pracht.json` exposes them under `agentTraffic`. Adapter-owned dev servers such as Cloudflare `workerd` return 404 for both; check the listener's own output there. See [Agent trust](/docs/agent-trust#audit-trail) for the full event shape and an OpenTelemetry recipe.
