---
name: audit-headers
version: 1.1.0
description: |
  Audit security header coverage in a pracht app. The framework applies four
  default security headers on every response path; this skill audits the
  exceptions — static output served outside first-party adapters, `headers()`
  exports that weaken the defaults, and the headers only the user can decide
  (HSTS, CSP).
  Use when asked to "audit security headers", "check CSP", "harden headers",
  "set up HSTS", or "review header policy".
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Pracht Audit Headers

What the framework guarantees: four default security headers are applied
automatically on EVERY framework response path — SSR pages, API responses,
404s, and static/ISG output on the first-party adapters (`adapter-node`,
`adapter-cloudflare`) as well as the Vercel headers config generated at build
time:

- `permissions-policy` (disables device sensors)
- `referrer-policy: strict-origin-when-cross-origin`
- `x-content-type-options: nosniff`
- `x-frame-options: SAMEORIGIN`

The helper behind this (`applyDefaultSecurityHeaders`) only sets a header
**when missing** — so a route or shell `headers()` export always wins,
including when it weakens a default. The framework does NOT set
`strict-transport-security`, `content-security-policy`, or `cross-origin-*`
headers — those need a project decision.

The audit surface is therefore:

- **(a)** `dist/client` served by a custom CDN/host outside the first-party
  adapters — nothing applies the defaults there.
- **(b)** `headers()` exports that override a default with a weaker value.
- **(c)** HSTS and CSP, which genuinely need user action.

Prerequisites: `pracht inspect` requires a vite config that registers the
pracht plugin; `pracht inspect build` and `dist/client/_pracht/headers.json`
require a prior `pracht build`.

## Step 1: Inventory header sources

```bash
pracht inspect routes --json
pracht inspect api --json
```

If the pracht MCP server is registered (see `docs/MCP.md`), prefer its tools
(`inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify`) over
shelling out.

Only route modules and shells have a `headers()` export — API handlers do not
(there is no `headers` in the API module shape; API handlers set headers
inline on the `Response` they build, and the runtime applies the defaults on
top). Inventory:

- `headers()` exports in route files, loader files (`loaderFile`), and shells
  (`shellFile`).
- Hand-rolled `Response` constructions in API handlers and middleware where
  security-relevant headers are set inline.

## Step 2: Find weakened defaults and uncovered static hosting

Defaults are framework-applied, so do not build a "which route is covered"
matrix — instead:

1. For each `headers()` source from Step 1, flag any of the four default
   header names set to a weaker value (e.g. `x-frame-options: ALLOWALL`,
   an over-permissive `permissions-policy`, `referrer-policy: unsafe-url`).
   Because the defaults are set-when-missing, the route value wins.
2. Ask how `dist/client` is deployed. On `adapter-node`, `adapter-cloudflare`,
   or the generated Vercel config, static/ISG responses get the defaults. If
   a custom CDN or host serves `dist/client` directly, flag it (`warn`) and
   recommend replicating the four defaults in that host's header config.

## Step 3: HSTS

Grep for `strict-transport-security`. If absent everywhere, recommend adding
it (e.g. via a shell `headers()` export or the host's config):

```ts
"strict-transport-security": "max-age=63072000; includeSubDomains; preload"
```

Only recommend `preload` if the user confirms they want to commit to HTTPS
permanently and submit to the preload list.

## Step 4: Content-Security-Policy

Start from the canonical starter policy in `docs/CSP.md` — it includes
`'inline-speculation-rules'` in `script-src`, required for routes that opt
into `speculation` (they emit an inline
`<script type="speculationrules">`). Then add observed origins:

1. Check which routes use `speculation`: read the `speculation` field from
   `pracht inspect routes --json` (requires a current `@pracht/cli`; on older
   CLIs, grep the manifest for `speculation:` instead). If none do,
   `'inline-speculation-rules'` can be dropped.
2. Grep the app for fetch URLs, image URLs, CSS `@import`, `<script src>`,
   `<link href>`, font URLs, iframe sources.
3. Group by directive: `default-src`, `script-src`, `style-src`, `img-src`,
   `font-src`, `connect-src`, `frame-src`; always include `'self'` per
   directive, per the starter policy.
4. Pracht injects hydration state in a non-executable
   `<script id="pracht-state" type="application/json">` — it does not need
   `'unsafe-inline'`. Do not add `'unsafe-inline'` unless the app truly emits
   executable inline scripts and the tradeoff is documented.

Output a draft CSP referencing `docs/CSP.md` and explain what each origin is
for. Do not hand the user a CSP that breaks their site — present as draft.

## Step 5: Prerendered header manifest safety

For SSG/ISG output, the framework refuses to prerender any route whose
document headers include dangerous names (`set-cookie`, `authorization`,
`proxy-authorization`, `www-authenticate`, `proxy-authenticate`) or
secret-shaped custom `x-*` names (token/secret/key/credential patterns) — a
build containing them hard-fails. So do not hunt for those at runtime; audit
the `headers()` sources statically to catch them **before** a build failure,
and report each as `error` with the prerender failure it would cause.

The real target is the `warn` class the framework cannot catch: innocuously
named headers carrying user-specific values, which get copied into
`dist/client/_pracht/headers.json` (public client output) and replayed across
users on static responses.

Secret VALUES in headers are owned by `audit-secrets`; this skill owns policy
headers. Cross-reference `audit-secrets` for value-level findings.

## Step 6: Cross-origin isolation (optional)

If the user mentions `SharedArrayBuffer`, WASM threading, or high-precision
timers, recommend:

- `cross-origin-opener-policy: same-origin`
- `cross-origin-embedder-policy: require-corp`
- `cross-origin-resource-policy: same-origin` on assets

Otherwise leave these unset — they break embedded third-party content.

## Step 7: Report

Two outputs:

1. **Findings table** (source × header × severity).
2. **Recommendations**, in priority order:
   - `error`: `headers()` values that would fail prerender (Step 5).
   - `error`: `headers()` exports that weaken a default.
   - `warn`: `dist/client` served by a host that does not apply the defaults.
   - `warn`: Missing HSTS in production-grade apps.
   - `warn`: User-specific headers in prerendered static output.
   - `info`: CSP draft, COOP/COEP suggestions.

Show the exact code change required (e.g. the `headers()` export to fix, or
the CDN header config to add).

## Rules

1. The four defaults are framework-applied — do not recommend re-adding them
   in app code; audit for weakening and for hosting paths outside the
   first-party adapters.
2. Never recommend a CSP with `'unsafe-eval'` unless the user has documented
   why they need it.
3. `applyDefaultSecurityHeaders` is set-when-missing, so per-route `headers()`
   wins over the defaults — weakened values are the primary finding, not
   missing ones.
4. Static/ISG responses already get the defaults on first-party adapters and
   the generated Vercel config; only flag static hosting that bypasses those.
5. Treat prerender header manifests as public artifacts.
6. Do not auto-edit. Headers are policy; surface gaps, propose patches.

$ARGUMENTS
