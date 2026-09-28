---
title: Agent Trust
lead: Who is calling, may they do this, and what happened? Verified agent identity with Web Bot Auth, a prepare/commit confirmation flow for destructive operations, structured audit events, and `pracht eval` to prove agent flows in CI.
breadcrumb: Agent Trust
prev:
  href: /docs/standalone-capabilities
  title: Standalone Capabilities
next:
  href: /docs/coding-agents
  title: Coding Agents
---

> **Both routers.** `defineApp({ agents })` configures Web Bot Auth, confirmation, and remote MCP. [Pages-router](/docs/routing#app-config-via-appconfigts) apps export the same object as `agents` from `src/pages/_app.config.ts`.

## Three Questions

Exposing [capabilities](/docs/capabilities) to agents raises three questions a schema cannot answer. All of this is opt-in: an app with no capabilities and no `agents` config drops it from the server bundle.

- **Who is calling?** Web Bot Auth puts a verified agent identity on the request context. On the remote MCP endpoint, [OAuth](#oauth-on-the-remote-mcp-endpoint) also says *on whose behalf* the agent acts.
- **May they do this?** Policy modes per app and per capability, plus server-verified confirmation for destructive effects, optionally with exactly-once commits and human approval.
- **What happened?** One structured audit event per capability dispatch.

---

## Web Bot Auth: Verified Agent Identity

Agents sign requests with [RFC 9421 HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421) and publish Ed25519 public keys in a well-known directory. Configure the verifier in the manifest. The keys are public, so they are safe there:

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

pracht verifies once per request, on every adapter. Middleware, loaders, API routes, and capabilities read the result:

```ts [src/capabilities/agent-whoami.ts]
async run({ context }) {
  context.agent; // { verified: true, agentDomain, keyId } | null
}
```

Verification fails closed: an expired, incomplete, or untrusted signature gives `context.agent = null`, never a partial identity. `context.agent` is read-only, so middleware cannot rewrite it before policy and audit checks.

If you build the request context yourself, create a fresh, mutable, plain object per request. Reusing one object for different identities, giving it a read-only or inherited `agent` field, or using a frozen or sealed native built-in such as `Map` fails closed: `handlePrachtRequest()` answers `500` and `invokeCapability()` returns `internal_error`. A frozen or sealed context works, but its methods and getters cannot see `agent`.

For requests pracht does not route, such as a custom adapter or a standalone endpoint, run the same verifier directly:

```ts
import { verifyAgentSignature } from "@pracht/core";

const agent = await verifyAgentSignature(request, {
  policy: "observe",
  keys: [{ x: "<base64url Ed25519 public key>", agent: "my-agent.example" }],
});
// PrachtAgentIdentity, or null when unsigned or verification failed
```

It takes the same `webBotAuth` config, returns the same identity as `context.agent`, and never throws.

### Signing Requests as an Agent

The signer ships next to the verifier, at `@pracht/core/agent-auth`:

```ts
import { signAgentRequest } from "@pracht/core/agent-auth";

const response = await fetch(
  await signAgentRequest(new Request(url, { method: "POST", body }), {
    agent: "https://my-agent.example",
    privateKeyJwk,
  }),
);
```

`pracht eval` scenarios sign with the same identity through a `signAs` block, which lets a scenario cover an `agentPolicy: "require"` capability.

The signature covers `@authority`, so sign the host the server sees. With a custom-domain route in `wrangler.jsonc`, Cloudflare preview hands the Worker the custom domain even on `localhost`, so a `localhost:<port>` signature fails. Sign the custom domain, disable the route, or run `pracht build` then `wrangler dev --config wrangler.local.jsonc --port 3000` (`pracht preview` does not forward `--config`).

---

## Policy Modes

`"observe"` (the default) identifies agents without blocking anyone. Use it to roll out and audit. `"require"` refuses HTTP, WebMCP, and remote MCP calls that lack a verified agent with a typed `401 agent_required` envelope. Pages, API routes, and your own `invokeCapability()` calls outside remote MCP are not gated; check `context.agent` in middleware for those.

Tighten the app default per capability:

```ts [src/capabilities/agent-ping.ts]
export default defineCapability({
  // ...
  agentPolicy: "require", // this endpoint answers only verified agents
});
```

---

## OAuth on the Remote MCP Endpoint

Web Bot Auth says which agent software is calling. OAuth says which user it acts for. On the [remote MCP endpoint](/docs/capabilities#remote-mcp-tools-for-agents-without-a-browser), `agents.mcp.auth` makes `/mcp` an OAuth 2.0 protected resource. It publishes RFC 9728 metadata at `/.well-known/oauth-protected-resource`, answers unauthenticated calls with the `WWW-Authenticate` challenge MCP hosts follow, and passes the token to your `verify` module.

```ts [src/routes.ts]
export const app = defineApp({
  agents: {
    mcp: {
      auth: {
        resource: "https://app.example.com/mcp",
        authorizationServers: ["https://auth.example.com"],
        scopesSupported: ["notes.read"],
        verify: () => import("./server/mcp-token.ts"),
      },
    },
  },
});
```

pracht is only the resource server: it does not validate JWTs, fetch JWKS, or issue tokens. Your `verify` module checks the token, and the verified principal lands on read-only `context.tokenAuth`.

Audit events for authenticated MCP calls, including nested server calls, carry `tokenAuth: { subject, clientId }`; other dispatches carry `null`. Tokens, scopes, and other claims are never included.

The metadata document, the challenge responses, and a JWKS `verify` recipe are on the [Capabilities page](/docs/capabilities#oauth-letting-a-real-host-connect).

---

## Destructive Capabilities: Prepare/Commit

Capabilities with `effect: "destructive"` (delete, publish, pay, send) can be exposed over HTTP and [remote MCP](/docs/capabilities#destructive-tools), never as a WebMCP page tool. Every dispatch needs confirmation.

Set `PRACHT_CONFIRMATION_SECRET` in the server environment; without it, destructive calls fail closed. For Cloudflare local preview, put it in a gitignored `.dev.vars` file. A shell variable in front of `pracht preview` does not reach the Worker.

The first call never runs the capability. It answers with a short-lived token:

```jsonc
// POST /api/capabilities/notes/purge  { "titlePrefix": "Old" }
// → 409  — the "v1" prefix is the stateless HMAC form; an app that registers
//   an approval store issues "v2" and adds an approvalId.
{
  "ok": false,
  "error": {
    "code": "confirmation_required",
    "confirmationToken": "v1.<claims>.<hmac>",
    "expiresAt": 1735689720
  }
}
```

The token is bound to the caller (verified agent key, or `"anonymous"`), the capability, the exact input, and an expiry. To commit, repeat the call with identical input plus the `x-pracht-confirm` header. A tampered, expired, or mismatched token gets `403`.

Try it with two `curl`s against the [`examples/basic`](https://github.com/JoviDeCroock/pracht/tree/main/examples/basic) app:

```sh
# 1. Prepare. The capability does not run.
curl -s -X POST http://localhost:3000/api/capabilities/notes/purge \
  -H 'content-type: application/json' -d '{"titlePrefix":"Old"}'
# → 409
# { "ok": false, "error": { "code": "confirmation_required",
#     "message": "Capability \"notes.purge\" is destructive. To commit, repeat the call…",
#     "confirmationToken": "v2....", "expiresAt": 1735689720, "approvalId": "…" } }

# 2. Commit. Identical input, plus the token.
curl -s -X POST http://localhost:3000/api/capabilities/notes/purge \
  -H 'content-type: application/json' \
  -H 'x-pracht-confirm: v2....' \
  -d '{"titlePrefix":"Old"}'
# → { "ok": true, "data": { "purged": 1 } }
```

The token is `v2` with an `approvalId` because `examples/basic` [registers an approval store](#durable-approvals). Change one character of the body on the second call and the commit fails.

From browser code, the typed client sets the header for you. After `pracht typegen`, calling a destructive capability without `prepare` or `confirm` is a compile error:

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

Remote MCP runs the same exchange on `tools/call`, with the token in `_meta["io.pracht/confirmation"]`. It is off by default and needs [two more opt-ins](/docs/capabilities#destructive-tools): `agents.mcp.destructive` and a registered approval store.

The stateless token has two limits. A captured token can be replayed until it expires, and the calling agent can hand the token straight back to itself, so no person agrees. An approval store fixes replay; human mode adds a person's decision.

---

## Durable Approvals

Register a store and prepare records a **proposal**, which commit consumes exactly once. Callers still just echo the token they were handed.

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

Import this module from a server entry, the destructive capability's module, or middleware applied to that capability or to the app's capability API chain. Importing it from unrelated middleware is not enough.

The principal resolver runs after middleware. Return a stable authenticated user or tenant id, never caller-controlled input. With Web Bot Auth also on, a proposal binds both the user and the agent.

Repeated prepares of the same operation share one proposal, so a person approves *the action*, not one particular token.

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

In `"human"` mode, committing an undecided proposal answers `409 confirmation_pending` with the `approvalId`. A person decides out of band. pracht ships no approval endpoint, so build one and gate it with your own auth:

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

Before enabling a store, know that:

- `mode: "human"` without both a store and an authenticated principal fails closed.
- Prepare and commit must reach the same store. A valid token whose proposal is unknown is refused.
- Any exception from the store or principal resolver closes the gate.
- `createMemoryApprovalStore()` is for tests and development. It is lost on restart and not shared across replicas.

### `createSqlApprovalStore()`: the Durable One

For a real deployment, use the SQL store from `@pracht/core/server`. It has no driver dependency: you pass a parameterized-query function, and it works on Postgres, Cloudflare D1, and SQLite/Turso.

```ts [src/server/approvals.ts]
import { createSqlApprovalStore, setCapabilityApprovalStore } from "@pracht/core/server";

export const approvalStore = createSqlApprovalStore({
  dialect: "postgres",            // "sqlite" (default, `?`) | "postgres" ($1, $2, …)
  // table: "pracht_approvals",   // default; plain identifier or schema.identifier
  execute: (sql, params) => pool.query(sql, params),
});

setCapabilityApprovalStore(approvalStore);
```

One migration works on every backend. Keep the `PRIMARY KEY`; the store relies on it to create proposals atomically.

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

`execute(sql, params)` must return the driver's result. The store reads rows from `rows` or `results` and the count from `rowsAffected`, `rowCount`, `changes`, or `meta.changes`; if a write reports no count, the store throws and the gate closes. Common driver shapes work as-is:

```ts
// Postgres (pg / Neon / Supabase) — dialect: "postgres"
execute: (sql, params) => pool.query(sql, params),

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

For Cloudflare D1, bind the database as `DB` in `wrangler.jsonc` and import the request-time binding:

```ts
import { env } from "cloudflare:workers";

createSqlApprovalStore({
  execute: (sql, params) => env.DB.prepare(sql).bind(...params).all(),
});
```

Expired rows are swept at most once per `sweepIntervalSeconds` (default 60).

### Writing Your Own

For a non-SQL backend, implement `CapabilityApprovalStore` over anything with **conditional writes**, such as Durable Objects or Redis. Cloudflare KV cannot do this.

### Production Store Checklist

| Method | Required behaviour |
| --- | --- |
| `create(record)` | Insert atomically. If a live proposal has the same id, return it unchanged; replace it only after expiry. |
| `get(id)` / `listPending()` | Return copies, not references to stored state. `listPending()` returns only unexpired, undecided proposals. |
| `decide(id, decision, by)` | Atomically move an unexpired `pending` proposal to `approved` or `rejected`. Refuse anything else. |
| `consume(id)` | Compare-and-set to `consumed`. If the stored `requiresApproval` is true, only `approved` qualifies; otherwise `pending` or `approved`. Concurrent commits: exactly one succeeds. |

### Know the Lockout Window

A consumed or rejected proposal stays in the store until it expires. Until then, preparing the identical operation (same caller, capability, input, and mode) answers `confirmation_invalid` (reason `already_used`, or `rejected` for a rejected proposal) with `retryAfterSeconds`.

- Without Web Bot Auth or a principal resolver, every caller is `"anonymous"`, so all unauthenticated agents share the lockout. Bind a real principal before serving destructive tools to more than one caller.
- `agents.confirmation.ttlSeconds` (default 120) sets both the token lifetime and the lockout. Give repeatable operations a per-call input such as an idempotency key, as the bundled notes evals do.

Approval records hold the input and the raw application principal. Treat them as sensitive: gate review endpoints, don't log records wholesale, and delete them after expiry.

---

## Audit Trail

Every capability dispatch emits one event: capability, effect, transport, outcome, status, latency, and the verified agent (or `null`).

```ts [src/server/audit.ts]
import { setCapabilityAuditHook } from "@pracht/core/server";

setCapabilityAuditHook((event) => log.info("capability", event));
```

Hooks receive frozen snapshots, and a throwing hook never breaks the request.

When a capability calls `invokeCapability()`, the nested call emits its own event with `transport: "server"` and `via` set to the outer request's transport. An effect a remote agent triggered through a composing MCP tool reads as `{ transport: "server", via: "mcp" }`. `via` is `null` for top-level dispatches.

### Registering More Than One Sink

`setCapabilityAuditHook()` is a single slot; a second call replaces it. To run several sinks, use `addCapabilityAuditListener(name, hook)`. It returns an unsubscribe function:

```ts [src/server/audit.ts]
import { addCapabilityAuditListener } from "@pracht/core/server";

const stop = addCapabilityAuditListener("metrics", (event) => metrics.record(event));

if (import.meta.hot) {
  import.meta.hot.dispose(stop);
}
```

Registering the same name again replaces that sink. Register at module top level with a fixed name (`"otel"`, `"audit-log"`) so dev reloads replace the sink instead of stacking duplicates, and pass the unsubscribe to `import.meta.hot.dispose`.

| Guarantee | What it means for your sink |
| --- | --- |
| Never throws into dispatch | Errors are swallowed; the first one logs a `console.warn` naming the sink. |
| Never awaited | It runs synchronously, so keep work before its first `await` cheap. A returned promise goes to [`waitUntil()`](/docs/data-loading#waituntil), so an `async` sink finishes after the response on every adapter. |
| Runs everywhere | One sink works on Node, Workers, Vercel, and Netlify. |

### Production Recipes

A plain structured log, one line per dispatch, is enough for most apps:

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

The OpenTelemetry version records dispatch counts, latency, and failure spans. Treat only verified identities and MCP traffic as known agent activity. Unsigned HTTP may be a person submitting a `<Form capability>`, and the WebMCP transport marker is set by the client.

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

Import both modules from an eagerly loaded server module, such as your adapter's `createContextFrom` module or a custom server entry. Route, API, middleware, and `src/server/` modules load lazily, so a sink imported only from one of them can miss earlier calls. See [Logging and observability](/docs/recipes/logging) for request-level tracing.

### Watching Agent Traffic In Dev

`pracht dev` keeps the last 200 audit events and shows them in the **Agents** section of `/_pracht`, newest first. Nested composition shows both ends of the chain (`http → server`). The same data is JSON at `/_pracht.json`:

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

`recorded` counts every event since the dev server started, so you can see how many were dropped. This is dev-only and never reaches production. Adapter-owned dev servers (Cloudflare `workerd`) do not serve `/_pracht` at all; both paths return 404 there.

The panel counts verified identities, MCP calls, and their nested calls as **agent-attributed**. Unsigned HTTP and WebMCP calls show as unverified **dispatches**, since a person or any client may have sent them. `invokeCapability()` work outside a served request sits behind a "show first-party" toggle.

### What Is Not Audited

The audit trail records dispatches only. Cross-origin mutations (`cross_origin_blocked`), unknown paths under `/api/capabilities/*` (`unknown_capability`), and unknown or unexposed MCP tool names are rejected before dispatch and emit no event. Use your HTTP access log to spot probing.

To see the *configured* surface rather than live traffic, run [`pracht inspect agents`](/docs/cli#pracht-inspect). It reports each capability's exposure and the MCP endpoint's OAuth settings. If its `llmsTxt` state reads `unknown`, upgrade `@pracht/vite-plugin`.

### Remote MCP Composition Is Guarded

`invokeCapability()` runs the callee's own pipeline (validation, its named middleware, `run()`) but not app-level `api.middleware`, so private capabilities work as server-side building blocks.

Under remote MCP, nested calls also re-apply the callee's `agentPolicy` and keep the verified OAuth principal. They refuse `destructive` callees unless the tool being served is itself a destructive capability that cleared prepare/commit.

That confirmation covers the whole request: the confirmed tool's own code may call any destructive capability, private ones included, any number of times. The agent never picks those callees, so a tool's effect class is your promise about everything it composes.

HTTP and WebMCP composition add no rules: the exposed capability's policy and each callee's named middleware must authorize nested work. Under a served HTTP or MCP request, nested calls keep the verified identity even if you pass a different `context.agent` or `context.tokenAuth`.

---

## pracht eval: Prove Agent Flows in CI

`pracht eval` runs scripted scenarios against your live app's agent surface and exits 1 on any failed expectation. This is the scenario `examples/basic` ships:

```jsonc [evals/notes.eval.json]
{
  "name": "notes agent flow",
  "task": "Search notes, hit a validation failure, then purge with the confirmation flow.",
  "steps": [
    {
      "capability": "notes.search",
      "input": { "query": "capabilities" },
      "expect": { "ok": true, "status": 200 }
    },
    {
      "capability": "notes.search",
      "input": { "query": "" },
      "expect": { "ok": false, "status": 400, "errorCode": "invalid_input" }
    },
    {
      "capability": "notes.create",
      "input": { "title": "Purge target", "body": "Created by pracht eval." },
      "expect": { "ok": true, "output": { "note": { "title": "Purge target" } } }
    },
    {
      "capability": "notes.purge",
      "input": {
        "titlePrefix": "Purge target",
        "idempotencyKey": "$steps[2].data.note.id"
      },
      "expect": { "ok": false, "status": 409, "errorCode": "confirmation_required" }
    },
    {
      "capability": "notes.purge",
      "input": {
        "titlePrefix": "Purge target",
        "idempotencyKey": "$steps[2].data.note.id"
      },
      "confirm": "$steps[3].error.confirmationToken",
      "expect": { "ok": true }
    }
  ]
}
```

`$steps[n].<path>` carries values between steps; `confirm` threads the prepare/commit token. `--start` launches your app, waits for it to answer, runs the scenarios, and stops it:

```sh
pracht eval --start "pracht preview"    # runs evals/**/*.eval.json

# …or manage the server yourself:
pracht preview                          # in another terminal
pracht eval --url http://localhost:3000
```

Each step reports the capability's own dispatch status and latency:

```
PASS  notes agent flow  (evals/notes.eval.json)
  ✓ 1. notes.search → ok (200, 12ms)
  ✓ 2. notes.search → invalid_input (400, 3ms)
  ✓ 3. notes.create → ok (200, 5ms)
  ✓ 4. notes.purge → confirmation_required (409, 4ms)
  ✓ 5. notes.purge → ok (200, 6ms)

PASS  notes agent flow over MCP  [mcp]  (evals/notes-mcp.eval.json)
  ✓ 1. notes.search → ok (200, 15ms)
  ✓ 2. notes.search → invalid_input (400, 4ms)
  ✓ 3. notes.create → ok (200, 7ms)
  ✓ 4. notes.purge → confirmation_required (409, 5ms)
  ✓ 5. notes.purge → ok (200, 8ms)

2 scenario(s) passed, 0 failed.
```

### The Same Scenario Over Remote MCP

Add `"transport": "mcp"` and the scenario runs against the [remote MCP endpoint](/docs/capabilities#remote-mcp-tools-for-agents-without-a-browser) the way a host drives it: an `initialize` handshake, then a `tools/call` per step with the projected tool name (`notes.search` → `notes_search`). That is the `[mcp]` run above.

```jsonc [evals/notes-mcp.eval.json — transport keys]
{
  "name": "notes agent flow over MCP",
  "transport": "mcp",              // default is "http"
  "mcpPath": "/mcp",               // optional; only if you moved the endpoint
  "mcpHeaders": {                    // when agents.mcp.auth protects the endpoint
    "authorization": "Bearer test-token"
  },
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

Expectations mean the same on both transports, so scenarios are portable. `status` is the capability's dispatch status, not the JSON-RPC response's blanket `200`. `signAs` signs MCP requests too.

`mcpHeaders.authorization` is sent on every MCP request; a step's own `authorization` header overrides it. Keep real tokens out of committed scenarios and inject a test token in CI.

A capability without `expose.mcp` fails the scenario with a message naming the missing tool. Destructive `confirm` steps work once the app enables [`agents.mcp.destructive` and an approval store](/docs/capabilities#destructive-tools). MCP steps forward only the `authorization` header; any other header fails the scenario.

### Explicit Invocation Over WebMCP

`"transport": "webmcp"` with a `"webmcpRoute"` launches Chrome, discovers the page tool, and runs only the steps you wrote:

```jsonc [evals/notes-webmcp.eval.json]
{
  "name": "notes through WebMCP",
  "transport": "webmcp",
  "webmcpRoute": "/notes",
  "steps": [
    {
      "capability": "notes.search",
      "input": { "query": "roadmap" },
      "expect": { "ok": true }
    },
    {
      "capability": "notes.search",
      "input": { "query": "roadmap" },
      "cancelAfterMs": 0,
      "expect": { "ok": false, "status": 499, "errorCode": "cancelled" }
    }
  ]
}
```

`cancelAfterMs` proves that host cancellation reaches your dispatch. WebMCP scenarios reject headers, confirmation tokens, and `signAs`. Chrome 150+ is required; pin it in CI with `--browser /path/to/chrome`.

The [Testing recipe](/docs/recipes/testing) covers the rest: unit-testing the dispatch pipeline with `createCapabilityTestHost()`, including confirmation and simulated agent identities, plus browser tests and signing Web Bot Auth requests in tests.
