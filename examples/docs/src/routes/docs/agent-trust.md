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

Capabilities declaring `effect: "destructive"` (delete, publish, pay, send) may be exposed over HTTP and over [remote MCP](/docs/remote-mcp#destructive-tools), never as a WebMCP page tool, and every dispatch is confirmation-gated. Set `PRACHT_CONFIRMATION_SECRET` in the server environment; without it, destructive calls fail closed. For Cloudflare local preview, put the value in a gitignored `.dev.vars` file — prefixing `pracht preview` with a host environment variable does not create a Worker binding.

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

A browser host's approval UX is not a security boundary, so destructive capabilities cannot be exposed over WebMCP — `defineCapability()`, the runtime, and `pracht verify` all enforce it. Remote MCP is different: the same server-verified exchange happens on `tools/call`, with the token in `_meta["io.pracht/confirmation"]` instead of a header. It stays off by default and needs [two more opt-ins](/docs/remote-mcp#destructive-tools): `agents.mcp.destructive` and a registered approval store, because a token handed to a remote agent has to be consumable exactly once.

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

Import this setup from a server entry, the destructive capability module, or middleware applied to the app's capability API chain or that capability. Remote MCP imports those applied middleware modules before checking its destructive-tool preconditions; their middleware functions still run only on `tools/call`. Merely registering unrelated middleware is not a startup hook. The resolver runs after middleware and must return a stable authenticated user or tenant id, never caller-controlled input. When Web Bot Auth is present, the proposal binds both the application user and verified agent. The raw application identity stays in the server-side approval record; caller-visible confirmation tokens bind a secret-keyed digest instead of exposing it.

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

`createMemoryApprovalStore()` is correct for one instance — use it in tests and development. It is lost on restart and not shared across replicas.

### `createSqlApprovalStore()`: the Durable One

For a real deployment, use the SQL store. It ships in `@pracht/core/server` with **no driver dependency**: you pass a parameterized-query function, and the same store works on Postgres, Cloudflare D1, and SQLite/Turso.

```ts [src/server/approvals.ts]
import { createSqlApprovalStore, setCapabilityApprovalStore } from "@pracht/core/server";

export const approvalStore = createSqlApprovalStore({
  dialect: "postgres",            // "sqlite" (default, `?`) | "postgres" ($1, $2, …)
  // table: "pracht_approvals",   // default; plain identifier or schema.identifier
  execute: (sql, params) => pool.query(sql, params),
});

setCapabilityApprovalStore(approvalStore);
```

One migration works everywhere. Timestamps are unix seconds, `input` is JSON text, and `requires_approval` is an **integer** 0/1 rather than a boolean, so one DDL and one set of statements stay valid on Postgres and SQLite alike:

```sql
CREATE TABLE IF NOT EXISTS pracht_approvals (
  id                TEXT    PRIMARY KEY,
  principal         TEXT    NOT NULL,
  capability        TEXT    NOT NULL,
  input_hash        TEXT    NOT NULL,
  input             TEXT    NOT NULL,
  requires_approval INTEGER NOT NULL,
  created_at        BIGINT  NOT NULL,
  expires_at        BIGINT  NOT NULL,
  state             TEXT    NOT NULL,
  decided_by        TEXT,
  decided_at        BIGINT
);
CREATE INDEX IF NOT EXISTS pracht_approvals_pending ON pracht_approvals (state, expires_at);
CREATE INDEX IF NOT EXISTS pracht_approvals_expires_at ON pracht_approvals (expires_at);
```

The `PRIMARY KEY` is load-bearing. `create()` is an `INSERT … ON CONFLICT (id) DO UPDATE … WHERE expires_at < now`, so a live proposal is never overwritten by a concurrent re-prepare and an expired one is replaced atomically. `consume()` is a single conditional `UPDATE` carrying the whole eligibility rule, so two concurrent commits produce exactly one winner — the database decides, not the process. Nothing uses `RETURNING`, which D1 and SQLite before 3.35 cannot be relied on for; the store reads the affected-row count every driver reports. Expired rows are swept opportunistically (at most once per `sweepIntervalSeconds`, default 60).

`execute(sql, params)` must return the driver's result so the store can read both rows and the affected-row count. Every mainstream shape is accepted (`rows`/`results`, `rowCount`/`rowsAffected`/`changes`/`meta.changes`), so it is usually a one-liner:

```ts
// Postgres (pg / Neon / Supabase) — dialect: "postgres"
execute: (sql, params) => pool.query(sql, params),

// Cloudflare D1 — bind the database as `DB` in wrangler.jsonc
execute: (sql, params) => env.DB.prepare(sql).bind(...params).all(),

// better-sqlite3 / node:sqlite — reads and writes take different calls
async execute(sql, params) {
  const statement = db.prepare(sql);
  return /^\s*SELECT/i.test(sql)
    ? { rows: statement.all(...params) }
    : { changes: statement.run(...params).changes };
},

// Turso / @libsql/client — ResultSet carries both rows and rowsAffected
execute: (sql, params) =>
  turso.execute({ sql, args: params as (string | number | null)[] }),
```

If a write's result carries no affected-row count the store throws rather than assuming success, and the gate closes. The `table` option cannot be a bound parameter, so it is validated at construction as a plain identifier or `schema.identifier`, then every segment is quoted before interpolation. SQL keywords and case-sensitive names therefore work without broadening the accepted syntax.

### Writing Your Own

For a non-SQL backend, implement `CapabilityApprovalStore` over anything with **conditional writes** (Durable Objects, Redis; *not* Cloudflare KV): `create()` must atomically insert-if-absent without overwriting an existing proposal, and `consume()` must be a compare-and-set.

### Production Store Checklist

Every method participates in the approval boundary. A production adapter should preserve these semantics:

| Method | Required behaviour |
| --- | --- |
| `create(record)` | Insert atomically. On a live id conflict, return the stored proposal unchanged; replace it only after expiry. A repeated prepare must not reset a decision, resurrect a consumed proposal, or extend its lifetime. |
| `get(id)` / `listPending()` | Return snapshots rather than mutable references to backing state. `listPending()` includes only unexpired proposals still awaiting a decision. |
| `decide(id, decision, by)` | Atomically move an unexpired `pending` proposal to `approved` or `rejected`. Refuse unknown, expired, already-decided, or consumed proposals. |
| `consume(id)` | Compare-and-set the eligible proposal to `consumed`, enforcing the proposal's stored `requiresApproval` value. When approval is required, only `approved` is eligible; otherwise `pending` or `approved` may be consumed. Concurrent commits must produce exactly one success. |

#### Know the Lockout Window

A decided proposal — consumed or rejected — stays in the store until `expiresAt`. That is the safety property: it is what stops a still-valid old token becoming reusable after a commit. The consequence is worth planning for, because it surprises people.

Proposal identity is `(principal, capability, canonical input, mode)`. So for `ttlSeconds` after a successful commit, **the identical operation cannot be prepared again** and answers `confirmation_invalid` with reason `already_used`. The error carries `retryAfterSeconds` and says so in its message, so an agent can back off rather than read it as a broken token and retry in a loop.

Two things follow:

- Without Web Bot Auth or `setCapabilityApprovalPrincipalResolver()`, every caller is the principal `"anonymous"` — so the lockout is shared across *all* unauthenticated agents. One agent purging `{ titlePrefix: "Old" }` locks that exact call out for everyone until it expires. Bind a real principal before you serve destructive tools to more than one caller.
- Tune `agents.confirmation.ttlSeconds` with this in mind: it is both how long a token stays valid and how long a completed operation stays closed. Genuinely repeatable operations usually differ in their input (an id, a timestamp); ones that do not should either carry an idempotency key in their schema or accept the window.

The bundled notes evals demonstrate the idempotency-key pattern: each purge carries the freshly created note id as `idempotencyKey`, so rerunning `pracht eval` against one long-lived server proposes a distinct operation without weakening replay protection.

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
| Never throws into dispatch | A throwing sink is swallowed. Its first failure is reported via `console.warn`, naming the sink; later failures from that sink stay quiet rather than logging one line per capability call. Warn-once is per named registration, so a broken log sink cannot silence a broken metrics sink even when both reuse the same callback. |
| Never awaited | The hook is invoked synchronously, so keep work before its return or first `await` cheap. A returned promise is not awaited; its asynchronous continuation does not add dispatch latency, but an unhandled rejection is yours to catch. |
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
      agent: event.agent?.agentDomain ?? event.agent?.keyId ?? null,
    }),
  );
});

if (import.meta.hot) {
  import.meta.hot.dispose(stopAuditLog);
}
```

The OpenTelemetry version records dispatch counts and schema/authorization failure rates. Derive trusted agent activation from verified identities, MCP, and MCP-caused composition. Unsigned HTTP and WebMCP dispatches are ambiguous: the former may be a human `<Form capability>` submission or browser-client call, and the latter is only a client-declared marker:

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

Both modules are server-only. Import them from an eagerly loaded server module: the configured adapter `createContextFrom` module is one portable option, and a custom server entry can import them directly. Route, API, middleware, and `src/server/` registry modules are lazy, so importing the sink only from an unrelated registered module can miss earlier capability calls. See [Logging and observability](/docs/recipes-logging) for the surrounding request-level tracing setup.

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

`recorded` is the total since the dev server started, so the panel can say how many older events the ring buffer dropped. Transport counts and empty-state conclusions only describe the retained events; once older events have been dropped, the panel does not claim whether those older dispatches were external or first-party. The buffer also outlives app-graph HMR, so removing the final capability keeps its retained traffic visible until the dev server restarts; an app that has never registered a capability or recorded a dispatch still omits the Agents section. This is a development tool only: the buffer lives in the Vite dev middleware, so nothing about it reaches a production bundle, adapter, or endpoint. Under adapter-owned dev servers (Cloudflare `workerd`) that middleware is never registered, so `/_pracht` and `/_pracht.json` do not exist there at all — they 404 rather than answering with an empty log.

The JSON keeps every recorded dispatch and carries `transport` on each, so consumers filter for themselves. The page separates three categories. Verified identities, MCP, and MCP-caused composition are **agent-attributed**. Top-level unsigned HTTP, HTTP-caused composition (`transport: "server"`, `via: "http"`), and WebMCP stay visible but are counted as unverified client **dispatches** because the request may come from a person, an unsigned agent, or another client, while the WebMCP marker is caller-controlled. Only `invokeCapability()` work with no served-request provenance is hidden behind a "show first-party" toggle. A non-null verified identity qualifies as agent-attributed, including when the agent enters through a page or ordinary API route and that composed dispatch is its only row.

### What Is Not Audited

The audit trail covers *dispatch*. Several rejections happen before a capability is dispatched and emit no event at all:

- **Cross-origin mutation requests** are refused with a `cross_origin_blocked` 403 before the capability pipeline is entered.
- **Unknown paths under the default `/api/capabilities/*` prefix** answer the typed `unknown_capability` 404 before ordinary route matching. An unmatched custom capability path can instead fall through to an application route.
- **Unknown or unexposed MCP tool names** are answered as a JSON-RPC `invalid_params` protocol error before dispatch.

An agent — or a scanner — enumerating tool names or probing capability URLs therefore leaves no trace in the audit trail. Absence of events is not evidence that nothing tried. Use the deployment's HTTP access log for reconnaissance detection, and treat the audit trail as the record of what actually ran.

To see the *configured* surface rather than live traffic, run [`pracht inspect agents`](/docs/cli#pracht-inspect). Its `llmsTxt` state comes from the Vite plugin's resolved production server-build configuration, including computed options, rather than a source-text guess or the development configuration. When the CLI is newer than an installed Vite plugin that does not expose that metadata yet, the state is `null` in JSON and `unknown` in text until the plugin is upgraded — never a false opt-out.

### Remote MCP Composition Is Guarded

`invokeCapability()` is trusted first-party composition. It runs the callee's own pipeline — input validation, its named middleware, `run()`, output validation — without re-running app-level `api.middleware`, so private capabilities remain useful as server-side building blocks.

Remote MCP adds two fail-closed rules: nested calls re-apply the callee's `agentPolicy`, and refuse `destructive` effects before middleware or the body can run unless the tool being served is itself a destructive capability that already cleared prepare/commit.

That is a **scope, not a per-callee check**, and the difference matters. One cleared confirmation opens the request's whole private destructive graph to that tool's own server code — any destructive callee, private ones included, any number of times, with inputs the tool chooses. It is the same deal HTTP has always offered a confirmed destructive endpoint, and the boundary is the same one: first-party `run()` code picks the callees, so the effect class you gave that tool is the promise you are making about them. What the rule buys is that the *agent* never picks them — it cannot reach a destructive effect except through a tool it confirmed by name and input, a `read` or `write` tool has no such scope, and the scope dies with the request. Private non-destructive capabilities remain composable, with named middleware as their authorization seam. HTTP and WebMCP composition keep the ordinary server semantics and must own any transport-specific authorization they need. Under any served HTTP or MCP request, nested context and audit identity remain bound to what the transport verified rather than a replacement `context.agent` passed to `invokeCapability()`. Every nested attempt still audits with `transport: "server"` and trusted provenance in `via`.

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

Transport differences fail loudly rather than quietly. A capability the endpoint does not project — anything without `expose.mcp` — fails the scenario with the tool name it looked for and what to do about it. Destructive confirmation scenarios work when the app enables [`agents.mcp.destructive` and an approval store](/docs/remote-mcp#destructive-tools): the `confirm` token rides in the call's `_meta["io.pracht/confirmation"]` field, since MCP has no per-call header channel. Step `headers` remain limited: the projection forwards only `authorization`, so any other header on an MCP step fails the scenario instead of silently never arriving.

The [Testing recipe](/docs/recipes/testing) covers the rest of the agent-surface toolbox: unit testing the full dispatch pipeline with `createCapabilityTestHost()` — including this confirmation flow and simulated agent identities — plus Playwright patterns, faking the WebMCP API, and signing Web Bot Auth requests in tests.
