---
name: audit-csrf
version: 1.1.0
description: |
  Inventory every form submission and mutation API in the project, then verify
  the CSRF posture. Pracht enforces same-origin on mutation API requests by
  default (`api.requireSameOrigin`); this skill checks that the default is
  intact and that cookie strategy, middleware, or tokens cover whatever the
  built-in check does not.
  Use when asked to "audit CSRF", "check CSRF protection", "are forms safe",
  "review session security", or after enabling cross-origin form usage.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Pracht Audit CSRF

What the framework guarantees: by default (`ApiConfig.requireSameOrigin`,
`true` unless explicitly disabled), the runtime rejects state-changing API
requests (`POST`/`PUT`/`PATCH`/`DELETE`) with a 403 unless the browser signals
an exact same-origin fetch (`Sec-Fetch-Site: same-origin`) or the request's
`Origin`/`Referer` matches the request URL's origin. `same-site` is not
accepted (sibling subdomains can be attacker-controlled). Requests with no
browser provenance headers at all (curl, server-to-server) are allowed — the
threat model is browser-form CSRF, which cannot strip those headers. Page
routes reject unsafe methods outright, so the API surface is where mutations
live.

The audit therefore targets the OPT-OUTS and the remaining layers, in order of
preference:

1. **Built-in same-origin enforcement** (`requireSameOrigin`, on by default).
2. **`SameSite=Lax` (or `Strict`) on session cookies** — defense in depth.
3. **Origin-check middleware** — only needed when `requireSameOrigin` is
   disabled or for non-`/api` endpoints.
4. **Per-request tokens** — only when `SameSite=None` is required.

Prerequisites: `pracht inspect` requires a vite config that registers the
pracht plugin.

## Step 0: Check the built-in guard

Read `src/routes.ts` (the app manifest) for
`defineApp({ api: { requireSameOrigin } })`. Absent means `true` (the
default). An explicit `requireSameOrigin: false` is a top finding (`error`):
the project has opted out of the built-in CSRF protection and MUST show
compensating layers (origin-check middleware or token protocol) — demand them
in the report.

## Step 1: Inventory mutation surfaces

### Forms

Grep for `<Form ` across `src/`. For each occurrence:
- Capture `method` (default is `get` — only `post`/`put`/`patch`/`delete` are
  CSRF-relevant).
- Capture `action`.

### API mutations

```bash
pracht inspect api --json
```

If the pracht MCP server is registered (see `docs/MCP.md`), prefer its tools
(`inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify`) over
shelling out.

For each API route, read the exported `methods`. Mutation methods: `POST`,
`PUT`, `PATCH`, `DELETE`. Caveat: a `default`-export handler serves ALL
methods but reports `methods: []` — check the `hasDefaultHandler` field
(requires a current `@pracht/cli`) or, on older CLIs, grep the handler file
for `export default`. A default handler counts as exposing all mutation
methods unless it gates on `request.method` itself.

## Step 2: Inspect the session cookie

Locate cookie issuance — typically `src/server/session.ts`, `src/api/auth/*`,
or anywhere `Set-Cookie` appears in a response. For every cookie set:

| Attribute        | Required posture             | Failure mode                |
| ---------------- | ---------------------------- | --------------------------- |
| `HttpOnly`       | Present                      | XSS can steal the session   |
| `Secure`         | Present in production        | Sniffable on HTTP           |
| `SameSite`       | `Lax` or `Strict`            | Cross-site sends the cookie |
| `Path`           | Set (usually `/`)            | Scope confusion             |

Flag any cookie missing `HttpOnly`, missing `SameSite`, or with
`SameSite=None` without an accompanying token check. A missing
`Max-Age`/`Expires` is `info` only — session cookies are legitimate and
strictly shorter-lived, not a failure.

## Step 3: Origin-check middleware (only for opt-outs)

A manual origin-check middleware is only needed when `requireSameOrigin` is
disabled, or for mutation endpoints outside `/api` handled by custom code.
If Step 0 found `requireSameOrigin: false`, look for middleware that:

- Reads `request.headers.get('origin')`.
- Compares against `url.origin` and an allowlist.
- Rejects unsafe-method requests on mismatch.

The canonical shape is in `recipes-auth.md` (the `origin-check.ts` example).

Verify the wiring: the middleware name must appear in
`defineApp({ api: { middleware: [...] } })` — that single global list applies
to every API route. There is no per-group API middleware, and
`pracht inspect api --json` output has no middleware field, so the manifest is
the only place to check.

## Step 4: Look for token-based CSRF

Grep for: `csrf`, `csrfToken`, hidden form fields with token values, headers
like `x-csrf-token`. Verify both sides of the protocol exist (issue + verify).
A token issuer with no verifier (or vice versa) is a bug.

## Step 5: Score each mutation surface

For each `<Form>` and each mutation API, assign a severity (primary) and a
posture verdict (secondary):

- `info` / **Strong** — built-in same-origin enforcement intact (default) +
  `SameSite=Lax`/`Strict` cookies.
- `info` / **Adequate** — built-in enforcement intact; cookie posture unknown
  or `SameSite` unset (the runtime check still blocks browser CSRF).
- `warn` / **Compensated** — `requireSameOrigin: false` but a verified
  origin-check middleware or token protocol covers the surface.
- `warn` / **Token-only** — token verified, cookie has `SameSite=None`.
- `error` / **Weak** — `requireSameOrigin: false` and no token / no
  origin-check.
- `warn` / **Unknown** — cookie source not located — investigate.

Produce:

| Surface | File:Line | Method | requireSameOrigin | Cookie posture | Middleware/Token? | Severity | Verdict |
| ------- | --------- | ------ | ----------------- | -------------- | ----------------- | -------- | ------- |

## Rules

1. Point users at `examples/docs/src/routes/docs/recipes-auth.md` for cookie
   and middleware patterns, and at `ApiConfig.requireSameOrigin` for the
   built-in guard.
2. Do not flag GET-only forms or read-only API methods.
3. Remember: a hydrated `<Form>` intercepts unsafe-method submissions and
   issues `fetch(actionUrl, { method, body: formData })` — not a document
   POST. Fetch's default credentials mode is `same-origin`, so a cross-origin
   `action` gets no cookies at all; same-origin submissions carry cookies and
   the browser's `Sec-Fetch-Site`/`Origin` headers, which the built-in check
   validates.
4. If the project sets `SameSite=None`, require either a token check or an
   origin-check in addition to the built-in guard — explain why in the report.
5. Do not auto-fix. CSRF strategy is a policy decision; surface the gaps and
   let the user choose layers.

$ARGUMENTS
