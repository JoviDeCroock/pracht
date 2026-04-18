---
name: audit-auth
version: 1.0.0
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

The pracht auth pattern (see `examples/docs/src/routes/docs/recipes-auth.md`):
middleware checks the session, redirects if absent, and forwards user info via
request headers; loaders downstream read the headers. This skill verifies that
every route that *should* be protected actually goes through the gate.

## Step 1: Identify the auth middleware(s)

```bash
pracht inspect routes --json
```

Read every file under `src/middleware/`. Classify each:

- **Gate** — calls `getSession`/`getUser` and either returns `{ redirect }` /
  a `Response` on failure, or returns `void` on success.
- **Augmenter** — calls `getSession`, sets headers/context with user info, but
  never short-circuits on absence.
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
4. If only an Augmenter is present, mark as `unprotected`.

## Step 4: Check the API surface

Mutation endpoints (`POST`, `PUT`, `PATCH`, `DELETE`) are the highest-impact
target. From `pracht inspect api --json`:

- For each mutation handler, check whether `defineApp({ api: { middleware } })`
  applies a Gate, OR the handler reads/validates a session itself.
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

| Route/API | Expected | Resolved middleware | Gate present? | Verdict |
| --------- | -------- | ------------------- | ------------- | ------- |

Verdicts:
- `protected` — gate confirmed.
- `augmented-only` — middleware reads session but never blocks; loader must
  handle null user.
- `unprotected` — no auth middleware on a route the user expects protected.
- `client-only` — server allows; client hides UI. Risky.
- `inconsistent` — UI route is gated; sibling API is not.

## Rules

1. The framework's `pracht inspect routes --json` and `pracht inspect api
   --json` are the source of truth — group inheritance is already resolved.
2. Recognize Gates by behavior (returns `redirect`/`Response` on failure), not
   by filename — projects use `auth.ts`, `requireUser.ts`, `session.ts`, etc.
3. An Augmenter is a valid pattern when paired with a separate Gate or a
   loader that explicitly handles the unauthenticated case. Flag it; don't
   condemn it.
4. Public routes deliberately exposed (login, signup, marketing) should be
   listed but not flagged.
5. Do not auto-add middleware. Auth wiring is policy.

$ARGUMENTS
