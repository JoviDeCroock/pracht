# Agent Trust Layer

The agent trust layer answers three questions about the capability graph
(see [CAPABILITIES.md](CAPABILITIES.md)):

- **Who is calling?** — Web Bot Auth verification puts a cryptographically
  verified agent identity on the request context.
- **May they do this?** — policy modes per app and per capability, plus a
  server-verified prepare/commit confirmation flow for destructive
  capabilities.
- **What happened?** — a structured audit event for every capability
  dispatch, and `pracht eval` to test agent task flows in CI.

Everything is opt-in and zero-cost when unused: an app without
`defineApp({ agents })` and without destructive capabilities pays a single
property check per request.

## Web Bot Auth: verified agent identity

Web Bot Auth is the emerging standard (implemented by major CDNs) where an
agent signs its requests with [RFC 9421 HTTP Message
Signatures](https://www.rfc-editor.org/rfc/rfc9421) and publishes its public
keys in a well-known directory. Pracht implements the verifier side of:

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
(Node, Cloudflare, Vercel) share the implementation because it only uses Web
platform APIs (`Headers`, `fetch`, `crypto.subtle`; Ed25519 works on Node ≥
20, Workers, and Vercel Edge). The result surfaces on the request context for
middleware, loaders, API routes, and capability `run()`:

```ts
async run({ context }) {
  context.agent; // { verified: true, agentDomain, keyId } | null
}
```

`context.agent` is only set when `agents.webBotAuth` is configured; it is
`null` for unsigned or unverifiable requests.

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
- **may not set `expose.webmcp` or `expose.mcp` (v1)** — host-side approval
  UX is not a security boundary, and agent hosts cannot yet be trusted to
  carry the two-step flow faithfully; `defineCapability()`, the registry, and
  `pracht verify` all reject it.

### Prepare/commit

Set `PRACHT_CONFIRMATION_SECRET` in the server environment (or call
`setCapabilityConfirmationSecret()` from server code on platforms without
`process.env`). Without it, destructive HTTP calls fail closed with
`403 confirmation_unavailable`, and `pracht verify` fails.

1. **Prepare** — a call without a token never runs the capability:

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

### Honest limitations

- **Stateless HMAC cannot prevent replay within the TTL.** A captured token
  authorizes the same principal + capability + input until it expires.
  `agents.confirmation.singleUse: true` enables a best-effort in-memory
  cache — per instance, lost on restart, not shared across replicas. True
  single-use needs shared storage (deliberately out of scope for v1).
- **Principal binding is only as strong as the principal.** Without Web Bot
  Auth (or your own auth middleware), both prepare and commit run as
  `"anonymous"` — the flow still forces the two-step round trip with
  identical input, but does not tie the token to a caller.

## Audit trail

Every capability dispatch — HTTP or direct `invokeCapability()` — emits one
structured event:

```ts
interface CapabilityAuditEvent {
  capability: string;          // "notes.purge"
  effect: "read" | "write" | "destructive";
  transport: "http" | "server";
  outcome: string;             // "ok" | "invalid_input" | "confirmation_required" | ...
  status: number;
  durationMs: number;
  agent: { verified: true; agentDomain: string | null; keyId: string } | null;
}
```

Subscribe from any server-only module (audit hooks observe: exceptions are
swallowed, never breaking a request):

```ts
import { setCapabilityAuditHook } from "@pracht/core";

setCapabilityAuditHook((event) => log.info("capability", event));
```

Custom server entries can also pass `onCapabilityAudit` directly to
`handlePrachtRequest()`; both hooks fire.

## `pracht eval`: scripted agent-task scenarios

`pracht eval [files...]` runs JSON scenarios against a live app's capability
HTTP projection and exits 1 on any failed expectation — "can an agent
actually complete this task through my tools?" as a repeatable CI check.

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
  "steps": [
    {
      "capability": "notes.purge",   // name → POST /api/capabilities/notes/purge
      "path": "/api/custom",         // optional override for custom expose.http.path
      "input": { "titlePrefix": "Old" },
      "headers": { "x-pracht-confirm": "$steps[0].error.confirmationToken" },
      "expect": {
        "ok": false,                        // envelope ok flag
        "status": 409,                      // HTTP status
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
  `$steps[1].data.note.id`. References work anywhere in `input` and
  `headers`; unresolvable references fail the scenario.
- Output: a human transcript (step, capability, outcome, status, latency,
  denial reasons) or `--json` for CI.

## Not built yet

- Directory fetching without an allowlist (needs an SSRF story).
- `nonce` uniqueness enforcement and shared-storage single-use confirmation
  tokens.
- RSA-PSS agent keys (the Web Bot Auth ecosystem is Ed25519-first).
- Destructive capabilities over WebMCP/MCP, and `pracht eval` speaking MCP
  instead of the HTTP projection.
