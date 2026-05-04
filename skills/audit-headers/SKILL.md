---
name: audit-headers
version: 1.0.0
description: |
  Audit per-route security header coverage in a pracht app. Verifies that
  `applyDefaultSecurityHeaders` (or equivalent custom `headers()` exports)
  protect every user-facing response, and suggests a Content-Security-Policy
  derived from the project's actual asset and connect origins.
  Use when asked to "audit security headers", "check CSP", "harden headers",
  "set up HSTS", or "review header policy".
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Pracht Audit Headers

Pracht ships `applyDefaultSecurityHeaders(headers: Headers)` from
`@pracht/core` which sets four headers when missing:

- `permissions-policy` (disables device sensors)
- `referrer-policy: strict-origin-when-cross-origin`
- `x-content-type-options: nosniff`
- `x-frame-options: SAMEORIGIN`

It does NOT set `strict-transport-security`, `content-security-policy`, or
`cross-origin-*` headers — those need a project decision.

## Step 1: Inventory routes and APIs

```bash
pracht inspect routes --json
pracht inspect api --json
```

For every route and API handler file, look at:
- `headers()` export — explicit per-route headers.
- Calls to `applyDefaultSecurityHeaders(...)` inside loaders, middleware, or
  API handlers.
- Hand-rolled `Response` constructions where headers are set inline.

## Step 2: Coverage check

Build a matrix:

| Route/API | Default sec headers | HSTS | CSP | COOP/COEP/CORP |
| --------- | ------------------- | ---- | --- | -------------- |

A route is "covered" by default headers if **any** of the following is true:
- A global middleware applies `applyDefaultSecurityHeaders` to outbound
  responses.
- The route's `headers()` export sets all four manually.
- The shell or layout owns header injection (rare — flag for reading).

Flag every route that has none of the above.

## Step 3: HSTS

Grep for `strict-transport-security`. If absent everywhere, recommend adding
it via global middleware:

```ts
"strict-transport-security": "max-age=63072000; includeSubDomains; preload"
```

Only recommend `preload` if the user confirms they want to commit to HTTPS
permanently and submit to the preload list.

## Step 4: Content-Security-Policy

Generate a starter CSP from observed origins:

1. Grep the app for fetch URLs, image URLs, CSS `@import`, `<script src>`,
   `<link href>`, font URLs, iframe sources.
2. Group by directive: `default-src`, `script-src`, `style-src`, `img-src`,
   `font-src`, `connect-src`, `frame-src`.
3. Always include `'self'` per directive.
4. Account for framework-emitted scripts: pracht injects hydration state in
   `<script id="pracht-state" type="application/json">` and injects a module
   client entry. Prefer a CSP that keeps executable scripts tight; do not jump
   to `'unsafe-inline'` unless the app truly emits executable inline scripts and
   the tradeoff is documented.

Output a draft CSP and explain what each origin is for. Do not hand the user
a CSP that breaks their site — present as draft.

## Step 5: Prerendered header manifest safety

For SSG/ISG output, inspect `dist/client/_pracht/headers.json` after build and
the route/shell `headers()` exports that feed it. This file is part of the
public client output, so every value in it must be safe to publish and replay on
static responses.

Flag as `error` if prerendered headers include:

- `set-cookie`
- `authorization`
- `proxy-authorization`
- `www-authenticate`
- `proxy-authenticate`
- custom secret-shaped names such as `x-*-token`, `x-*-secret`, or `x-*-key`

Flag as `warn` when a route-specific header is user-specific but could be
replayed across users from static output.

## Step 6: Cross-origin isolation (optional)

If the user mentions `SharedArrayBuffer`, WASM threading, or high-precision
timers, recommend:

- `cross-origin-opener-policy: same-origin`
- `cross-origin-embedder-policy: require-corp`
- `cross-origin-resource-policy: same-origin` on assets

Otherwise leave these unset — they break embedded third-party content.

## Step 7: Report

Two outputs:

1. **Coverage table** (route × header presence).
2. **Recommendations**, in priority order:
   - `error`: Routes with no security headers at all.
   - `warn`: Missing HSTS in production-grade apps.
   - `warn`: User-specific headers in prerendered static output.
   - `info`: CSP draft, COOP/COEP suggestions.

Show the exact code change required (e.g., where to insert
`applyDefaultSecurityHeaders` in a global middleware).

## Rules

1. Use the framework helper — do not recommend hand-rolling the four default
   headers.
2. Never recommend a CSP with `'unsafe-eval'` unless the user has documented
   why they need it.
3. Per-route `headers()` overrides everything else; check it first.
4. For SSG/ISG output, default headers must be applied at the adapter layer
   (Cloudflare/Vercel headers config, or a Node middleware) — flag if the
   adapter does not do this for static responses.
5. Treat prerender header manifests as public artifacts.
6. Do not auto-edit. Headers are policy; surface gaps, propose patches.

$ARGUMENTS
