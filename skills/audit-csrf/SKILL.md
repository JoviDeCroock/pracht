---
name: audit-csrf
version: 1.0.0
description: |
  Inventory every form submission and mutation API in the project, then verify
  the CSRF posture matches pracht's recommended layers (`SameSite` cookie
  +/- origin-check middleware +/- token). Pracht ships no built-in CSRF; the
  defense lives in your cookie strategy and threat model.
  Use when asked to "audit CSRF", "check CSRF protection", "are forms safe",
  "review session security", or after enabling cross-origin form usage.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Pracht Audit CSRF

Pracht does not ship CSRF middleware. The defense depends on three layers
(see `examples/docs/src/routes/docs/recipes-auth.md` § CSRF Protection):

1. **`SameSite=Lax` (or `Strict`) on session cookies** — primary defense.
2. **Origin-check middleware** — defense in depth.
3. **Per-request tokens** — only when `SameSite=None` is required.

This skill enumerates every mutation surface and checks which layers protect
each.

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

For each handler file, list the exported HTTP methods. Mutation methods:
`POST`, `PUT`, `PATCH`, `DELETE`. A single `default` handler that branches on
`request.method` counts as exposing all methods unless gated.

## Step 2: Inspect the session cookie

Locate cookie issuance — typically `src/server/session.ts`, `src/api/auth/*`,
or anywhere `Set-Cookie` appears in a response. For every cookie set:

| Attribute        | Required posture             | Failure mode                |
| ---------------- | ---------------------------- | --------------------------- |
| `HttpOnly`       | Present                      | XSS can steal the session   |
| `Secure`         | Present in production        | Sniffable on HTTP           |
| `SameSite`       | `Lax` or `Strict`            | CSRF wide open              |
| `Path`           | Set (usually `/`)            | Scope confusion             |
| `Max-Age`/Expires| Set                          | Browser-session-only cookie |

Flag any cookie missing `HttpOnly`, missing `SameSite`, or with
`SameSite=None` without an accompanying token check.

## Step 3: Look for an origin-check middleware

Grep `src/middleware/` for files that:
- Read `request.headers.get('origin')`.
- Compare against `url.origin` and an allowlist.
- Reject unsafe-method requests on mismatch.

The canonical shape is in `recipes-auth.md` (the `origin-check.ts` example).
If the project allows `SameSite=None` cookies and has no origin-check
middleware AND no token check — that is a CSRF hole.

Verify the middleware is wired:
- `defineApp({ api: { middleware: [...] } })` covers all API routes, OR
- It is applied per-group on every group containing a mutation API.

Use `pracht inspect api --json` to check that every mutation API is downstream
of the middleware.

## Step 4: Look for token-based CSRF

Grep for: `csrf`, `csrfToken`, hidden form fields with token values, headers
like `x-csrf-token`. Verify both sides of the protocol exist (issue + verify).
A token issuer with no verifier (or vice versa) is a bug.

## Step 5: Score each mutation surface

For each `<Form>` and each mutation API, assign a posture:

- **Strong**: `SameSite=Lax`/`Strict` + origin-check middleware
- **Adequate**: `SameSite=Lax`/`Strict` only (sufficient for most first-party
  apps)
- **Token-only**: token verified, cookie has `SameSite=None`
- **Weak**: `SameSite=None` (or absent) and no token / no origin-check
- **Unknown**: cookie source not located — investigate

Produce:

| Surface | File:Line | Method | Cookie posture | Origin-check? | Token? | Verdict |
| ------- | --------- | ------ | -------------- | ------------- | ------ | ------- |

## Rules

1. The recipe is the spec — point users at
   `examples/docs/src/routes/docs/recipes-auth.md` for fixes.
2. Do not flag GET-only forms or read-only API methods.
3. Remember: pracht's `<Form>` issues a real `POST` (not XHR JSON), so cookies
   travel; `SameSite` applies normally.
4. If the project sets `SameSite=None`, require either a token check or an
   origin-check — explain why in the report.
5. Do not auto-fix. CSRF strategy is a policy decision; surface the gaps and
   let the user choose layers.

$ARGUMENTS
