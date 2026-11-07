---
title: Audit trail
lead: Record every capability dispatch with its transport, outcome, latency, verified agent, and OAuth principal, and watch agent traffic in dev.
---

Register a hook to receive one event per capability dispatch: capability, effect, transport, outcome, status, latency, the verified agent (or `null`), and the OAuth `tokenAuth` (or `null`).

```ts [src/server/audit.ts]
import { setCapabilityAuditHook } from "@pracht/core/server";

setCapabilityAuditHook((event) => log.info("capability", event));
```

A nested `invokeCapability()` call emits its own event with `transport: "server"` and `via` set to the outer request's transport, such as `{ transport: "server", via: "mcp" }`. Top-level dispatches have `via: null`.

## Registering more than one sink

`setCapabilityAuditHook()` is a single slot. For several sinks, use `addCapabilityAuditListener(name, hook)`, which returns an unsubscribe function:

```ts [src/server/audit.ts]
import { addCapabilityAuditListener } from "@pracht/core/server";

const stop = addCapabilityAuditListener("metrics", (event) => metrics.record(event));

if (import.meta.hot) {
  import.meta.hot.dispose(stop);
}
```

Registering the same name again replaces that sink, so use a fixed name at module top level and dev reloads do not stack duplicates.

A sink runs synchronously and is never awaited, so keep work before its first `await` cheap; a returned promise goes to [`waitUntil()`](/docs/data-loading#waituntil). A throwing sink logs one `console.warn` naming it and never breaks the request.

## Production recipes

A structured log line per dispatch is enough for most apps:

```ts [src/server/audit.ts]
import { addCapabilityAuditListener } from "@pracht/core/server";

const stopAuditLog = addCapabilityAuditListener("audit-log", (event) => {
  // Synchronous and allocation-light: safe on every runtime.
  console.log(
    JSON.stringify({
      msg: "capability",
      at: new Date().toISOString(),
      capability: event.capability,
      effect: event.effect,
      transport: event.transport,
      via: event.via,
      outcome: event.outcome,
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

The OpenTelemetry version records dispatch counts, latency, and failure spans. Count only verified identities and MCP traffic as agent activity: unsigned HTTP may be a person submitting a `<Form capability>`, and the client sets the WebMCP transport marker.

```ts [src/server/audit-otel.ts]
import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import { addCapabilityAuditListener } from "@pracht/core/server";

const meter = metrics.getMeter("pracht.capabilities");
const dispatches = meter.createCounter("pracht.capability.dispatches");
const duration = meter.createHistogram("pracht.capability.duration", { unit: "ms" });
const tracer = trace.getTracer("pracht.capabilities");

const stopOtel = addCapabilityAuditListener("otel", (event) => {
  const attributes = {
    "pracht.capability": event.capability,
    "pracht.effect": event.effect,
    "pracht.transport": event.transport,
    "pracht.via": event.via ?? "none",
    "pracht.outcome": event.outcome,
    "pracht.agent": event.agent?.agentDomain ?? event.agent?.keyId ?? "unverified",
  };

  const completed = event.outcome === "ok" || (event.status >= 200 && event.status < 300);

  dispatches.add(1, attributes);
  duration.record(event.durationMs, attributes);

  // The dispatch already finished, so the span is backdated to its real start
  // rather than wrapping work that is still running.
  const end = Date.now();
  const span = tracer.startSpan(`capability ${event.capability}`, {
    attributes: { ...attributes, "http.response.status_code": event.status },
    startTime: end - event.durationMs,
  });
  if (!completed) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: event.outcome });
  }
  span.end(end);
});

if (import.meta.hot) {
  import.meta.hot.dispose(stopOtel);
}
```

Import both modules from an eagerly loaded server module, such as your adapter's `createContextFrom` module or a custom server entry. Route, API, middleware, and `src/server/` modules load lazily, so a sink imported only there can miss earlier calls. For request-level tracing, see [Logging and observability](/docs/recipes/logging).

## Agent traffic in dev

Open `/_pracht` during `pracht dev` to see the last 200 audit events in the **Agents** section, newest first. The same data is JSON at `/_pracht.json`:

```json
{
  "agentTraffic": {
    "limit": 200,
    "recorded": 3,
    "events": [
      {
        "at": 1787718593323,
        "capability": "notes.search",
        "effect": "read",
        "transport": "mcp",
        "via": null,
        "outcome": "ok",
        "status": 200,
        "durationMs": 0.28,
        "agent": null
      }
    ]
  }
}
```

`recorded` counts every event since the dev server started. Cloudflare's `workerd` dev server does not serve the panel; both paths return 404 there.

The panel labels verified identities and MCP calls **agent-attributed**, and unsigned HTTP and WebMCP calls as unverified **dispatches**. `invokeCapability()` work outside a served request sits behind a "show first-party" toggle.

## What is not audited

Requests rejected before dispatch emit no event: cross-origin mutations (`cross_origin_blocked`), unknown paths under `/api/capabilities/*` (`unknown_capability`), and unknown or unexposed MCP tool names. Use your HTTP access log to spot probing.

To see the configured surface instead of live traffic, run [`pracht inspect agents`](/docs/cli#pracht-inspect). It reports each capability's exposure and the MCP endpoint's OAuth settings.
