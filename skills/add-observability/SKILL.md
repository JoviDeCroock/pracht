---
name: add-observability
version: 1.1.2
description: |
  Wire Sentry or OpenTelemetry into pracht server boundaries (loaders, middleware,
  API routes), client-side Web Vitals reporting, and a capability audit sink that
  records every capability dispatch with transport, outcome, latency, and verified
  identity.
  Use for "add observability", "wire Sentry", "set up tracing", "add
  OpenTelemetry", "monitor Web Vitals", "track errors", "log capability calls",
  or "are agents calling my app".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Pracht Add Observability

Four layers, each opt-in:

1. **Server error tracking** — capture loader/middleware/API exceptions.
2. **Request tracing** — span per request with child spans per loader/db call.
3. **Web Vitals (LCP/CLS/INP/FCP/TTFB)** — client-side, posted to a beacon
   endpoint.
4. **Agent traffic** — one structured audit event per capability dispatch.
   Only relevant when the app registers capabilities; skip it otherwise.

MCP: when the pracht MCP server is registered (docs/MCP.md), prefer its
`inspect_agents`/`inspect_routes`/`inspect_api`/`inspect_build`/`doctor`/
`verify`/`generate_*` tools over shelling out. `pracht inspect` needs the pracht
plugin in the vite config.

## Step 1: Pick the stack

Use `AskUserQuestion`:

- **Sentry** — easiest end-to-end (errors + traces + Web Vitals).
- **OpenTelemetry + your backend** (Honeycomb, Grafana, Datadog, Jaeger).
- **Custom beacon** — minimal `fetch('/api/telemetry')` setup, no SaaS.

The skill below shows Sentry and OTel patterns. Custom beacon is mentioned
but trivial.

## Step 2: Server error tracking

### Sentry path (Node adapter)

The pattern below uses `@sentry/node` and works on the **Node adapter only**
— see the caveat box below for Cloudflare and Vercel Edge before installing
anything.

```bash
pnpm add @sentry/node    # Node adapter only
```

Create `src/server/observability.ts`:

```ts
import { serverEnv } from "@pracht/core/env/server";
import * as Sentry from "@sentry/node";

let initialized = false;
export function initObservability() {
  if (initialized) return;
  initialized = true;
  // serverEnv is read INSIDE this function, not at module scope — module-level
  // env reads break on runtimes where env arrives per request (docs/ENV.md).
  Sentry.init({
    dsn: serverEnv.SENTRY_DSN,
    tracesSampleRate: Number(serverEnv.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    environment: serverEnv.NODE_ENV,
  });
}
```

Add a global middleware that calls `initObservability()` once (from inside
the handler, never at module scope) and wraps the downstream call:

```ts
// src/middleware/observability.ts
import type { MiddlewareFn } from "@pracht/core";
import * as Sentry from "@sentry/node";
import { initObservability } from "../server/observability";

export const middleware: MiddlewareFn = async ({ request, route }, next) => {
  initObservability();
  return Sentry.startSpan(
    {
      name: `${request.method} ${route.path}`,
      op: "http.server",
    },
    () => next(),
  );
};
```

> **Cloudflare / Vercel Edge caveat — be honest here.** `@sentry/cloudflare`
> requires wrapping the worker's fetch handler with `withSentry()`, but
> pracht's Cloudflare adapter owns that handler — there is no user hook to
> wrap it today, so the middleware-init pattern above **cannot work** with
> `@sentry/cloudflare`, and `@sentry/node` does not run on Workers at all.
> Do not scaffold a pattern that can't work. Options on Cloudflare:
> 1. Plain fetch-based event forwarding: catch errors in a wrap-around
>    middleware and `fetch` them to Sentry's store/envelope endpoint (or any
>    HTTP sink) yourself. Read the DSN via `serverEnv` inside the middleware.
> 2. Wait for pracht to expose a handler-wrap hook for the adapter, then use
>    Sentry's Cloudflare SDK properly.
>
> The same applies to `@sentry/vercel-edge`: verify how the init hooks into
> the runtime before installing; if it needs to own the handler, fall back to
> option 1. (This mirrors the OTel-edge honesty note below.)

Pracht middleware is wrap-around: `await next()` invokes the rest of the
request and resolves to the final `Response`, so the span naturally covers
the loader/handler and ends when they finish.

Register it in `defineApp({ middleware: { observability: "./..." } })` (the
top-level `middleware` field is a *registry* keyed by name — not an ordered
chain). To actually wrap requests, place `"observability"` first in every
chain that should cover them:

```ts
defineApp({
  middleware: { observability: "./middleware/observability.ts", auth: "./middleware/auth.ts" },
  api: { middleware: ["observability"] },           // all API routes
  routes: [
    group({ middleware: ["observability"] }, [      // all pages
      group({ middleware: ["auth"] }, [ /* protected routes */ ]),
    ]),
  ],
});
```

Ordering lives in these `middleware: [...]` arrays — always place
observability first so it spans the rest of the chain.

### OpenTelemetry path

```bash
pnpm add @opentelemetry/api @opentelemetry/sdk-trace-node @opentelemetry/auto-instrumentations-node
```

Create a SDK init module that runs at server entry — for Node, use the
`--require ./otel.cjs` flag; for Cloudflare/Vercel edge, OTel is more limited
(use HTTP exporter directly). Surface this trade-off; don't pretend OTel
edge is plug-and-play.

## Step 3: Loader/API tracing

For each loader and API handler, wrap the body in a span.

```ts
import * as Sentry from "@sentry/node";

export async function loader({ request }) {
  return Sentry.startSpan({ name: "loader: dashboard", op: "function" }, async () => {
    return { /* ... */ };
  });
}
```

Auto-injection is out of scope; provide a snippet, recommend wrapping the 5-10
slowest loaders (cross-reference with `audit-bundles` perf hotspots).

## Step 4: Web Vitals on the client

```bash
pnpm add web-vitals
```

Create `src/client/vitals.ts` — export a function, **no module-level
side effects**:

```ts
import { onCLS, onINP, onLCP, onFCP, onTTFB, type Metric } from "web-vitals";

function send(metric: Metric) {
  navigator.sendBeacon?.(
    "/api/telemetry/vitals",
    JSON.stringify({ name: metric.name, value: metric.value, id: metric.id, path: location.pathname }),
  );
}

export function reportVitals() {
  onCLS(send);
  onINP(send);
  onLCP(send);
  onFCP(send);
  onTTFB(send);
}
```

Do NOT import this statically from a shell: shells render on the **server**
too, so module-level `onCLS(...)` calls would execute during SSR. The primary
pattern is a lazy `import()` inside an effect, guarded by `useIsHydrated`
(exported from `@pracht/core`), placed in a shell or top-level component:

```tsx
import { useIsHydrated } from "@pracht/core";
import { useEffect } from "preact/hooks";

export function Vitals() {
  const hydrated = useIsHydrated();
  useEffect(() => {
    if (!hydrated) return;
    void import("../client/vitals").then((m) => m.reportVitals());
  }, [hydrated]);
  return null;
}
```

This keeps `web-vitals` out of the critical bundle (lazy chunk) and only
starts observers after hydration has fully settled.

## Step 5: Beacon endpoint

```ts
// src/api/telemetry/vitals.ts
import type { ApiRouteArgs } from "@pracht/core";

export async function POST({ request }: ApiRouteArgs) {
  const body = await request.text();
  // Forward to your destination (Sentry, Honeycomb, custom store).
  // Keep body small; do not block on the upstream.
  console.log("vitals", body);
  return new Response(null, { status: 204 });
}
```

For Sentry users, Sentry's browser SDK can capture Web Vitals natively —
prefer that over a custom beacon if you've gone the Sentry route.

## Step 6: Agent traffic (capability apps only)

Skip when `pracht inspect agents --json` reports an empty `capabilities` list.
That only means there are no capability operations to audit; `llms.txt`, MCP,
or Web Bot Auth may still expose other agent-facing surfaces. When capabilities
do exist, every dispatch already emits a structured `CapabilityAuditEvent` —
nothing is instrumented per capability, a sink just has to be registered.

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
      via: event.via, // causal transport for nested invokeCapability()
      outcome: event.outcome, // "ok" or the envelope error code
      status: event.status,
      durationMs: Math.round(event.durationMs),
      agent: event.agent?.agentDomain ?? null,
    }),
  );
});

if (import.meta.hot) {
  import.meta.hot.dispose(stopAuditLog);
}
```

The OTel version records a counter and a histogram keyed on
capability/transport/outcome, and backdates a span with
`startTime: Date.now() - event.durationMs` (the dispatch has already
finished when the sink runs). The full snippet is on the agent-trust docs page.

Import the module for its side effect from a middleware, an API route, or a
custom server entry — anywhere that runs before the first request.

Key properties to state when scaffolding this:

- Sinks are invoked synchronously, so keep work before the callback returns or
  reaches its first `await` cheap. A returned promise is never awaited, and a
  synchronous throw is swallowed (first failure per sink reported via
  `console.warn`, naming it), so a broken exporter cannot fail the call.
- **Always pass a stable name** as the first argument. Registering the same
  name again replaces that sink, which is what keeps a module-scope call safe
  under dev HMR: Vite re-executes importers on every save, so an unkeyed
  registration would add a fresh closure per keystroke and deliver every event
  N times. Never compute the name. Register the returned unsubscribe with
  `import.meta.hot.dispose()` too, so removing the module or renaming the sink
  cannot leave the old name active until the dev server restarts.
- `setCapabilityAuditHook()` is a **single slot** — a second call replaces the
  first. Use `addCapabilityAuditListener()` whenever more than one sink exists;
  it returns an unsubscribe handle that removes only its own registration.
- Delivery snapshots the registered sinks before callbacks run. Adding or
  replacing a sink from inside a callback takes effect on the next dispatch,
  so the current event is never delivered twice to one name.
- On Cloudflare Workers, a batching exporter must flush within the request or
  be handed the execution context by app code
  (`context.executionContext.waitUntil(exporter.flush())`). Pracht does not
  call `ctx.waitUntil()` for a sink.
- Audit events cover *dispatch* only. A cross-origin 403, an unknown-capability
  404, and an unknown MCP tool name all return before dispatch and emit
  nothing, so do not build a reconnaissance alert on these events — use the
  HTTP access log for that.

In dev the same events are already collected: the **Agents** section of
`/_pracht` shows recent dispatches with transport, `via`, verified identity,
outcome, and duration, and `/_pracht.json` exposes all of them under
`agentTraffic`. The page counts verified identities, MCP, WebMCP, and
MCP-caused composition as agent-attributed; shows unverified HTTP separately
because it may be a person, agent, or other client; and hides ordinary
first-party `invokeCapability()` composition behind a toggle, so the panel's
visible count can be lower than the sink's.
Counts and empty-state conclusions only cover the retained window when older
events have been dropped. Use it to confirm the sink sees what the panel sees
before wiring a paid backend.

## Step 7: Sampling and PII

- Set `SENTRY_TRACES_SAMPLE_RATE` to a small number (0.05–0.10) in
  production.
- Scrub auth headers and cookies from breadcrumbs:
  ```ts
  Sentry.init({ beforeSend(event) { delete event.request?.headers?.cookie; return event; } });
  ```
- Never send loader return values verbatim — they often contain user data.

## Step 8: Verify

- Trigger a deliberate error in dev and confirm it lands in Sentry/OTel.
- Open a route, check the Web Vitals beacon fires (Network tab).
- If an audit sink was added: call a capability in dev and confirm the event
  reaches both the sink and the Agents panel at `/_pracht`.
- Confirm `pnpm test` and `pnpm e2e` still pass.
- Run `pracht typegen` if any routes were added (the beacon API route does
  not affect page-route types, but re-run when in doubt).
- Run `pracht verify --json` and confirm no failures.

## Rules

1. Confirm adapter compatibility before installing the SDK package
   (Sentry has separate packages per runtime), and never scaffold a pattern
   the runtime can't actually run — see the Cloudflare/Vercel-edge caveat in
   Step 2. Read `SENTRY_DSN` and friends via `serverEnv` inside functions,
   never `process.env` at module scope.
2. Top-level `middleware` in `defineApp` is a name→path *registry*, not an
   ordered chain. Place `"observability"` first in every `group({
   middleware: [...] })` and in `api.middleware` so it wraps the rest.
3. Web Vitals only matter for SSR/SSG/ISG routes that hydrate; SPA-only
   routes still benefit but the values reflect the post-bootstrap state.
4. Sample traces (≤ 10%) in production; full sampling in dev.
5. Never send raw cookies, auth headers, or full loader payloads to a
   third-party SaaS. The same applies to audit events: log the capability
   name, effect, transport, outcome, and agent domain — not the capability's
   input, which is application data.
6. Keep the synchronous part of an audit sink cheap: no CPU-heavy work or
   synchronous network call. Returned promises are fire-and-forget; the runtime
   does not await them or catch their rejections.

$ARGUMENTS
