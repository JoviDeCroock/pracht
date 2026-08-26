---
title: Agent Trust
lead: Who is calling, may they do this, and what happened? Verified agent identity with Web Bot Auth, a prepare/commit confirmation flow for destructive operations, structured audit events, and `pracht eval` to prove agent flows in CI.
breadcrumb: Agent Trust
prev:
  href: /docs/capabilities
  title: Capabilities
next:
  href: /docs/remote-mcp
  title: Remote MCP
---

> **Manifest router only.** `defineApp({ agents })` is the configuration seam for Web Bot Auth, confirmation, and remote MCP, so none of it is available to [pages-router](/docs/routing#what-the-pages-router-does-not-have) apps.

> **Signing requests as an agent.** Pracht ships the signer next to the verifier at `@pracht/core/agent-auth`:
>
> ```ts
> import { signAgentRequest } from "@pracht/core/agent-auth";
>
> const response = await fetch(
>   await signAgentRequest(new Request(url, { method: "POST", body }), {
>     agent: "https://my-agent.example",
>     privateKeyJwk,
>   }),
> );
> ```
>
> `pracht eval` scenarios use the same identity through a `signAs` block, which is what lets a scenario cover an `agentPolicy: "require"` capability. The signature covers `@authority`, so sign the host the server actually sees.

## Three Questions

Exposing [capabilities](/docs/capabilities) to agents raises questions a schema cannot answer. The agent trust layer answers all three, and everything is opt-in. When the build can prove that an app registers neither capabilities nor `defineApp({ agents })`, the capability dispatch and Web Bot Auth verifier are dropped from the server bundle entirely.

- **Who is calling?** — Web Bot Auth puts a cryptographically verified agent identity on the request context.
- **May they do this?** — policy modes per app and per capability, plus a server-verified confirmation flow for destructive effects, optionally backed by a durable approval store for exactly-once commits and, in human mode, real human approval.
- **What happened?** — one structured audit event per capability dispatch.

---

## Web Bot Auth: Verified Agent Identity

Agents sign requests with [RFC 9421 HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421) and publish Ed25519 public keys in a well-known directory — the emerging standard already deployed by major CDNs. pracht implements both sides — the verifier described here, and the signer at
`@pracht/core/agent-auth` shown above; configuration lives in the manifest, and keys are public, so they are safe there:

```ts [src/routes.ts]
export const app = defineApp({
  agents: {
    webBotAuth: {
      policy: "observe", // identify agents, serve everyone
      keys: [{ x: "<base64url Ed25519 public key>", agent: "my-agent.example" }],
      directories: ["https://signature-agent.cloudflare.com"], // allowlist-only key fetching
    },
  },
});
```

Verification happens once per request in `handlePrachtRequest`, using only Web platform APIs — Node, Cloudflare, Netlify, and Vercel share the implementation. The result surfaces everywhere:

```ts [src/capabilities/agent-whoami.ts]
async run({ context }) {
  context.agent; // { verified: true, agentDomain, keyId } | null
}
```

Verification fails closed: expired windows, uncovered components, unknown keys, or non-allowlisted directories all yield `context.agent = null`, never a partial identity. The framework binds the result as a read-only, immutable snapshot, so middleware can derive separate authorization state but cannot rewrite the verified identity used by later policy and audit checks. Adapters should create a fresh context per request; rebinding the same mutable or immutable source to a different identity fails closed rather than leaking the previous identity through context methods or getters. The `agent` field is framework-reserved, so an immutable or inherited application-owned field with that name also fails closed. Frozen and sealed ordinary objects use an overlay when necessary: direct reads and reflected accessors expose the trusted snapshot, while methods and getters retain the original receiver for private fields, callable fields retain their own APIs, and arrays retain their brand. Application-defined `Symbol.toStringTag` branding does not make an ordinary class context look like a native built-in. Immutable native built-ins such as `Map` and `Date` cannot preserve their internal-slot identity through an overlay and fail closed; wrap them in a fresh mutable request-context object. Use a fresh mutable context when receiver-bound helpers need `agent` or middleware-added fields, because overlay-only state cannot appear on the immutable receiver. Each of these failures arrives as a response — a `500` from `handlePrachtRequest()`, an `internal_error` envelope from `invokeCapability()` — never as a rejection the adapter would have to catch.

Requests that pracht does not route — a custom adapter, a standalone endpoint,
a health check you verify yourself — can run the same verifier directly:

```ts
import { verifyAgentSignature } from "@pracht/core";

const agent = await verifyAgentSignature(request, {
  policy: "observe",
  keys: [{ x: "<base64url Ed25519 public key>", agent: "my-agent.example" }],
});
// PrachtAgentIdentity, or null when unsigned or verification failed
```

It resolves to the same identity `context.agent` carries, takes the same
`webBotAuth` config, and never throws — an unsigned or failing request is
`null`, so the caller decides what that means.

The signed `@authority` must match the URL seen by the runtime. With a
custom-domain route in `wrangler.jsonc`, Cloudflare preview may listen on
localhost while delivering a Worker `Request` whose URL uses the custom
domain. Sign that effective authority or temporarily disable the route. To use
a separate config, run `pracht build`, then
`wrangler dev --config wrangler.local.jsonc --port 3000`; `pracht preview` does
not forward `--config`. Signing `localhost:<port>` in that setup is treated as
unverified.

---

## Policy Modes

`"observe"` identifies agents without blocking anyone — use it to roll out and audit. `"require"` answers unsigned requests to capability HTTP endpoints with a typed `401 agent_required` envelope. The app default can be tightened per capability:

```ts [src/capabilities/agent-ping.ts]
export default defineCapability({
  // ...
  agentPolicy: "require", // this endpoint answers only verified agents
});
```

---

## Destructive Capabilities: Prepare/Commit

Capabilities declaring `effect: "destructive"` (delete, publish, pay, send) may be exposed over HTTP only, and every dispatch is confirmation-gated. Set `PRACHT_CONFIRMATION_SECRET` in the server environment; without it, destructive calls fail closed. For Cloudflare local preview, put the value in a gitignored `.dev.vars` file — prefixing `pracht preview` with a host environment variable does not create a Worker binding.

The first call never runs the capability — it answers with a short-lived token:

```jsonc
// POST /api/capabilities/notes/purge  { "titlePrefix": "Old" }
// → 409
{
  "ok": false,
  "error": {
    "code": "confirmation_required",
    "confirmationToken": "v1.<claims>.<hmac>",
    "expiresAt": 1735689720
  }
}
```

The token is an HMAC over the caller's principal (verified agent key, or `"anonymous"`), the capability name, the canonicalized input, and an expiry. Committing means repeating the call with identical input plus the `x-pracht-confirm` header — tampered, expired, different-input, or different-principal tokens are rejected with `403`, fail closed.

From your own browser code, the typed client spells out both halves and sets the header for you. Once `pracht typegen` has registered the effect class, omitting both options is a compile error rather than a 409 you discover at runtime:

```ts [src/islands/PurgeButton.tsx]
import { callCapability } from "virtual:pracht/capabilities";

const prepared = await callCapability("notes.purge", { titlePrefix: "Old" }, { prepare: true });

const confirmationToken =
  !prepared.ok && prepared.error.code === "confirmation_required"
    ? prepared.error.confirmationToken
    : undefined;

if (confirmationToken) {
  await callCapability("notes.purge", { titlePrefix: "Old" }, { confirm: confirmationToken });
}
```

Agent hosts cannot yet be trusted to carry this two-step flow faithfully, so destructive capabilities cannot be exposed over WebMCP — `defineCapability()`, the runtime, and `pracht verify` all enforce it.

Two things a stateless HMAC cannot do on its own: stop a captured token being replayed until it expires, and prove a *person* agreed — the calling agent receives the token and can hand it straight back to itself. Registering an approval store fixes replay; enabling human mode additionally requires a person's decision.

---

## Durable Approvals

Register a store and prepare records a **proposal**; commit consumes it exactly once. Callers still just echo the token they were handed. Store-backed tokens use a distinct version and bind the approval mode, so an older replica or one still configured for token mode rejects a human-mode token instead of bypassing the store or approval decision.

```ts [src/server/approvals.ts]
import {
  createMemoryApprovalStore,
  setCapabilityApprovalPrincipalResolver,
  setCapabilityApprovalStore,
} from "@pracht/core/server";

export const approvalStore = createMemoryApprovalStore();
setCapabilityApprovalStore(approvalStore);
setCapabilityApprovalPrincipalResolver<{ user: { id: string } }>(
  ({ context }) => context.user.id,
);
```

Import this setup from a server entry or registered server-only module. The resolver runs after middleware and must return a stable authenticated user or tenant id, never caller-controlled input. When Web Bot Auth is present, the proposal binds both the application user and verified agent. The raw application identity stays in the server-side approval record; caller-visible confirmation tokens bind a secret-keyed digest instead of exposing it.

The proposal id is a secret-keyed digest derived server-side from the principal, capability, canonicalized input, and approval mode — never supplied by a caller. Keying prevents caller-visible ids from revealing low-entropy application user or tenant ids through offline guessing. Repeated prepares for the same operation and mode address one proposal, so a person approves *the action* rather than one particular token. The HMAC is verified before the store is touched, so a forged token can never destroy a live proposal.

`agents.confirmation.mode` picks who decides:

| Mode | Commit requires | Adds |
| --- | --- | --- |
| `"token"` (default) | a valid token | exactly-once across replicas |
| `"human"` | a valid token **and** an approved proposal | a real human decision |

```ts [src/routes.ts]
export const app = defineApp({
  agents: { confirmation: { mode: "human", ttlSeconds: 900 } },
});
```

In `"human"` mode a commit for an undecided proposal answers `409` with `code: "confirmation_pending"` and the `approvalId`. A person decides out of band, through a surface you build and gate with your own auth — pracht ships no approval endpoint, because who may approve is an application decision:

```ts [src/api/admin/approvals.ts]
import { approvalStore } from "../../server/approvals.ts";

export async function GET() {
  return Response.json(await approvalStore.listPending());
}

export async function POST({ request, context }: ApiRouteArgs) {
  const { id, decision } = await request.json();
  return Response.json({
    ok: await approvalStore.decide(id, decision, context.user.email),
  });
}
```

`createMemoryApprovalStore()` is correct for one instance — use it in tests and development. For a real deployment, implement `CapabilityApprovalStore` over a backend with **conditional writes** (D1, Durable Objects, Postgres, Redis; *not* Cloudflare KV): `create()` must atomically insert-if-absent without overwriting an existing proposal, and `consume()` must be a compare-and-set.

### Production Store Checklist

Every method participates in the approval boundary. A production adapter should preserve these semantics:

| Method | Required behaviour |
| --- | --- |
| `create(record)` | Insert atomically. On a live id conflict, return the stored proposal unchanged; replace it only after expiry. A repeated prepare must not reset a decision, resurrect a consumed proposal, or extend its lifetime. |
| `get(id)` / `listPending()` | Return snapshots rather than mutable references to backing state. `listPending()` includes only unexpired proposals still awaiting a decision. |
| `decide(id, decision, by)` | Atomically move an unexpired `pending` proposal to `approved` or `rejected`. Refuse unknown, expired, already-decided, or consumed proposals. |
| `consume(id)` | Compare-and-set the eligible proposal to `consumed`, enforcing the proposal's stored `requiresApproval` value. When approval is required, only `approved` is eligible; otherwise `pending` or `approved` may be consumed. Concurrent commits must produce exactly one success. |

Approval records contain the validated capability input and the raw application principal so a reviewer can understand who requested what. Treat both as sensitive server-side data: protect review endpoints with your own authentication and authorization, avoid logging records wholesale, and apply retention or deletion after expiry according to your application's policy.

The in-memory reference store defensively clones records on input and output. Custom stores should provide the same snapshot behaviour even when their database client already deserializes rows into new objects; it keeps application code from changing approval state without an atomic store operation.

Four behaviours to know before enabling it: `mode: "human"` without both a store and an authenticated principal fails closed; a valid token whose proposal is unknown is refused, so prepare and commit must reach the same store; consumed or rejected operations cannot be proposed again until their TTL expires; and any store or principal-resolver exception closes the gate.

---

## Audit Trail

Every capability dispatch — HTTP or direct `invokeCapability()` — emits one structured event with the capability name, effect, transport, outcome, status, latency, and the verified agent identity (or `null`):

```ts [src/server/audit.ts]
import { setCapabilityAuditHook } from "@pracht/core/server";

setCapabilityAuditHook((event) => log.info("capability", event));
```

Hooks receive frozen event and agent snapshots, and exceptions are swallowed —
auditing can neither rewrite trusted request identity nor break a request.

A capability that calls `invokeCapability()` produces a second event with `transport: "server"` and `via` set to the transport of the request it ran under, so an effect a remote agent triggered through a composing MCP tool reads as `{ transport: "server", via: "mcp" }` rather than looking like an ordinary loader call. `via` is `null` for top-level dispatches and outside a served request.

### Registering More Than One Sink

`setCapabilityAuditHook()` is a single slot — calling it twice replaces the hook. An app that wants both structured logs and metrics uses `addCapabilityAuditListener(name, hook)`, which composes with the single slot and with every differently-named sink, and returns an unsubscribe handle:

```ts [src/server/audit.ts]
import { addCapabilityAuditListener } from "@pracht/core/server";

const stop = addCapabilityAuditListener("metrics", (event) => metrics.record(event));

if (import.meta.hot) {
  import.meta.hot.dispose(stop);
}
```

The name is required, and registering the same name again **replaces** that sink. That is what makes the call safe at a module's top level, which is where it belongs. In dev, `@pracht/core` is inlined into Vite's SSR graph and Vite re-executes importers on every save, so a module-scope registration runs again with a fresh closure each time you edit the file. Keyed by name the reload replaces; keyed by function identity it would accumulate one live sink per keystroke, each delivering the same event again and inflating every counter. Pick a stable name per sink (`"otel"`, `"audit-log"`), not a computed one.

Register the returned unsubscribe with Vite's HMR disposal hook, as above. The stable name prevents duplicate delivery when a reload replaces the sink, while disposal removes the old name when the module is deleted or the name changes. The unsubscribe only removes its own registration, so cleanup running after a new registration cannot delete the live sink. Delivery snapshots the registered sinks before invoking any of them, so a sink added or replaced from inside a callback starts receiving events on the next dispatch rather than receiving the current event twice.

Every registered sink receives the same frozen snapshot for every dispatch, on every transport. The contract for all of them:

| Guarantee | What it means for your sink |
| --- | --- |
| Never throws into dispatch | A throwing sink is swallowed. Its first failure is reported via `console.warn`, naming the sink; later failures from that sink stay quiet rather than logging one line per capability call. Warn-once is per sink, so a broken log sink cannot silence a broken metrics sink. |
| Never awaited | The hook returns `void`. Returning a promise is fine and the runtime does not wait for it, so an async exporter adds no latency — but an unhandled rejection is yours to catch. |
| Runs everywhere | No Node-only APIs, so the same sink works on Node, Workers, Vercel, and Netlify. |

**Cloudflare Workers caveat.** Work started inside a sink but unfinished when the response is returned may be cancelled once the request context ends. Pracht does not call `ctx.waitUntil()` for you — it holds no handle on your sink's promises. A batching exporter must either flush within the request or be handed the execution context by your own code, for example `context.executionContext.waitUntil(exporter.flush())` from a middleware or API route.

### Production Recipes

A plain structured log is the whole loop for most apps — one line per dispatch, queryable by capability, transport, and outcome:

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
      agent: event.agent?.agentDomain ?? null,
    }),
  );
});

if (import.meta.hot) {
  import.meta.hot.dispose(stopAuditLog);
}
```

The OpenTelemetry version records dispatch counts and schema/authorization failure rates. Derive agent activation from verified identities, MCP, WebMCP, and MCP-caused composition. An unverified HTTP dispatch may instead be a human `<Form capability>` submission or browser-client call:

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
    "pracht.agent": event.agent?.agentDomain ?? "unverified",
  };

  dispatches.add(1, attributes);
  duration.record(event.durationMs, attributes);

  // The dispatch already finished, so the span is backdated to its real start
  // rather than wrapping work that is still running.
  const end = Date.now();
  const span = tracer.startSpan(`capability ${event.capability}`, {
    attributes: { ...attributes, "http.response.status_code": event.status },
    startTime: end - event.durationMs,
  });
  if (event.outcome !== "ok") {
    span.setStatus({ code: SpanStatusCode.ERROR, message: event.outcome });
  }
  span.end(end);
});

if (import.meta.hot) {
  import.meta.hot.dispose(stopOtel);
}
```

Both modules are server-only and imported for their side effect from a middleware, an API route, or a custom server entry — anywhere that runs before the first request is served. See [Logging and observability](/docs/recipes-logging) for the surrounding request-level tracing setup.

### Watching Agent Traffic In Dev

`pracht dev` keeps the last 200 audit events in memory and renders them as the **Agents** section of the `/_pracht` devtools page — timestamp, capability, transport, effect, verified agent, outcome with error code, and duration, one row per dispatch, newest first. Nested composition shows both ends of the causal chain (`http → server`).

The same data is available as machine-readable JSON at `/_pracht.json`:

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

`recorded` is the total since the dev server started, so the panel can say how many older events the ring buffer dropped. Transport counts and empty-state conclusions only describe the retained events; once older events have been dropped, the panel does not claim whether those older dispatches were external or first-party. This is a development tool only: the buffer lives in the Vite dev middleware, so nothing about it reaches a production bundle, adapter, or endpoint. Under adapter-owned dev servers (Cloudflare `workerd`) that middleware is never registered, so `/_pracht` and `/_pracht.json` do not exist there at all — they 404 rather than answering with an empty log.

The JSON keeps every recorded dispatch and carries `transport` on each, so consumers filter for themselves. The page separates three categories. Verified identities, MCP, WebMCP, and MCP-caused composition are **agent-attributed**. Top-level unverified HTTP stays visible but is counted separately because the same endpoint serves human `<Form capability>` and browser-client calls. Ordinary `invokeCapability()` composition is hidden behind a "show first-party" toggle. An unsigned `via: "http"` dispatch is first-party because an ordinary page loader's composition carries the same provenance. A non-null verified identity qualifies as agent-attributed, including when the agent enters through a page or ordinary API route and that composed dispatch is its only row.

### What Is Not Audited

The audit trail covers *dispatch*. Several rejections happen before a capability is dispatched and emit no event at all:

- **Cross-origin mutation requests** are refused with a `cross_origin_blocked` 403 before the capability pipeline is entered.
- **Unknown capability paths** never match a capability route, so they fall through to ordinary route matching and answer 404.
- **Unknown or unexposed MCP tool names** are answered as a JSON-RPC `invalid_params` protocol error before dispatch.

An agent — or a scanner — enumerating tool names or probing capability URLs therefore leaves no trace in the audit trail. Absence of events is not evidence that nothing tried. Use the deployment's HTTP access log for reconnaissance detection, and treat the audit trail as the record of what actually ran.

To see the *configured* surface rather than live traffic, run [`pracht inspect agents`](/docs/cli#pracht-inspect). Its `llmsTxt` state comes from the Vite plugin's resolved configuration, including computed options, rather than a source-text guess.

### Remote MCP Composition Is Guarded

`invokeCapability()` is trusted first-party composition. It runs the callee's own pipeline — input validation, its named middleware, `run()`, output validation — without re-running app-level `api.middleware`, so private capabilities remain useful as server-side building blocks.

Remote MCP adds two fail-closed rules: nested calls re-apply the callee's `agentPolicy` and refuse `destructive` effects before middleware or the body can run. Private non-destructive capabilities remain composable, with named middleware as their authorization seam. HTTP and WebMCP composition keep the ordinary server semantics and must own any transport-specific authorization they need. Under any served HTTP or MCP request, nested context and audit identity remain bound to what the transport verified rather than a replacement `context.agent` passed to `invokeCapability()`. Every nested attempt still audits with `transport: "server"` and trusted provenance in `via`.

---

## pracht eval: Prove Agent Flows in CI

Can an agent actually complete a task through your capabilities? `pracht eval` runs scripted scenarios against your live app's agent surface and exits 1 on any failed expectation:

```jsonc [evals/notes.eval.json]
{
  "name": "notes agent flow",
  "steps": [
    { "capability": "notes.search", "input": { "query": "roadmap" } },
    {
      "capability": "notes.purge",
      "input": { "titlePrefix": "Old" },
      "expect": { "status": 409, "errorCode": "confirmation_required" }
    },
    {
      "capability": "notes.purge",
      "input": { "titlePrefix": "Old" },
      "confirm": "$steps[1].error.confirmationToken",
      "expect": { "ok": true, "output": { "purged": 1 } }
    }
  ]
}
```

`$steps[n].<path>` references carry values between steps — the `confirm` field above threads the prepare/commit flow through a scenario without spelling out the header name. One command runs it — `--start` launches your app, waits for it to answer, runs the scenarios, and stops it:

```sh
pracht eval --start "pracht preview"    # runs evals/**/*.eval.json

# …or manage the server yourself:
pracht preview                          # in another terminal
pracht eval --url http://localhost:3000
```

### The Same Scenario Over Remote MCP

An `expose.mcp` capability is only proven when an MCP host can actually call it. Add one line and the same scenario runs over the [remote MCP endpoint](/docs/remote-mcp) instead: the runner performs a real `initialize` handshake, then issues every step as a `tools/call` with the projected tool name (`notes.search` → `notes_search`).

```jsonc [evals/notes-mcp.eval.json]
{
  "name": "notes agent flow over MCP",
  "transport": "mcp",              // default is "http"
  "mcpPath": "/mcp",               // optional; only if you moved the endpoint
  "steps": [
    { "capability": "notes.search", "input": { "query": "roadmap" } },
    {
      "capability": "notes.search",
      "input": { "query": "" },
      // The identical expectation the HTTP scenario writes.
      "expect": { "ok": false, "status": 400, "errorCode": "invalid_input" }
    }
  ]
}
```

Expectations mean the same thing on both transports — including `status`. `ok` is the tool result's `isError` inverted, `output` matches its `structuredContent`, `errorCode` reads the error metadata the projection attaches to a failed call, and `status` is the **capability dispatch status**, which the projection reports alongside the result. It is deliberately not the JSON-RPC POST status: every answered `tools/call` is a transport-level `200`, so asserting that would let `"status": 200` pass on a call that failed. Scenarios stay portable between transports as a result. A `signAs` identity signs the JSON-RPC POSTs exactly as it signs HTTP requests, so an `agentPolicy: "require"` capability is provable over MCP too.

Two things do not carry over, and both fail loudly rather than quietly. A capability the endpoint does not project — anything without `expose.mcp` — fails the scenario with the tool name it looked for and what to do about it. And the destructive confirmation flow is not exercisable over MCP yet: destructive capabilities cannot declare `expose.mcp`, so no MCP tool can answer `confirmation_required`. The `confirm` field is wired for the transport (the token rides in the call's `_meta`, since MCP has no per-call header channel), but until destructive-over-MCP lands, run confirmation scenarios over HTTP. Step `headers` are similarly limited: the projection forwards only `authorization`, so any other header on an MCP step fails the scenario instead of silently never arriving.

The [Testing recipe](/docs/recipes/testing) covers the rest of the agent-surface toolbox: unit testing the full dispatch pipeline with `createCapabilityTestHost()` — including this confirmation flow and simulated agent identities — plus Playwright patterns, faking the WebMCP API, and signing Web Bot Auth requests in tests.
