---
name: audit-agent-surface
version: 1.0.0
description: |
  Inventory everything in a pracht app that agents can reach — capabilities and
  their exposure (HTTP, WebMCP, remote MCP), the `agents` trust configuration,
  the destructive confirmation gate, `llms.txt`, Markdown negotiation, and the
  OpenAPI document — then report where the surface is wider than intended or
  missing a guard. Also confirms an app that wants no agent surface is actually
  paying nothing for one.
  Use when asked to "audit the agent surface", "what can agents do on my site",
  "is my MCP endpoint safe", "check capability exposure", "did this PR widen
  what agents can reach", or "make sure we ship no agent surface".
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Pracht Audit Agent Surface

Pracht's agent surface is opt-in end to end (`docs/CAPABILITIES.md`,
`docs/AGENT_TRUST.md`, `docs/REMOTE_MCP.md`). State that baseline before
auditing the opt-outs:

- No loader or API route is ever inferred as a capability; a capability without
  `expose` is unreachable over the network.
- `destructive` capabilities may only be exposed over HTTP, and every dispatch
  is confirmation-gated.
- Remote MCP rejects cookie-bearing and browser-originated requests, and
  filters destructive capabilities again at serve time.
- An app that registers neither capabilities nor `agents` has the dispatch path
  and Web Bot Auth verifier dropped from its server bundle at build time.

This skill reports; it never mutates. Prerequisites: `pracht inspect` needs a
vite config registering the pracht plugin. If the pracht MCP server is
registered (see `docs/MCP.md`), prefer its tools (`inspect_capabilities`,
`inspect_routes`, `inspect_api`, `doctor`, `verify`) over shelling out.

## Step 1: Inventory the declared surface

```bash
pracht inspect capabilities --json   # name, effect, transports, HTTP path, middleware, schemas
pracht inspect routes --json         # markdown negotiation, hydration, middleware
pracht inspect api --json
pracht verify --json                 # contract, exposure, and projection checks
```

Build the inventory table: capability → effect → transports → HTTP path →
middleware → `agentPolicy`. A capability reported as `unreadable` means
`@pracht/capabilities` is not installed; treat it as an `error` and stop
reasoning about its policy until it loads.

Read the manifest's `agents` block and record which of `webBotAuth`,
`confirmation`, and `mcp` are configured, plus the MCP endpoint path.

## Step 2: Exposure vs. intent

For every exposed capability, ask whether the exposure is deliberate:

- `expose.mcp` set but no `agents.mcp` configured — declared, served by
  nothing. `pracht verify` warns; report it so the intent gets resolved.
- `expose.mcp` set on an operation whose authorization relies on a browser
  session — remote MCP rejects cookies, so the only credentials it sees are the
  forwarded `Authorization` header and `context.agent`. A middleware chain that
  reads a session cookie authorizes nobody there.
- `expose.webmcp` — the in-page agent acts as the signed-in user in their tab.
  Confirm that is intended for every one, and that the route's hydration is not
  `"none"` (which registers no tools).
- Private capabilities used as building blocks: `invokeCapability()` runs their
  named middleware but **not** app-level `api.middleware`. Their named
  middleware is the only authorization seam — flag private capabilities with an
  empty `middleware` list that touch sensitive data.
- Custom `expose.http.path` values that land outside `/api/**` and therefore
  escape path-scoped middleware or host rules.
- Declared vs. actually served: `expose.mcp` in source is what the graph
  claims. A `pracht eval` scenario with `"transport": "mcp"` proves what the
  endpoint answers — it performs a real `initialize` handshake and issues each
  step as a `tools/call`. Run it only against a local throwaway server, and
  only with `read` steps. If the app ships MCP-exposed capabilities with no
  such scenario, report the missing proof: an HTTP-only scenario says nothing
  about whether an MCP host can reach the tool.

## Step 3: The destructive gate

- Every `destructive` capability must be HTTP-only. `webmcp`/`mcp` on one is
  rejected by the framework — if you find it in source, the build is failing.
- `PRACHT_CONFIRMATION_SECRET` must be set in the server environment for each
  deployment target (build environment too on Vercel, since it becomes the
  bypass token there). Missing → every destructive call answers
  `403 confirmation_unavailable`.
- Record the honest limits in the report: the stateless HMAC token is replayable
  within its TTL (default 120 s), the calling agent can hand the token back to
  itself, and without Web Bot Auth or
  `setCapabilityApprovalPrincipalResolver()` both phases run as `"anonymous"`.
  Flag `confirmation: { singleUse: true }` used as if it were durable — it is a
  per-instance in-memory cache, lost on restart.
- If an approval store is registered, confirm its backend supports atomic
  conditional writes (D1, Durable Objects, Postgres, Redis — **not** Cloudflare
  KV) and that all replicas share it: with a store registered, a token whose
  proposal is unknown is refused, so a per-instance store breaks commits.
- `confirmation: { mode: "human" }` without both a store and an authenticated
  principal fails closed — check both exist.

## Step 4: Identity and policy

- `agents.webBotAuth.policy: "require"` gates capability HTTP endpoints only —
  pages and API routes are not gated. Flag any assumption that it protects
  pages.
- `directories` is an allowlist; an empty one means no directory fetching at all
  (deliberate SSRF protection). Flag a directory origin that is not the agent
  ecosystem endpoint the app intends to trust.
- `agentPolicy: "require"` on a capability while `webBotAuth` is unconfigured
  answers 401 for every caller — a loud misconfiguration, report as `error`.
- Note the replay property: Pracht's stateless verifier does not enforce `nonce`
  uniqueness, and the default covered components (`@authority`,
  `signature-agent`) bind a signature to a host, not to a method, path, or body.
  Treat a verified identity as authentication, not per-request authorization.
- Confirm an audit hook exists (`setCapabilityAuditHook()` or
  `onCapabilityAudit`) — without one there is no record of who called what.

## Step 5: The discovery surface

- `llmsTxt` in the vite config: every listed path is a URL the app *invites* an
  agent to fetch. Cross-check the `exclude` list against routes behind auth
  middleware, internal tooling, and deliberate error routes — nothing about a
  middleware tells the framework whether it gates or merely logs, so an
  auth-gated route missing from `exclude` is a `warn` (see `docs/LLMS_TXT.md`).
  Capabilities appear there with their effect class; destructive ones are
  annotated `requires confirmation`.
- A collection-driven `llmsTxtArtifacts()` (see `/add-content`) is a second
  generator with its own coverage — compare what each publishes.
- Routes exporting `markdown` or declaring `markdown: true` serve a Markdown
  representation to agents. Confirm the Markdown variant is not more permissive
  than the HTML page (it carries `Vary: Accept`, so it is separately cached).
- An enabled OpenAPI document (`/openapi.json`, `dist/client/openapi.json`) is
  public unless the host protects it — check descriptions and examples for
  internal hostnames or credentials, and that "Try it out" mutation endpoints
  carry real authentication.
- `/.well-known/http-message-signatures-directory` and the MCP endpoint path
  should both be intentional; the MCP endpoint stays active with an empty
  capability graph.

## Step 6: Did this change widen the surface?

```bash
pracht plan --json --base origin/main
```

`widensAgentSurface` and the `!` capability lines answer the question a route
diff cannot: a new exposure, a destructive capability reclassified out of the
gate, an `agentPolicy` downgraded from `require`, dropped middleware, a
loosened input schema (dropped `required`, opened `additionalProperties`, raised
bound), or newly enabled `agents.mcp`. Report every widening explicitly, with
the before/after. A stale snapshot makes this useless — `pracht verify` fails
on staleness, so trust it only when verify passes.

## Step 7: The no-agent-surface case

When the app is supposed to have none:

- Confirm the manifest registers no `capabilities` and no `agents`. That lets
  the build define the surface away (~15 KB gzip of an example server bundle).
- Analysis is one-sided: a spread, a regex literal, or otherwise opaque syntax
  in the manifest leaves the define unset and keeps the runtime in the bundle.
  Flag manifest constructs that defeat the static read.
- Confirm `llmsTxt` is off if the app should not advertise itself, and that no
  route sets `markdown: true`.
- `create-pracht --no-agent-tools` controls the *scaffolded developer* tooling
  (`.mcp.json`, skills) — it has nothing to do with the deployed agent surface.
  Do not conflate them in the report.

## Step 8: Report

| Surface | Item | Reach | Guard | Severity |
| ------- | ---- | ----- | ----- | -------- |

Severities:

- `error` — destructive capability reachable without a configured confirmation
  secret; `agentPolicy: "require"` with no `webBotAuth`; capability module
  unreadable; MCP-exposed capability whose only authorization is a cookie
  session; approval store on a backend without conditional writes.
- `warn` — auth-gated route advertised in `llms.txt`; `expose.mcp` with no
  `agents.mcp`; exposed capability with no named middleware; unbounded output
  (no `limit`/`maximum`); no audit hook; `singleUse` treated as durable.
- `info` — exposure that is intentional and guarded, recorded so the reviewer
  sees the whole surface in one place; framework gaps that are deployment
  responsibilities (rate limiting, write idempotency, result-size limits).

## Rules

1. Report only — never change exposure, policy, or configuration. Propose the
   diff and let the owner apply it.
2. Never call a destructive capability to test it, not even the prepare phase,
   against anything but a local throwaway environment.
3. Do not treat client-declared signals as trust: the `webmcp` transport marker
   is informational, and only MCP dispatch state is trustworthy for
   attributing nested effects.
4. Distinguish `pracht mcp` (the development-time stdio server exposing the app
   *graph* to coding agents) from the deployed `/mcp` endpoint exposing the app's
   *operations*. They have different threat models.
5. State the framework guarantee before each finding so the reader can tell an
   opt-out from a hole.
6. Pair with `/audit-auth`, `/audit-csrf`, and `/audit-secrets` — this skill
   owns agent reachability, not general request authorization.

$ARGUMENTS
