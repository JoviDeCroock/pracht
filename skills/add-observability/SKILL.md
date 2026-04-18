---
name: add-observability
version: 1.0.0
description: |
  Wire error tracking, request tracing, and Web Vitals into a pracht app.
  Supports Sentry or OpenTelemetry on the server side (loader/middleware
  boundaries, API routes), and client-side Web Vitals reporting via the
  `web-vitals` package.
  Use when asked to "add observability", "wire Sentry", "set up tracing",
  "add OpenTelemetry", "monitor Web Vitals", or "track errors".
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

Three layers, each opt-in:

1. **Server error tracking** — capture loader/middleware/API exceptions.
2. **Request tracing** — span per request with child spans per loader/db call.
3. **Web Vitals (LCP/CLS/INP/FCP/TTFB)** — client-side, posted to a beacon
   endpoint.

## Step 1: Pick the stack

Use `AskUserQuestion`:

- **Sentry** — easiest end-to-end (errors + traces + Web Vitals).
- **OpenTelemetry + your backend** (Honeycomb, Grafana, Datadog, Jaeger).
- **Custom beacon** — minimal `fetch('/api/telemetry')` setup, no SaaS.

The skill below shows Sentry and OTel patterns. Custom beacon is mentioned
but trivial.

## Step 2: Server error tracking

### Sentry path

```bash
pnpm add @sentry/node    # for Node adapter
# or
pnpm add @sentry/cloudflare   # for Cloudflare adapter
# or
pnpm add @sentry/vercel-edge  # for Vercel edge
```

Create `src/server/observability.ts`:

```ts
import * as Sentry from "@sentry/node";

let initialized = false;
export function initObservability() {
  if (initialized) return;
  initialized = true;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    environment: process.env.NODE_ENV,
  });
}
```

Add a global middleware that calls `initObservability()` once and wraps the
downstream call:

```ts
// src/middleware/observability.ts
import type { MiddlewareFn } from "@pracht/core";
import * as Sentry from "@sentry/node";
import { initObservability } from "../server/observability";

initObservability();

export const middleware: MiddlewareFn = async ({ request, route }) => {
  return await Sentry.startSpan(
    { name: `${request.method} ${route?.path ?? new URL(request.url).pathname}`, op: "http.server" },
    async () => undefined,
  );
};
```

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

Create `src/client/vitals.ts`:

```ts
import { onCLS, onINP, onLCP, onFCP, onTTFB, type Metric } from "web-vitals";

function send(metric: Metric) {
  navigator.sendBeacon?.(
    "/api/telemetry/vitals",
    JSON.stringify({ name: metric.name, value: metric.value, id: metric.id, path: location.pathname }),
  );
}

onCLS(send);
onINP(send);
onLCP(send);
onFCP(send);
onTTFB(send);
```

Import this from a shell that wraps the SPA-router-using routes (or from a
lazy-loaded chunk via `useEffect`-equivalent in a top-level component).

## Step 5: Beacon endpoint

```ts
// src/api/telemetry/vitals.ts
import type { BaseRouteArgs } from "@pracht/core";

export async function POST({ request }: BaseRouteArgs) {
  const body = await request.text();
  // Forward to your destination (Sentry, Honeycomb, custom store).
  // Keep body small; do not block on the upstream.
  console.log("vitals", body);
  return new Response(null, { status: 204 });
}
```

For Sentry users, Sentry's browser SDK can capture Web Vitals natively —
prefer that over a custom beacon if you've gone the Sentry route.

## Step 6: Sampling and PII

- Set `SENTRY_TRACES_SAMPLE_RATE` to a small number (0.05–0.10) in
  production.
- Scrub auth headers and cookies from breadcrumbs:
  ```ts
  Sentry.init({ beforeSend(event) { delete event.request?.headers?.cookie; return event; } });
  ```
- Never send loader return values verbatim — they often contain user data.

## Step 7: Verify

- Trigger a deliberate error in dev and confirm it lands in Sentry/OTel.
- Open a route, check the Web Vitals beacon fires (Network tab).
- Confirm `pnpm test` and `pnpm e2e` still pass.

## Rules

1. Confirm adapter compatibility before installing the SDK package
   (Sentry has separate packages per runtime).
2. Top-level `middleware` in `defineApp` is a name→path *registry*, not an
   ordered chain. Place `"observability"` first in every `group({
   middleware: [...] })` and in `api.middleware` so it wraps the rest.
3. Web Vitals only matter for SSR/SSG/ISG routes that hydrate; SPA-only
   routes still benefit but the values reflect the post-bootstrap state.
4. Sample traces (≤ 10%) in production; full sampling in dev.
5. Never send raw cookies, auth headers, or full loader payloads to a
   third-party SaaS.

$ARGUMENTS
