---
title: Agent Trust
lead: Who is calling, may they do this, and what happened? Verified agent identity with Web Bot Auth, a prepare/commit confirmation flow for destructive operations, structured audit events, and <code>pracht eval</code> to prove agent flows in CI.
breadcrumb: Agent Trust
prev:
  href: /docs/capabilities
  title: Capabilities
next:
  href: /docs/recipes/i18n
  title: i18n
---

## Three Questions

Exposing [capabilities](/docs/capabilities) to agents raises questions a schema cannot answer. The agent trust layer answers all three, and everything is opt-in — an app without `defineApp({ agents })` and without destructive capabilities pays a single property check per request.

- **Who is calling?** — Web Bot Auth puts a cryptographically verified agent identity on the request context.
- **May they do this?** — policy modes per app and per capability, plus a server-verified confirmation flow for destructive effects.
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

Verification fails closed: expired windows, uncovered components, unknown keys, or non-allowlisted directories all yield `context.agent = null`, never a partial identity.

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

Agent hosts cannot yet be trusted to carry this two-step flow faithfully, so destructive capabilities cannot be exposed over WebMCP — `defineCapability()`, the runtime, and `pracht verify` all enforce it.

---

## Audit Trail

Every capability dispatch — HTTP or direct `invokeCapability()` — emits one structured event with the capability name, effect, transport, outcome, status, latency, and the verified agent identity (or `null`):

```ts [src/server/audit.ts]
import { setCapabilityAuditHook } from "@pracht/core";

setCapabilityAuditHook((event) => log.info("capability", event));
```

Hook exceptions are swallowed — auditing observes, it never breaks a request.

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
      "headers": { "x-pracht-confirm": "$steps[1].error.confirmationToken" },
      "expect": { "ok": true, "output": { "purged": 1 } }
    }
  ]
}
```

`$steps[n].<path>` references carry values between steps — the confirmation token above threads the prepare/commit flow through a scenario. Run it against a live server:

```sh
pracht preview                          # in another terminal
pracht eval --url http://localhost:3000 # runs evals/**/*.eval.json
```

The [Testing recipe](/docs/recipes/testing) covers the rest of the agent-surface toolbox: unit testing `run()` and the schema validators, asserting the prepare/commit flow from Playwright, faking the WebMCP API, and signing Web Bot Auth requests in tests.
