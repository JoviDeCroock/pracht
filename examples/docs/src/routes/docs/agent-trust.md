---
title: Agent Trust
lead: Who is calling, may they do this, and what happened? Verified agent identity with Web Bot Auth, a prepare/commit confirmation flow for destructive operations, structured audit events, and <code>pracht eval</code> to prove agent flows in CI.
breadcrumb: Agent Trust
prev:
  href: /docs/capabilities
  title: Capabilities
next:
  href: /docs/remote-mcp
  title: Remote MCP
---

## Three Questions

Exposing [capabilities](/docs/capabilities) to agents raises questions a schema cannot answer. The agent trust layer answers all three, and everything is opt-in. When the build can prove that an app registers neither capabilities nor `defineApp({ agents })`, the capability dispatch and Web Bot Auth verifier are dropped from the server bundle entirely.

- **Who is calling?** — Web Bot Auth puts a cryptographically verified agent identity on the request context.
- **May they do this?** — policy modes per app and per capability, plus a server-verified confirmation flow for destructive effects, optionally backed by a durable approval store for exactly-once commits and, in human mode, real human approval.
- **What happened?** — one structured audit event per capability dispatch.

---

## Web Bot Auth: Verified Agent Identity

Agents sign requests with [RFC 9421 HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421) and publish Ed25519 public keys in a well-known directory — the emerging standard already deployed by major CDNs. pracht implements the verifier side; configuration lives in the manifest, and keys are public, so they are safe there:

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

Verification happens once per request in `handlePrachtRequest`, using only Web platform APIs — Node, Cloudflare, and Vercel share the implementation. The result surfaces everywhere:

```ts [src/capabilities/agent-whoami.ts]
async run({ context }) {
  context.agent; // { verified: true, agentDomain, keyId } | null
}
```

Verification fails closed: expired windows, uncovered components, unknown keys, or non-allowlisted directories all yield `context.agent = null`, never a partial identity. The framework binds the result as a read-only, immutable snapshot, so middleware can derive separate authorization state but cannot rewrite the verified identity used by later policy and audit checks.

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

Capabilities declaring `effect: "destructive"` (delete, publish, pay, send) may be exposed over HTTP only, and every dispatch is confirmation-gated. Set `PRACHT_CONFIRMATION_SECRET` in the server environment; without it, destructive calls fail closed.

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

### Remote MCP Composition Is Guarded

`invokeCapability()` is trusted first-party composition. It runs the callee's own pipeline — input validation, its named middleware, `run()`, output validation — without re-running app-level `api.middleware`, so private capabilities remain useful as server-side building blocks.

Remote MCP adds two fail-closed rules: nested calls re-apply the callee's `agentPolicy` and refuse `destructive` effects before middleware or the body can run. Private non-destructive capabilities remain composable, with named middleware as their authorization seam. HTTP and WebMCP composition keep the ordinary server semantics and must own any transport-specific authorization they need. Every nested attempt still audits with `transport: "server"` and trusted provenance in `via`.

---

## pracht eval: Prove Agent Flows in CI

Can an agent actually complete a task through your capabilities? `pracht eval` runs scripted scenarios against the HTTP projection and exits 1 on any failed expectation:

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

The [Testing recipe](/docs/recipes/testing) covers the rest of the agent-surface toolbox: unit testing the full dispatch pipeline with `createCapabilityTestHost()` — including this confirmation flow and simulated agent identities — plus Playwright patterns, faking the WebMCP API, and signing Web Bot Auth requests in tests.
