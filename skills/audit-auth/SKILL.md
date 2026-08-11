---
name: audit-auth
version: 1.2.3
description: |
  Find pracht routes that look protected but aren't — missing auth middleware,
  middleware that augments context but never gates, client-side auth checks
  with no server enforcement, and API mutations exposed without guards.
  Use when asked to "audit auth", "check route protection", "is my dashboard
  protected", "find unauthenticated routes", or "review middleware coverage".
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Pracht Audit Auth

What the framework guarantees: middleware runs wrap-around style — every
middleware must return a `Response` (the runtime throws if it doesn't), either
`return next()` to continue the chain or a short-circuit `Response` to stop it.
The `redirect()` helper from `@pracht/core` returns a scheme/CRLF-validated
redirect `Response`. What the framework does NOT decide is *which* routes get
an auth gate — that is app wiring, and this skill audits it.

The pracht auth pattern (see `examples/docs/src/routes/docs/recipes-auth.md`):
middleware checks the session, short-circuits with a redirect on absence, and
forwards user info via request headers; loaders downstream read the headers.

Prerequisites: `pracht inspect` requires a vite config that registers the
pracht plugin.

## Step 1: Identify the auth middleware(s)

```bash
pracht inspect routes --json
```

If the pracht MCP server is registered (see `docs/MCP.md`), prefer its tools
(`inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify`) over
shelling out.

Middleware is registered by name in the app manifest —
`defineApp({ middleware: { auth: () => import("./middleware/auth.ts") } })` —
and `inspect` reports those names, not files. Read the name→file map from
`src/routes.ts` (or the configured manifest) to resolve each name, then read
each middleware file and classify it:

- **Gate** — on auth failure, returns a short-circuit `Response`
  (`redirect("/login", { request })`, or a 401/403 `Response`) WITHOUT calling
  `next()`; on success, `return next()`.
- **Augmenter** — mutates request headers/context with user info, then always
  returns `next()`. Never short-circuits.
- **Other** — non-auth middleware (rate limit, logging, CORS, etc.).

The "Augmenter" category is the silent killer: it makes loaders *think*
auth is enforced because `request.headers.get('x-user-id')` returns a value
when present, but unauthenticated requests just get `null` and the loader has
to handle it. Flag every loader downstream of an Augmenter that doesn't.

## Step 2: Identify protected routes

A route is "expected protected" if any of:

- It has `auth`/`session`/`requireUser`/similar middleware applied.
- Its loader reads `x-user-id`/`x-user-email`/`getSession`/equivalent.
- It lives under conventional protected paths: `/dashboard*`, `/admin*`,
  `/account*`, `/settings*`, `/app*` (ask the user to confirm the
  convention if unclear).
- The user has flagged it explicitly.

Build a list of expected-protected routes.

## Step 3: Check coverage per protected route

For each expected-protected route:

1. From `pracht inspect routes --json`, read the resolved `middleware` array.
2. Confirm at least one **Gate** middleware is present.
3. Confirm the gate runs **before** any other middleware that depends on
   identity (order matters).
4. If only an Augmenter is present, mark as `augmented-only`.

## Step 4: Check the API surface

Mutation endpoints (`POST`, `PUT`, `PATCH`, `DELETE`) are the highest-impact
target. From `pracht inspect api --json`:

- Each API route reports `path`, `file`, `methods`, and `hasDefaultHandler`
  (the last requires a current `@pracht/cli`). A `default`-export handler
  serves ALL methods but reports `methods: []` — treat
  `hasDefaultHandler: true` as "every method exposed". On older CLIs where
  the field is missing, grep the handler file for `export default` instead.
- For each mutation handler (named method export or default handler) and each
  HTTP- or remote-MCP-exposed capability, check whether
  `defineApp({ api: { middleware } })` applies a Gate, OR the handler/capability
  reads and validates a session itself. App-level API middleware wraps generated
  capability endpoints before capability-specific middleware.
- For remote MCP, cookie-bearing transport requests are rejected before
  capability dispatch and only `Authorization` is forwarded. Flag MCP-exposed
  capabilities whose gate depends on a browser session cookie or a custom
  credential header that the projection does not carry.
- Treat `context.agent` as framework-owned, read-only verified identity. Flag
  middleware or capability code that attempts to mutate or replace it instead
  of deriving application authorization state on a separate context field.
- When a custom adapter supplies a frozen or sealed context, flag authorization
  helpers that read `agent` or middleware-added fields through `this`. The
  framework binds private-field methods to the immutable source receiver, which
  cannot observe fields added on its extensible overlay. Callable fields keep
  their own API and arrays keep their brand. Application-defined
  `Symbol.toStringTag` branding does not affect whether an ordinary context can
  be overlaid, but immutable native built-ins such as `Map` and `Date` fail
  closed because an overlay cannot preserve their internal slots. Use a fresh
  mutable wrapper when a context needs native built-ins or when receiver-bound
  helpers depend on request state.
- Inspect every HTTP-, WebMCP-, or MCP-exposed capability body for
  `invokeCapability()`. Direct composition never re-applies app-level API
  middleware. Remote MCP additionally re-applies the callee's `agentPolicy`
  and refuses destructive callees, but private non-destructive capabilities
  stay composable and rely on their named middleware for authorization. For
  HTTP/WebMCP composition, flag sensitive callees whose required transport
  authorization or approval is absent from the composing capability and the
  callee's named middleware.
- Common bug: dashboard route is protected by middleware, but
  `POST /api/items` is not — attacker bypasses the UI entirely.

## Step 5: Client/server enforcement parity

Grep client components for patterns like `if (!user) return <Login />`. For
each occurrence, confirm that **the data path is also gated server-side**.
Client-side gating without a server gate is purely cosmetic and a common
source of "I see the data flash before redirect" or worse, leaked data via
SPA route loaders.

## Step 6: Session cookie sanity

Cross-reference with `audit-csrf`: the same cookies that authorize the user
are the CSRF target. Recommend running `audit-csrf` after this skill.

## Step 7: Report

| Route/API | Expected | Resolved middleware | Gate present? | Severity | Verdict |
| --------- | -------- | ------------------- | ------------- | -------- | ------- |

Severity is the primary scale; the verdict is a secondary domain label:

- `error` / `unprotected` — no auth middleware on a route the user expects
  protected.
- `error` / `inconsistent` — UI route is gated; sibling API is not.
- `warn` / `augmented-only` — middleware reads session but never blocks;
  loader must handle null user.
- `warn` / `client-only` — server allows; client hides UI.
- `info` / `protected` — gate confirmed.
- `info` / `public-by-design` — deliberately exposed (login, signup,
  marketing).

## Rules

1. The framework's `pracht inspect routes --json` and `pracht inspect api
   --json` are the source of truth — group inheritance is already resolved.
2. Recognize Gates by behavior (short-circuits with a `Response` without
   calling `next()` on failure), not by filename — projects use `auth.ts`,
   `requireUser.ts`, `session.ts`, etc.
3. An Augmenter is a valid pattern when paired with a separate Gate or a
   loader that explicitly handles the unauthenticated case. Flag it; don't
   condemn it.
4. Public routes deliberately exposed (login, signup, marketing) should be
   listed but not flagged.
5. Do not auto-add middleware. Auth wiring is policy.
6. Treat allowed composed capability reachability as transitive. MCP blocks
   destructive callees and re-applies `agentPolicy`; named middleware remains
   the authorization seam for private non-destructive composition. Audit events
   identify every nested attempt with `transport: "server"` and trusted request
   provenance in `via`, but observability is not an authorization gate.

$ARGUMENTS
