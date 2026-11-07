---
title: Agent trust
lead: Verify agent identity with Web Bot Auth, refuse unverified agents, and confirm destructive operations with prepare/commit and durable approvals.
---

Both routers support everything on this page. Configure it with `defineApp({ agents })`, or export the same object as `agents` from `src/pages/_app.config.ts` in a [pages-router](/docs/pages-router#app-config-via-appconfigts) app. It is all opt-in: without capabilities or `agents` config, none of it reaches the server bundle.

| To | Use |
| --- | --- |
| Identify the calling agent | [Web Bot Auth](#web-bot-auth-verified-agent-identity) (`context.agent`) |
| Identify the user an MCP agent acts for | [OAuth](#oauth-on-the-remote-mcp-endpoint) (`context.tokenAuth`) |
| Refuse unverified agents | [Policy modes](#policy-modes) |
| Confirm deletes, payments, and sends | [Prepare/commit](#destructive-capabilities-preparecommit) and [durable approvals](#durable-approvals) |
| Record every dispatch | [Audit trail](/docs/agent-audit) |
| Test agent flows in CI | [`pracht eval`](/docs/agent-eval) |

## Web Bot Auth: verified agent identity

Add a `webBotAuth` block to verify agents that sign requests with [RFC 9421 HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421). The Ed25519 keys are public, so they are safe in the manifest:

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

pracht verifies once per request on every adapter. Middleware, loaders, API routes, and capabilities read the result:

```ts [src/capabilities/agent-whoami.ts]
async run({ context }) {
  context.agent; // { verified: true, agentDomain, keyId } | null
}
```

An expired, incomplete, or untrusted signature gives `context.agent = null`. `context.agent` is read-only.

| Option | Default | Purpose |
| --- | --- | --- |
| `policy` | `"observe"` | App-wide [policy mode](#policy-modes). |
| `keys` | none | Trusted public keys: `x`, optional `kid` and `agent` label. |
| `directories` | none | Origins whose key directory may be fetched. Others fail verification. |
| `requireComponents` | none | Components a signature must cover, such as `["@method", "@path"]`. |
| `maxLifetimeSeconds` | `86400` | Longest accepted signature lifetime. |

A default signature covers only the host, so it verifies on any path until it expires. When the identity gates access, set `requireComponents: ["@method", "@path"]` and a lower `maxLifetimeSeconds`; signatures missing a listed component count as unsigned.

If you build the request context yourself, pass a fresh, mutable, plain object per request; otherwise `handlePrachtRequest()` answers `500`.

For requests pracht does not route, call the verifier directly. It takes the same config and never throws:

```ts
import { verifyAgentSignature } from "@pracht/core";

const agent = await verifyAgentSignature(request, {
  policy: "observe",
  keys: [{ x: "<base64url Ed25519 public key>", agent: "my-agent.example" }],
});
// PrachtAgentIdentity, or null when unsigned or verification failed
```

### Sign requests as an agent

Sign outgoing requests with `signAgentRequest()` from `@pracht/core/agent-auth`:

```ts
import { signAgentRequest } from "@pracht/core/agent-auth";

const response = await fetch(
  await signAgentRequest(new Request(url, { method: "POST", body }), {
    agent: "https://my-agent.example",
    privateKeyJwk,
  }),
);
```

Pass `additionalComponents: ["@method", "@path"]` when the server sets `requireComponents`. `pracht eval` scenarios sign through a `signAs` block with the same `agent` and `privateKeyJwk`, so a scenario can cover an `agentPolicy: "require"` capability.

Sign the host the server sees. A Cloudflare custom-domain route in `wrangler.jsonc` hands the Worker the custom domain even on `localhost`, so a `localhost:<port>` signature fails there. Sign the custom domain, disable the route, or run `pracht build` then `wrangler dev --config wrangler.local.jsonc --port 3000` (`pracht preview` does not forward `--config`).

## Policy modes

| Mode | Behaviour |
| --- | --- |
| `"observe"` (default) | Identifies agents and serves everyone. |
| `"require"` | Answers capability calls over HTTP, WebMCP, and remote MCP without a verified agent with `401 agent_required`. |

Pages, API routes, and your own `invokeCapability()` calls outside remote MCP are not gated; check `context.agent` in middleware for those.

Tighten the app default per capability:

```ts [src/capabilities/agent-ping.ts]
export default defineCapability({
  // ...
  agentPolicy: "require", // this endpoint answers only verified agents
});
```

## OAuth on the remote MCP endpoint

Set `agents.mcp.auth` to make the [remote MCP endpoint](/docs/mcp-tools#remote-mcp-tools-for-agents-without-a-browser) an OAuth 2.0 protected resource, so you know which user an agent acts for:

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

`/mcp` then publishes RFC 9728 metadata at `/.well-known/oauth-protected-resource` and answers unauthenticated calls with a `WWW-Authenticate` challenge. pracht does not validate JWTs or issue tokens: your `verify` module checks the bearer token, and the principal lands on read-only `context.tokenAuth`.

The challenge responses and a JWKS `verify` recipe are in [OAuth: letting a real host connect](/docs/mcp-tools#oauth-letting-a-real-host-connect).

## Destructive capabilities: prepare/commit

Mark a capability `effect: "destructive"` (delete, publish, pay, send) and every dispatch needs confirmation. It can be exposed over HTTP and [remote MCP](/docs/mcp-tools#destructive-tools), never as a WebMCP page tool.

Set `PRACHT_CONFIRMATION_SECRET` in the server environment; without it, destructive calls are refused. For Cloudflare local preview, put it in a gitignored `.dev.vars` file; a shell variable does not reach the Worker.

The first call never runs the capability. It answers `409` with a short-lived token:

```jsonc
// POST /api/capabilities/notes/purge  { "titlePrefix": "Old" }
// → 409. "v1" is the stateless HMAC token; with an approval store it is "v2" plus an approvalId.
{
  "ok": false,
  "error": {
    "code": "confirmation_required",
    "confirmationToken": "v1.<claims>.<hmac>",
    "expiresAt": 1735689720
  }
}
```

To commit, repeat the call with identical input and the token in the `x-pracht-confirm` header. The token is bound to the caller, the capability, the exact input, and an expiry; any mismatch gets `403 confirmation_invalid`. Try it against the [`examples/basic`](https://github.com/JoviDeCroock/pracht/tree/main/examples/basic) app:

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

The token is `v2` because `examples/basic` [registers an approval store](#durable-approvals). From browser code, the typed client sets the header. After `pracht typegen`, calling a destructive capability without `prepare` or `confirm` is a compile error:

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

Remote MCP runs the same exchange on `tools/call`, with the token in `_meta["io.pracht/confirmation"]`, once you enable [`agents.mcp.destructive` and an approval store](/docs/mcp-tools#destructive-tools).

A stateless token replays until it expires, and the calling agent can confirm its own call. An approval store stops replay; human mode adds a person's decision.

## Durable approvals

Register an approval store and prepare records a proposal that commit consumes exactly once. Callers still echo the token they were handed.

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

Import this module from a server entry, the destructive capability's module, or middleware applied to that capability or the capability API chain. A hand-written Node server must import it before `dist/server/server.js`.

The principal resolver runs after middleware. Return a stable authenticated user or tenant id, never caller-controlled input. On remote MCP with [`agents.mcp.auth`](/docs/mcp-tools#oauth-letting-a-real-host-connect), the token subject is bound too. Repeated prepares of the same operation by the same user share one proposal.

`agents.confirmation.mode` picks who decides:

| Mode | Commit requires | Adds |
| --- | --- | --- |
| `"token"` (default) | a valid token | exactly-once across replicas |
| `"human"` | a valid token **and** an approved proposal | a person's decision |

```ts [src/routes.ts]
export const app = defineApp({
  agents: { confirmation: { mode: "human", ttlSeconds: 900 } },
});
```

In `"human"` mode, committing an undecided proposal answers `409 confirmation_pending` with the `approvalId`. pracht ships no approval endpoint, so build one and gate it with your own auth:

```ts [src/api/admin/approvals.ts]
import type { ApiRouteArgs } from "@pracht/core";

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

Before enabling a store:

- `mode: "human"` needs an end-user identity: a principal resolver, or `agents.mcp.auth` on MCP. With neither, the server refuses to start and `pracht build` and `pracht verify` fail. A Web Bot Auth key does not count.
- Prepare and commit must reach the same store, or the commit is refused.
- `createMemoryApprovalStore()` is for tests and development: it is lost on restart and not shared across replicas.
- Records hold the input and the raw principal. Gate review endpoints and delete records after expiry.

### SQL approval store

In production, use `createSqlApprovalStore()` from `@pracht/core/server`. It takes a parameterized-query function, so it works on Postgres, Cloudflare D1, and SQLite/Turso:

```ts [src/server/approvals.ts]
import { createSqlApprovalStore, setCapabilityApprovalStore } from "@pracht/core/server";

export const approvalStore = createSqlApprovalStore({
  dialect: "postgres",            // "sqlite" (default, `?`) | "postgres" ($1, $2, …)
  // table: "pracht_approvals",   // default; plain identifier or schema.identifier
  execute: (sql, params) => pool.query(sql, params),
});

setCapabilityApprovalStore(approvalStore);
```

Run this migration on any backend. Keep the `PRIMARY KEY`; the store relies on it to create proposals atomically.

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

`execute(sql, params)` returns the driver's result. The store reads rows from `rows` or `results` and the write count from `rowsAffected`, `rowCount`, `changes`, or `meta.changes`. Common drivers work as-is:

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

### Custom approval store

For a non-SQL backend, implement `CapabilityApprovalStore` over storage with conditional writes, such as Durable Objects or Redis (not Cloudflare KV).

| Method | Required behaviour |
| --- | --- |
| `create(record)` | Insert atomically. If a live proposal has the same id, return it unchanged; replace it only after expiry. |
| `get(id)` / `listPending()` | Return copies, not references to stored state. `listPending()` returns only unexpired, undecided proposals. |
| `decide(id, decision, by)` | Atomically move an unexpired `pending` proposal to `approved` or `rejected`. Return `false` for anything else. |
| `consume(id)` | Compare-and-set to `consumed`. If the stored `requiresApproval` is true, only `approved` qualifies; otherwise `pending` or `approved`. Of concurrent commits, exactly one succeeds. |

### Lockout window

Until a consumed or rejected proposal expires, preparing the identical operation answers `confirmation_invalid` (reason `already_used` or `rejected`) with `retryAfterSeconds`.

- `agents.confirmation.ttlSeconds` (default 120) sets both the token lifetime and the lockout. Give repeatable operations a per-call input such as an idempotency key.
- Without Web Bot Auth or a principal resolver, every caller is `"anonymous"` and shares the lockout. Bind a real principal before serving destructive tools to more than one caller.

## Remote MCP composition is guarded

`invokeCapability()` runs the callee's validation, named middleware, and `run()`, but not app-level `api.middleware`, so private capabilities work as server-side building blocks.

Under remote MCP, nested calls re-apply the callee's `agentPolicy` and refuse `destructive` callees unless the served tool is itself destructive and cleared prepare/commit. A tool's effect class is therefore your promise about everything it composes. HTTP and WebMCP composition add no rules: the exposed capability's policy and each callee's middleware must authorize nested work.
