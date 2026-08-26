# Agent Trust Layer

The agent trust layer answers three questions about the capability graph
(see [CAPABILITIES.md](CAPABILITIES.md)):

- **Who is calling?** — Web Bot Auth verification puts a cryptographically
  verified agent identity on the request context.
- **May they do this?** — policy modes per app and per capability, plus a
  server-verified prepare/commit confirmation flow for destructive
  capabilities, optionally backed by a durable approval store for
  exactly-once commits and, in human mode, real human approval.
- **What happened?** — a structured audit event for every capability
  dispatch, and `pracht eval` to test agent task flows in CI.

Everything is opt-in and zero-cost when unused. An app without
`defineApp({ agents })` and without destructive capabilities pays a single
property check per request — and when the build can prove the manifest
registers neither capabilities nor agents, the verifier and the capability
dispatch are dropped from the server bundle entirely (see
[CAPABILITIES.md](CAPABILITIES.md#cost-when-unused)).

## Web Bot Auth: verified agent identity

Web Bot Auth is the emerging standard (implemented by major CDNs) where an
agent signs its requests with [RFC 9421 HTTP Message
Signatures](https://www.rfc-editor.org/rfc/rfc9421) and publishes its public
keys in a well-known directory. Pracht implements both sides — the verifier
below, and the signer at [`@pracht/core/agent-auth`](#signing-requests-as-an-agent) — of:

- [draft-meunier-web-bot-auth-architecture-02](https://www.ietf.org/archive/id/draft-meunier-web-bot-auth-architecture-02.html)
  — the protocol: covered components, signature parameters, the
  `web-bot-auth` tag;
- [draft-meunier-http-message-signatures-directory-03](https://www.ietf.org/archive/id/draft-meunier-http-message-signatures-directory-03.html)
  — key discovery: an Ed25519 JWKS at
  `/.well-known/http-message-signatures-directory`, `keyid` as the RFC
  7638/8037 JWK SHA-256 thumbprint.

A signed agent request carries three headers:

```text
Signature-Agent: "https://signature-agent.example"
Signature-Input: sig1=("@authority" "signature-agent");created=1735689600;
                 expires=1735693200;keyid="poqkLGiy...";alg="ed25519";
                 nonce="...";tag="web-bot-auth"
Signature: sig1=:jdq0SqOwHdyHr9+r5jw3iYZH6aNGKijYp/EstF4RQTQ=:
```

### Configuration

Verification lives in `defineApp({ agents })` — the same manifest seam as
shells, middleware, and capabilities, and (like them) serializable data only.
Web Bot Auth keys are *public* keys, so they are safe in the manifest even
though the manifest is bundled into the client:

```ts
export const app = defineApp({
  agents: {
    webBotAuth: {
      policy: "observe",                       // app-wide default
      keys: [
        // Statically pinned agents (tests, air-gapped deploys).
        { x: "<base64url Ed25519 public key>", agent: "my-agent.example" },
      ],
      // Origins whose key directory may be fetched (allowlist-only).
      directories: ["https://signature-agent.cloudflare.com"],
      clockSkewSeconds: 60,       // default
      maxLifetimeSeconds: 86_400, // default, per draft guidance
      directoryCacheTtlSeconds: 300,
    },
  },
  // capabilities, routes, ...
});
```

The runtime (`handlePrachtRequest`) verifies once per request — all adapters
(Node, Cloudflare, Netlify, Vercel) share the implementation because it only uses Web
platform APIs (`Headers`, `fetch`, `crypto.subtle`; Ed25519 works on Node ≥
20, Workers, and Vercel Edge). The result surfaces on the request context for
middleware, loaders, API routes, and capability `run()`:

```ts
async run({ context }) {
  context.agent; // { verified: true, agentDomain, keyId } | null
}
```

`context.agent` is only set when `agents.webBotAuth` is configured; it is
`null` for unsigned or unverifiable requests. The framework binds it as a
read-only, immutable snapshot: middleware may derive its own authorization
state elsewhere on `context`, but cannot rewrite the verified identity seen by
later capability policy or audit checks. Adapters should create a fresh context
for each request; once the framework binds an identity directly to a context,
rebinding that object to a different identity fails closed rather than exposing
the previous request's identity through context methods or getters. The
`agent` field is reserved for the framework; an immutable or inherited
application-owned field with that name also fails closed because it cannot be
safely hidden from receiver-bound context behavior. When a frozen or sealed
ordinary object needs an overlay, direct context reads and reflected accessors
expose the trusted snapshot while application methods and getters keep the
original receiver so private fields remain valid. Callable fields retain their
own properties and construction surface while using that receiver. Arrays keep
their array brand, and an application-defined `Symbol.toStringTag` does not
make an ordinary class context look like a native built-in. Immutable native
built-ins such as `Map` and `Date` cannot preserve their internal-slot identity
through an overlay and fail closed; wrap them in a fresh mutable request-context
object instead. Receiver-bound helpers
cannot observe fields that exist only on the overlay, so use a fresh mutable
context when helpers need `agent` or middleware-added state.

Every one of these failures is delivered as a response, not as a rejection the
adapter would have to catch: `handlePrachtRequest()` answers `500` (with the
binding failure's guidance in the body under `debugErrors`, and the details
logged once to `console.error`), and `invokeCapability()` returns an
`internal_error` envelope.

### Verification rules (fail closed)

A signature verifies only when **all** of the following hold; any failure
yields `context.agent = null`, never a partial identity:

- `Signature-Input`/`Signature` parse as RFC 8941 structured fields and the
  member's `tag` is `web-bot-auth`;
- covered components include `@authority` (and `signature-agent` whenever the
  header is present, per the draft);
- `created`/`expires` are present, `created ≤ now ≤ expires` within the
  configured clock skew, and the lifetime is within `maxLifetimeSeconds`;
- `alg`, when present, is `ed25519`;
- the `keyid` resolves to a trusted key: a configured static key, or a key in
  the agent's directory — fetched only when the `Signature-Agent` origin is
  explicitly allowlisted in `directories` (https only, redirects refused,
  64 KB response cap, 5 s timeout, in-memory TTL cache). No allowlist means
  no fetching — this is deliberate: open directory fetching would let any
  request body point your server at attacker-controlled URLs (SSRF);
- the Ed25519 signature verifies over the RFC 9421 signature base via
  WebCrypto.

`@authority` must match the URL seen by the runtime, not necessarily the URL
printed by local tooling. In particular, Cloudflare preview with a configured
custom-domain route can accept traffic on `localhost:<port>` while delivering
a Worker `Request` whose URL uses the custom domain. Sign that effective
authority or temporarily disable the route. To select a separate local config,
run `pracht build` followed by
`wrangler dev --config wrangler.local.jsonc --port 3000`; `pracht preview` does
not forward Wrangler's `--config` flag. Otherwise a valid signature can be
treated as unverified.

For statically pinned keys, `context.agent.agentDomain` is the configured
`agent` label (or `null` when omitted), even if the signed request also sends
`Signature-Agent`. The header's host is used only for keys resolved from an
allowlisted directory.

Replay note: the drafts allow enforcing `nonce` uniqueness with a store;
Pracht's stateless verifier does not (a signature can be replayed against
the same authority until it expires). Bind short `expires` windows and treat
the identity as *authentication*, not as a per-request authorization grant.

### Policy modes

- `"observe"` (default) — identify agents, serve everyone. Use it to roll
  out and to audit who is calling.
- `"require"` — unsigned or unverified requests to **capability HTTP
  endpoints** receive the typed `401 { error: { code: "agent_required" } }`
  envelope. Pages and API routes are not gated (use `context.agent` in
  middleware for those).

The app default can be overridden per capability:

```ts
export default defineCapability({
  // ...
  agentPolicy: "require", // this endpoint answers only verified agents
});
```

`agentPolicy: "require"` fails closed even when `webBotAuth` is not
configured (every request would be 401 — a loud misconfiguration signal).

## Effect classes and the confirmation flow

Every capability declares `read`, `write`, or `destructive`
([CAPABILITIES.md](CAPABILITIES.md#effects)). Destructive capabilities:

- **may set `expose.http`** — every dispatch is gated by the prepare/commit
  flow below, and only when a confirmation secret is configured;
- **may set `expose.mcp`** — same flow, over the [remote MCP
  projection](REMOTE_MCP.md#destructive-tools), and only when the app opts in
  with `agents.mcp.destructive` *and* registers a durable approval store. The
  opt-in is what turns the exposure into a served tool; without it the
  projection filters the capability out;
- **may not set `expose.webmcp`** — a browser host's approval UX is not a
  security boundary and the page cannot be trusted to carry the two-step flow
  faithfully; `defineCapability()`, the registry, and `pracht verify` all
  reject it.

### Prepare/commit

Set `PRACHT_CONFIRMATION_SECRET` in the server environment (or call
`setCapabilityConfirmationSecret()` from `@pracht/core/server` on platforms
without `process.env`). Without it, destructive HTTP calls fail closed with
`403 confirmation_unavailable`, and `pracht verify` fails — verify reads the
environment, so it cannot see a programmatically registered secret and needs the
variable set even for apps that use the escape hatch.

1. **Prepare** — a call without a token never runs the capability. The typed
   browser client makes that intent explicit with `{ prepare: true }`:

   ```ts
   const prepared = await callCapability(
     "notes.purge",
     { titlePrefix: "Old" },
     { prepare: true },
   );
   ```

   ```jsonc
   // POST /api/capabilities/notes/purge  { "titlePrefix": "Old" }
   // → 409
   {
     "ok": false,
     "error": {
       "code": "confirmation_required",
       "message": "…repeat the call with identical input and the x-pracht-confirm header…",
       "confirmationToken": "v1.<claims>.<hmac>",
       "expiresAt": 1735689720
     }
   }
   ```

   Over remote MCP the same exchange happens on `tools/call`: the prepare
   answers `isError: true` with the token in
   `_meta["io.pracht/error"].confirmationToken` (and in the text content, for
   hosts that only read text), and the commit repeats the call with identical
   `arguments` plus `_meta["io.pracht/confirmation"]`. See
   [REMOTE_MCP.md](REMOTE_MCP.md#destructive-tools).

   The token is an HMAC-SHA256 (WebCrypto) over the caller's principal
   (verified agent `keyid`, or `"anonymous"`), the capability name, a hash of
   the canonicalized validated input (stable JSON, sorted keys, defaults
   applied), and an expiry (TTL default 120 s, configurable via
   `agents.confirmation.ttlSeconds`).

2. **Commit** — repeat the call with byte-identical canonical input plus the
   `x-pracht-confirm` header. The server re-derives the binding and runs the
   capability only if everything matches. Tampered, expired,
   different-input, or different-principal tokens → `403
   confirmation_invalid`, fail closed.

   ```ts
   const confirmationToken =
     !prepared.ok && prepared.error.code === "confirmation_required"
       ? prepared.error.confirmationToken
       : undefined;

   if (confirmationToken) {
     await callCapability(
       "notes.purge",
       { titlePrefix: "Old" },
       { confirm: confirmationToken },
     );
   }
   ```

### Honest limitations of the stateless flow

- **Stateless HMAC cannot prevent replay within the TTL.** A captured token
  authorizes the same principal + capability + input until it expires.
  `agents.confirmation.singleUse: true` enables a best-effort in-memory
  cache — per instance, lost on restart, not shared across replicas.
- **Confirmation is not a human decision.** The calling agent receives the
  token and can immediately hand it back to itself. The round trip proves
  deliberateness, not consent.
- **Principal binding is only as strong as the principal.** Without Web Bot
  Auth or `setCapabilityApprovalPrincipalResolver()`, both prepare and commit
  run as `"anonymous"` in token mode. Auth middleware alone does not tell the
  confirmation flow which context field identifies the caller.

Registering an approval store removes the replay gap. Enabling human mode also
removes the self-approval gap; registering an application-principal resolver
binds proposals to your authenticated users.

## Durable approvals

Register a `CapabilityApprovalStore` and the prepare/commit flow gains
storage: prepare records a **proposal**, commit consumes it exactly once. The
caller interaction does not change — callers still just echo the token they
were handed. Store-backed tokens use a distinct version and bind the approval
mode, so an older replica or one still configured for token mode rejects a
human-mode token instead of bypassing the store or approval decision.

```ts
// src/server/approvals.ts — any server-only module
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

Import this setup module from a server entry or a registered server-only
middleware/capability module so it actually runs. The resolver executes after
API and capability middleware, and must return a stable authenticated user or
tenant id — never a display name or caller-controlled value. When Web Bot Auth
is also present, the proposal binds both identities. The raw application
identity stays in the server-side approval record; caller-visible confirmation
tokens bind a secret-keyed digest instead of exposing that identity.

A proposal's id is a secret-keyed digest derived server-side from the
principal, capability name, canonicalized input, and approval mode — never
supplied by a caller. Keying keeps a caller-visible id from becoming an
offline oracle for low-entropy application user or tenant ids. Repeated
prepare calls for the same operation and mode address **one** proposal, so a
person approves an action rather than one particular token, and re-preparing
cannot extend a proposal's life.

The confirmation HMAC keeps doing its job: the signature is verified *before*
the store is touched, so a forged token can never consume (and thereby
destroy) a live proposal.

### Two modes

`agents.confirmation.mode` picks who decides:

| Mode | Commit requires | Adds |
| --- | --- | --- |
| `"token"` (default) | a valid token | exactly-once across replicas |
| `"human"` | a valid token **and** an approved proposal | a real human decision |

```ts
export const app = defineApp({
  agents: { confirmation: { mode: "human", ttlSeconds: 900 } },
  // capabilities, routes, ...
});
```

In `"human"` mode a commit for an undecided proposal answers `409
{ error: { code: "confirmation_pending", approvalId } }` — the agent waits or
gives up, and a person decides out of band:

```ts
// src/api/admin/approvals.ts — mount behind your own auth
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

Who may approve is an application decision, so pracht ships no approval
endpoint or UI — a framework-default approval route would be the same mistake
as trusting host-reported approval.

`mode: "human"` without both a registered store and an authenticated principal
(from Web Bot Auth or the resolver) fails closed with `403
confirmation_unavailable` rather than silently degrading to self-approval or
sharing one approval across unrelated application users.

### `createSqlApprovalStore()`: the first-party durable store

The reference `createMemoryApprovalStore()` is correct for one instance, and it
is what tests and development should use — but it is lost on restart and not
shared across replicas. For a real deployment, use the SQL store. It ships in
`@pracht/core/server` with **no driver dependency**: you pass a parameterized
query function, so the same store works on Postgres, Cloudflare D1, and
SQLite/Turso.

```ts
// src/server/approvals.ts — any server-only module
import { createSqlApprovalStore, setCapabilityApprovalStore } from "@pracht/core/server";

export const approvalStore = createSqlApprovalStore({
  dialect: "postgres",                 // "sqlite" (default, `?`) | "postgres" ($1, $2, …)
  // table: "pracht_approvals",        // default; plain identifier or schema.identifier
  async execute(sql, params) {
    return pool.query(sql, params);    // must report rows *and* affected rows
  },
});

setCapabilityApprovalStore(approvalStore);
```

Import this module from a server entry or a capability module so the
registration runs before the capability graph is served.

#### Schema

One migration works everywhere. Timestamps are unix seconds, `input` is JSON
text, and `requires_approval` is an **integer** 0/1 rather than a boolean, so
one DDL and one set of statements are valid on Postgres and SQLite alike:

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

The `PRIMARY KEY` is load-bearing: `create()` is an
`INSERT … ON CONFLICT (id) DO UPDATE … WHERE expires_at < ?now`, so a live
proposal is never overwritten by a concurrent re-prepare, and an expired one is
replaced atomically. `consume()` is a single conditional `UPDATE` carrying the
whole eligibility rule, so two concurrent commits produce exactly one winner —
the database decides, not the process. Nothing uses `RETURNING`: D1 and SQLite
before 3.35 cannot be relied on for it, so the store reads the affected-row
count every driver reports. Expired rows are swept opportunistically (at most
once per `sweepIntervalSeconds`, default 60), and a failed consume deletes the
dead row it found.

#### `execute` per backend

`execute(sql, params)` must return the driver's result so the store can read
both rows and the affected-row count. Every mainstream shape is accepted
(`rows`/`results`, `rowCount`/`rowsAffected`/`changes`/`meta.changes`), so it is
usually a one-liner. If a write's result carries no affected-row count the store
throws rather than assuming success, and the gate closes.

```ts
// Postgres (pg / Neon / Supabase) — placeholders are $1, $2, …
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

createSqlApprovalStore({
  dialect: "postgres",
  execute: (sql, params) => pool.query(sql, params),
});
```

```ts
// Cloudflare D1 — bind it in wrangler.jsonc as `DB`
createSqlApprovalStore({
  execute: (sql, params) => env.DB.prepare(sql).bind(...params).all(),
});
```

```ts
// better-sqlite3 / node:sqlite — reads and writes take different calls
import Database from "better-sqlite3";
const db = new Database("approvals.db");

createSqlApprovalStore({
  async execute(sql, params) {
    const statement = db.prepare(sql);
    return /^\s*SELECT/i.test(sql)
      ? { rows: statement.all(...params) }
      : { changes: statement.run(...params).changes };
  },
});
```

```ts
// Turso / @libsql/client — ResultSet carries both rows and rowsAffected
import { createClient } from "@libsql/client";
const turso = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

createSqlApprovalStore({
  execute: (sql, params) =>
    turso.execute({ sql, args: params as (string | number | null)[] }),
});
```

The `table` option is interpolated into SQL (identifiers cannot be
parameters), so it is validated at construction: a plain identifier or
`schema.identifier`, nothing else. Everything else travels as a bound
parameter.

### Writing your own store

If your backend is not SQL, implement `CapabilityApprovalStore` over anything
with **conditional writes**:

```sql
-- create(): insert if absent, or replace only an expired row.
INSERT INTO pracht_approvals (...)
VALUES (...)
ON CONFLICT (id) DO UPDATE
   SET principal = EXCLUDED.principal,
       capability = EXCLUDED.capability,
       input_hash = EXCLUDED.input_hash,
       input = EXCLUDED.input,
       requires_approval = EXCLUDED.requires_approval,
       created_at = EXCLUDED.created_at,
       expires_at = EXCLUDED.expires_at,
       state = EXCLUDED.state,
       decided_by = EXCLUDED.decided_by,
       decided_at = EXCLUDED.decided_at
 WHERE pracht_approvals.expires_at < ?now;
-- Return the inserted/replaced row; if no row was returned, read and return
-- the unchanged live conflicting row.

-- consume(): compare-and-set.
UPDATE pracht_approvals
   SET state = 'consumed', consumed_at = ?now
 WHERE id = ?id
   AND expires_at >= ?now
   AND state IN ('pending', 'approved')
   AND (requires_approval = FALSE OR state = 'approved');
-- ok = (rows_affected == 1)
```

Both operations must be atomic. `create()` must never overwrite a proposal
when a prepare races a decision or commit, while `consume()` must be a
compare-and-set rather than a read followed by a write. Otherwise a concurrent
prepare can resurrect a consumed proposal, or two commits can both succeed.
`consume()` must enforce the immutable `requiresApproval` value stored on the
proposal rather than taking that policy from the replica handling the commit.
Cloudflare KV cannot provide these conditional writes; D1, Durable Objects,
Postgres, and Redis can.

Two operational consequences worth knowing before you turn this on:

- **Prepare and commit must reach the same store.** With a store registered, a
  valid token whose proposal is unknown is refused. That is deliberate — a
  misconfigured deployment fails loudly instead of executing twice — but it
  means a per-instance store on a multi-replica deployment breaks commits
  rather than merely weakening them.
- **A failing store closes the gate.** Any exception from `create()` or
  `consume()` answers `403 confirmation_unavailable`; the capability does not
  run.
- **Consumed and rejected proposals stay closed until expiry.** Re-preparing
  the identical operation during that window is refused, which prevents an
  old still-valid token from becoming reusable. After expiry, the operation
  can create a fresh proposal. The refusal carries `retryAfterSeconds` and
  names the window in its message, so an agent backs off instead of reading
  `already_used` as a broken token and retrying in a loop.

  Plan for that window. A proposal is identified by `(principal, capability,
  canonical input, mode)`, so `ttlSeconds` is both how long a token is valid
  and how long a *completed* operation stays closed — and without Web Bot Auth
  or a principal resolver every caller is `"anonymous"`, which makes the
  lockout shared across all unauthenticated agents. Bind a real principal
  before serving destructive tools to more than one caller, and give genuinely
  repeatable operations an input that differs per call (an id, an idempotency
  key) rather than fighting the window.

  The bundled notes evals demonstrate that pattern by carrying the freshly
  created note id as the purge's `idempotencyKey`, so rerunning `pracht eval`
  against one long-lived server proposes a new operation without weakening
  replay protection.

`singleUse` is ignored while a store is registered — the store enforces single
use durably.

## Operational hardening: what the framework does not do (yet)

The capability pipeline enforces contracts, policy, and confirmation. Three
operational concerns deliberately stay outside it for now — treat them as
deployment responsibilities, not solved problems:

- **Rate limiting.** There are no built-in per-principal or per-capability
  limits. Put rate limiting in the capability's named middleware: it runs
  before `run()` on every projection (HTTP and direct invocation), sees
  `context.agent` when Web Bot Auth is enabled, and can short-circuit with a
  429 response. Capability dispatch maps that status to the typed
  `rate_limited` error code and preserves `Retry-After` for HTTP callers. The
  audit hook provides per-capability outcome and latency data to alert on.
- **Write idempotency.** `write` capabilities have no framework idempotency
  helper. Agents retry, and confirmation tokens only gate `destructive`
  effects — so design write inputs to be safely repeatable: accept a
  client-supplied idempotency key in the input schema, or deduplicate inside
  `run()`.
- **Result-size limits.** Request body limits belong to the adapter; there is
  no output-size budget on capability results. Keep outputs bounded (a `limit`
  input with a schema `maximum`, pagination) — oversized results hurt agents
  (context windows) and browsers alike.

## Audit trail

Every capability dispatch — HTTP or direct `invokeCapability()` — emits one
structured event:

```ts
interface CapabilityAuditEvent {
  capability: string;          // "notes.purge"
  effect: "read" | "write" | "destructive";
  transport: "http" | "server" | "webmcp" | "mcp";
  via: "http" | "mcp" | null; // request a "server" dispatch was composed under
  outcome: string;             // "ok" | "invalid_input" | "confirmation_required" | ...
  status: number;
  durationMs: number;
  agent: { verified: true; agentDomain: string | null; keyId: string } | null;
}
```

`"mcp"` is passed as internal dispatch state by the [remote MCP
projection](REMOTE_MCP.md), never inferred from a public request header, so it
is trustworthy. `"webmcp"` reflects the transport marker header
(`CAPABILITY_TRANSPORT_HEADER` from `@pracht/capabilities`) that the generated
WebMCP shim sends with its dispatches, so audit trails can tell in-browser
agent traffic (cookie-authenticated) apart from remote HTTP callers — like any
client-sent header it is informational, not a trust signal. `outcome` values
come from the `CapabilityErrorCode` union exported by `@pracht/capabilities`
(plus `"ok"` and middleware short-circuits).

`via` answers "who caused this?" for composition. A capability that calls
`invokeCapability()` produces a second event with `transport: "server"`, and
`via` carries the transport of the request being served — so an effect a
remote agent triggered through a composing MCP tool reads as
`{ transport: "server", via: "mcp" }` instead of looking like an ordinary
loader call. It is `null` for top-level dispatches (`transport` already says
how they arrived) and outside a served request (test hosts, scripts). It never
reports `"webmcp"`: that marker is client-declared, so it is not trustworthy
enough to attribute a nested effect to.

### Remote MCP composition is guarded

`invokeCapability()` is trusted first-party composition. It runs the callee's
own pipeline — input validation, its named middleware, `run()`, output
validation — and deliberately does not re-run app-level `api.middleware`.
Private capabilities therefore remain useful as server-side building blocks.

Remote MCP adds two fail-closed rules to that model. When an MCP-exposed tool
calls `invokeCapability()`, the nested call re-applies the callee's
`agentPolicy`, and refuses any `destructive` capability before its middleware or
body can run **unless the tool being served is itself a destructive capability
that already cleared prepare/commit**. Nested calls have no confirmation channel
of their own, so that is exactly the condition under which a destructive effect
on this transport has been confirmed by somebody: a `read` or `write` tool can
never lend a remote agent an unconfirmed destructive effect, while a destructive
tool the agent confirmed composes its own helpers exactly as it would under
HTTP. The rule is the same with and without `agents.mcp.destructive` — the
opt-in only decides whether a destructive tool is served at all, and therefore
whether the confirmed case can ever arise.

Be precise about what clearing the gate buys, because it is a **scope, not a
per-callee check**. One cleared confirmation opens the request's whole private
destructive graph to that tool's own server code: any destructive callee,
private ones included, any number of times, with whatever input the tool
chooses. That is the same deal HTTP has always offered a confirmed destructive
endpoint, and the boundary is the same one — first-party `run()` code picks the
callees, and the effect class you gave that tool is the promise you are making
about them. What the rule does buy is that the *agent* never picks them: it
cannot reach a destructive effect except through a tool it confirmed by name and
input.

Private `read` and `write` capabilities remain composable; their named
middleware is still the authorization seam. The confirmed scope belongs to one
request: a later `tools/call` starts closed again.

These extra rules use trusted MCP dispatch state, not the public WebMCP marker.
HTTP and WebMCP composition therefore keep the ordinary server-composition
semantics: if an exposed capability composes sensitive work, its own policy and
the callee's named middleware must authorize it. Every nested attempt, allowed
or denied, carries `transport: "server"` and the trusted causal transport in
`via` for audit attribution. For any composition running under a served HTTP or
MCP request, the nested context and audit event keep the identity verified by
that transport; a replacement `context.agent` passed to `invokeCapability()` is
never treated as verified identity.

Subscribe from any server-only module. Audit hooks receive frozen event and
agent snapshots; exceptions are swallowed, so an observer can neither rewrite
trusted request identity nor break a request:

```ts
import { setCapabilityAuditHook } from "@pracht/core/server";

setCapabilityAuditHook((event) => log.info("capability", event));
```

Custom server entries can also pass `onCapabilityAudit` directly to
`handlePrachtRequest()`; both hooks fire.

### Registering more than one sink

`setCapabilityAuditHook()` is a single slot: calling it twice replaces the
hook. An app that wants both structured logs and metrics uses
`addCapabilityAuditListener(name, hook)`, which composes with the single slot
and with every differently-named sink, and returns an unsubscribe handle:

```ts
import { addCapabilityAuditListener } from "@pracht/core/server";

const stop = addCapabilityAuditListener("metrics", (event) => metrics.record(event));

if (import.meta.hot) {
  import.meta.hot.dispose(stop);
}
```

The name is required, and registering the same name again **replaces** that
sink. That is what makes the call safe at a module's top level, which is where
it belongs: in dev, `@pracht/core` is inlined into Vite's SSR graph and Vite
re-executes importers on every save, so a module-scope registration runs again
with a fresh closure each time you edit the file. Keyed by name, the reload
replaces; keyed by function identity it would accumulate one live sink per
keystroke, each delivering the same event again and inflating every counter.
Pick a stable name per sink (`"otel"`, `"audit-log"`) rather than a computed
one.

Register the returned unsubscribe with Vite's HMR disposal hook, as above. The
stable name prevents duplicate delivery when a reload replaces the sink, while
disposal removes the old name when the module is deleted or the name changes.
The unsubscribe only removes its own registration, so cleanup running after a
new registration cannot delete the live sink. Delivery snapshots the registered
sinks before invoking any of them, so a sink added or replaced from inside a
callback starts receiving events on the next dispatch rather than receiving the
current event twice.

Every registered sink receives the same frozen snapshot for every dispatch, on
every transport. The contract for all of them:

- **Never throws into dispatch.** A sink that throws is swallowed; its first
  failure is reported via `console.warn`, naming the sink, and later failures
  from that sink stay quiet rather than emitting one line per capability call.
  Warn-once is tracked per named registration, so a broken log sink cannot
  silence a broken metrics sink even when both reuse the same callback.
- **Never awaited.** The hook is invoked synchronously, so keep the work it does
  before returning (or before its first `await`) cheap. The hook signature
  returns `void`; a returned promise is not awaited, so its asynchronous
  continuation does not add dispatch latency, but an unhandled rejection is
  yours to catch.
- **Runs everywhere.** No Node-only APIs are involved, so the same sink works
  on Workers, Vercel, Netlify, and Node.

**Workers caveat.** On Cloudflare Workers, work started inside a sink but not
finished before the response is returned may be cancelled when the request
context ends. Pracht does not call `ctx.waitUntil()` on your behalf — it has no
handle on your sink's promises. Batch exporters must either flush
synchronously-enough within the request or be handed the execution context by
your own code (`context.executionContext.waitUntil(exporter.flush())` from a
middleware or API route), which is why the recipes below either log
synchronously or record into an exporter that owns its own flush.

### Production recipes

A plain structured log is the whole loop for most apps — one line per dispatch,
queryable by capability, transport, and outcome:

```ts [src/server/audit.ts]
import { addCapabilityAuditListener } from "@pracht/core/server";

const stopAuditLog = addCapabilityAuditListener("audit-log", (event) => {
  // Synchronous, no allocation beyond the line itself: safe on every runtime.
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

The OpenTelemetry version records dispatch counts and schema/authorization
failure rates. Derive trusted agent activation from verified identities, MCP,
and MCP-caused composition. Unsigned HTTP and WebMCP dispatches are ambiguous:
the former may be a human `<Form capability>` submission or browser-client call,
and the latter is only a client-declared marker:

```ts [src/server/audit-otel.ts]
import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import { addCapabilityAuditListener } from "@pracht/core/server";

const meter = metrics.getMeter("pracht.capabilities");
const dispatches = meter.createCounter("pracht.capability.dispatches");
const duration = meter.createHistogram("pracht.capability.duration", {
  unit: "ms",
});
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

  const completed =
    event.outcome === "ok" || (event.status >= 200 && event.status < 300);

  dispatches.add(1, attributes);
  duration.record(event.durationMs, attributes);

  // The dispatch already finished, so the span is recorded with its real
  // start time rather than wrapping work that is still running.
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

Both modules are server-only. Import them from an eagerly loaded server module:
the configured adapter `createContextFrom` module is one portable option, and a
custom server entry can import them directly. Route, API, middleware, and
`src/server/` registry modules are lazy, so importing the sink only from an
unrelated registered module can miss earlier capability calls. The surrounding
request-level tracing setup lives on the public site's logging and observability recipe
(<https://pracht.resynapse.dev/docs/recipes-logging>).

### Watching agent traffic in dev

`pracht dev` keeps the last 200 audit events in memory and renders them as the
**Agents** section of the [`/_pracht` devtools page](ARCHITECTURE.md), with the
same data under `agentTraffic` in `/_pracht.json`:

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

Events are newest first; `recorded` is the total since the dev server started,
so the panel can say how many older events the ring buffer dropped. The buffer
lives in the vite plugin's dev middleware, so no production adapter, bundle, or
endpoint can reach it. Under adapter-owned dev servers (`ownsDevServer: true`,
e.g. Cloudflare `workerd`) the middleware is never registered at all, so
`/_pracht` and `/_pracht.json` do not exist there — they 404 rather than
answering with an empty log. Transport counts and empty-state conclusions only
describe the retained events; once older events have been dropped, the panel
does not claim whether those older dispatches were external or first-party. The
buffer also outlives app-graph HMR, so removing the final capability keeps its
retained traffic visible until the dev server restarts; an app that has never
registered a capability or recorded a dispatch still omits the Agents section.

The JSON keeps every recorded dispatch and carries `transport` on each, so
consumers filter for themselves. The HTML page separates three categories:
verified identities, MCP, and MCP-caused composition are **agent-attributed**;
top-level unsigned HTTP, HTTP-caused composition (`transport: "server"`,
`via: "http"`), and WebMCP stay visible but are counted as unverified client
**dispatches** because the request may come from a person, an unsigned agent, or
another client, while the WebMCP marker is caller-controlled; only
`invokeCapability()` work with no served-request provenance is hidden behind a
"show first-party" toggle. A non-null verified identity qualifies as
agent-attributed, including when the agent enters through a page or ordinary API
route and that composed dispatch is its only row.

### What is not audited

The audit trail covers *dispatch*. Several rejections happen before a
capability is dispatched, and emit no event at all:

- **Cross-origin mutation requests** are refused with a `cross_origin_blocked`
  403 before the capability pipeline is entered.
- **Unknown paths under the default `/api/capabilities/*` prefix** answer the
  typed `unknown_capability` 404 before ordinary route matching. An unmatched
  custom capability path can instead fall through to an application route.
- **Unknown or unexposed MCP tool names** are answered as a JSON-RPC
  `invalid_params` protocol error before dispatch.

So an agent (or a scanner) enumerating tool names or probing capability URLs
leaves no trace in the audit trail — absence of events is not evidence that
nothing tried. Use the HTTP access log of the deployment for reconnaissance
detection, and treat the audit trail as the record of what actually ran.

### Inspecting the configured surface

Live traffic answers "are agents calling this?". `pracht inspect agents`
answers the other half — "what could they call, and under which guards?" — by
rolling up `defineApp({ agents })` and every capability's exposure into one
report:

```
$ pracht inspect agents
Pracht inspect (manifest mode)

Agents
  webBotAuth=on  policy=require  keys=1  directories=[https://signature-agent.example]
  confirmation=token  ttlSeconds=300  singleUse=true
  mcp=on  endpoint=/mcp
  llmsTxt=on
  exposure  http=3  webmcp=1  mcp=1  private=1
  notes.search  effect=read  transports=http,mcp,webmcp  policy=require (inherited)  http=/api/capabilities/notes/search
  notes.purge  effect=destructive  transports=http  policy=require (inherited)  http=/api/capabilities/notes/purge
```

`--json` emits the same data for CI checks, and the CLI's MCP server exposes it
as the `inspect_agents` tool. The `llmsTxt` state comes from the Vite plugin's
resolved production server-build configuration, including computed options,
rather than a source-text guess or the development configuration. If the CLI is
newer than the installed Vite plugin and that plugin does not expose the resolved
flag yet, the state is `null` in JSON and `unknown` in text instead of being
misreported as disabled; upgrade `@pracht/vite-plugin` to resolve it. Capabilities
with no `expose` config count as `private`: reachable only
through `invokeCapability()`. When capabilities set `expose.mcp` but the
manifest never configures `agents.mcp`, the report calls out that the exposure
is recorded and unserved — the same condition `pracht verify` warns about. An
empty capability list means there are no capability operations; it does not
erase separately reported `llms.txt`, MCP endpoint, or Web Bot Auth surfaces.

## `pracht eval`: scripted agent-task scenarios

`pracht eval [files...]` runs JSON scenarios against a live app's agent surface
and exits 1 on any failed expectation — "can an agent actually complete this
task through my tools?" as a repeatable CI check. A scenario drives either
projection: the capability HTTP endpoints (default) or the
[remote MCP endpoint](REMOTE_MCP.md) via `"transport": "mcp"`.

```bash
pracht eval --start "pracht preview"             # starts the app, runs evals/**/*.eval.json, stops it

pracht preview          # …or manage the server yourself, in another terminal
pracht eval --url http://localhost:3000          # runs evals/**/*.eval.json
pracht eval evals/notes.eval.json --json         # explicit files, CI output
```

`--start "<command>"` spawns the command in its own process group, polls
`--url` (default `http://localhost:3000`) until the server answers (30s
timeout, any HTTP response counts), runs the scenarios, and stops the whole
group afterwards. On timeout or early exit it prints the command's output and
exits 1.

Scenario format (`examples/basic/evals/notes.eval.json` is a working
example):

```jsonc
{
  "name": "notes agent flow",
  "task": "optional human description",
  "url": "http://localhost:3000",   // optional; --url overrides
  "transport": "http",              // or "mcp"; default "http"
  "mcpPath": "/mcp",                // only with "transport": "mcp", when not the default
  "steps": [
    {
      "capability": "notes.purge",   // name → POST /api/capabilities/notes/purge
      "path": "/api/custom",         // optional override for custom expose.http.path
      "input": { "titlePrefix": "Old" },
      "confirm": "$steps[0].error.confirmationToken", // HTTP: sets the confirmation header
      "expect": {
        "ok": false,                        // envelope ok flag
        "status": 409,                      // capability dispatch status (both transports)
        "errorCode": "confirmation_required", // envelope error.code
        "output": { "purged": 1 }           // deep subset match on data
      }
    }
  ]
}
```

- Steps run in order. A step without `expect` must simply succeed
  (`ok: true`).
- **References**: a string value that is exactly
  `$steps[<index>].<dot.path>` resolves against an earlier step's result
  object `{ status, ok, data, error }` — e.g.
  `$steps[0].error.confirmationToken` to carry the confirmation flow, or
  `$steps[1].data.note.id`. References work anywhere in `input`, `headers`,
  and `confirm`; unresolvable references fail the scenario.
- **Confirmation flow**: `confirm` sets the confirmation header without
  spelling out its name. Over HTTP, raw `headers` still work for anything else;
  over MCP only `authorization` is accepted, because the projection synthesizes
  the capability request and copies nothing else — a step that sets any other
  header there fails the scenario rather than sending something that never
  arrives.
- **Signed agent identity**: a scenario-level `signAs` block signs every step
  as a verified Web Bot Auth agent — the only way to reach a capability that
  declares `agentPolicy: "require"`. Per-step `"sign": false` opts a step out,
  so one scenario proves both halves of the policy:

  ```jsonc
  {
    "name": "verified agent identity",
    "signAs": {
      "agent": "https://my-agent.example",
      "privateKeyJwk": { "kty": "OKP", "crv": "Ed25519", "d": "…", "x": "…" }
    },
    "steps": [
      { "capability": "agent.ping", "expect": { "ok": true } },
      {
        "capability": "agent.ping",
        "sign": false,
        "expect": { "ok": false, "status": 401, "errorCode": "agent_required" }
      }
    ]
  }
  ```

  The signature covers `@authority` and carries a `created`/`expires` window,
  so it is computed per request against the URL being called — which is why it
  cannot be expressed as a static `headers` entry. `examples/basic/evals/agent-identity.eval.json`
  is a working example. Keep real private keys out of the repo: read them from
  the environment and write the scenario file in CI, or use a test-only key as
  the example does.
- **MCP transport**: `"transport": "mcp"` makes the runner speak the protocol
  an MCP host speaks — one `initialize` handshake (the newest advertised
  protocol version, negotiated down to whatever the server answers; a version
  Pracht does not speak fails the scenario instead of being adopted), the
  `notifications/initialized` follow-up, then every step as a `tools/call`
  against the app's MCP endpoint (`/mcp` unless `mcpPath` says otherwise),
  with the projection's dot→underscore tool naming (`notes.search` →
  `notes_search`). `signAs` signs the JSON-RPC POSTs exactly as it signs
  HTTP-projection requests, so an agent-identity policy is provable on either
  transport — `examples/basic/evals/agent-identity-mcp.eval.json` proves both
  halves of `agentPolicy: "require"` over `tools/call`.

  **Expectations mean the same thing on both transports**, including `status`.
  `ok` is the tool result's `isError` inverted, `output` matches its
  `structuredContent`, `errorCode` reads the `io.pracht/error` metadata, and
  `status` is the *capability dispatch* status the projection reports in
  `io.pracht/status` — not the JSON-RPC POST status, which is 200 for every
  answered `tools/call` and would make `"status": 200` pass on a call that
  failed. A scenario is therefore portable between transports: the same
  `{ "ok": false, "status": 400, "errorCode": "invalid_input" }` holds over
  both. The raw transport status remains readable as
  `$steps[n].transportStatus`, and a failed tool result carrying no Pracht
  status metadata (a non-Pracht server) reports 500 rather than borrowing the
  transport's 200.

  Destructive confirmation scenarios carry over too when the app explicitly
  enables `agents.mcp.destructive`, exposes the capability over MCP, and
  registers an approval store. `confirm` on an MCP step travels in the
  `tools/call` `_meta["io.pracht/confirmation"]` field, since MCP has no
  per-call header channel. A step for any capability the endpoint does not
  project fails the scenario with the tool name it looked for and what to do
  about it, rather than passing quietly.
  `examples/basic/evals/notes-mcp.eval.json` exercises the complete round trip.
- Output: a human transcript (step, capability, outcome, status, latency,
  denial reasons; MCP scenarios are marked `[mcp]`) or `--json` for CI, where
  each step also carries its `transport`.

## Signing requests as an agent

Pracht ships the signer as well as the verifier, at `@pracht/core/agent-auth` —
its own entry point, because nothing in a deployed app signs requests and the
private-key path should not be bundled into a worker.

```ts
import { signAgentRequest, generateAgentKeyPair } from "@pracht/core/agent-auth";

// One-time: mint a keypair. Publish `publicKeyJwk` in your key directory (or
// pin it in the target app's `agents.webBotAuth.keys`); `keyId` is the RFC 8037
// thumbprint both sides use to refer to it.
const { keyId, privateKeyJwk, publicKeyJwk } = await generateAgentKeyPair();

// Per request:
const response = await fetch(
  await signAgentRequest(new Request(url, { method: "POST", body }), {
    agent: "https://my-agent.example",
    privateKeyJwk,
  }),
);
```

`signAgentRequest()` returns a copy — the original request is untouched — and
covers `@authority` and `signature-agent` by default, which is the covered-component
set the Web Bot Auth draft specifies.

> **Know what a signature binds.** Those two components bind the signature to a
> *host*, not to a method, path, or body. Anyone who observes one signed request
> can replay its headers against any other endpoint on the same origin until
> `expires` passes (default 300 s). That is the draft's minimum, kept here for
> interoperability — but if your agent talks to endpoints of differing
> sensitivity, widen the coverage:
>
> ```ts
> await signAgentRequest(request, {
>   additionalComponents: ["@method", "@path"],
>   agent, privateKeyJwk,
> });
> ```
>
> Pracht's verifier accepts any superset of the required components. Shorten
> `lifetimeSeconds` too when the caller can re-sign cheaply. `additionalComponents` adds more (`"@method"`, `"@path"`,
lowercase header names); `createAgentSignatureHeaders()` returns just the three
headers when you need to attach them yourself.

Because `@authority` is covered, a signature is bound to the host the request
is actually delivered to. Signing `localhost:3000` while the server observes
`app.example.com` — a Cloudflare custom-domain route under `wrangler dev` — will
not verify. Sign [the authority the Worker sees](#preview-authority-with-custom-domain-routes).

## Not built yet

- Directory fetching without an allowlist (needs an SSRF story).
- `nonce` uniqueness enforcement.
- A Durable Objects approval store. SQL backends (Postgres, D1, SQLite/Turso)
  are covered by [`createSqlApprovalStore()`](#createsqlapprovalstore-the-first-party-durable-store).
- RSA-PSS agent keys (the Web Bot Auth ecosystem is Ed25519-first).
- Destructive capabilities over **WebMCP**. Unlike remote MCP, this is not
  waiting on a mechanism: a page host's approval UX is not a security boundary,
  so the flow would have nothing server-verified to bind to.
- RSA-PSS signing (the signer is Ed25519-only, matching the verifier).
- Framework-level rate limiting, write-idempotency helpers, and result-size
  limits — see [operational
  hardening](#operational-hardening-what-the-framework-does-not-do-yet) for
  the middleware/app-level approach in the meantime.
