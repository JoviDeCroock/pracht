---
name: audit-redirects
version: 1.1.0
description: |
  Find open-redirect vulnerabilities in pracht loaders, middleware, and
  navigation calls. The framework guards both ends — the client router drops
  unsafe URL schemes, and the server `redirect()` helper rejects unsafe
  schemes and CRLF injection — but a hand-rolled 3xx Response bypasses every
  guard, and even a guarded redirect to an attacker-chosen origin can phish.
  Use when asked to "audit redirects", "check for open redirects", "is my
  ?redirect= param safe", or "review login redirect handling".
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Pracht Audit Redirects

The classic open-redirect bug: `/login?redirect=https://evil.example` →
after login, the app redirects the user to attacker territory carrying a fresh
session.

What the framework guarantees: the client router drops non-`http(s):` schemes
at the navigation boundary, and server-side `redirect()` /
`buildRedirectResponse()` reject non-`http(s):` schemes and CR/LF injection
against the `Location` header. What it cannot decide is whether the target
*origin or path* is one you trust — and a raw
`new Response(null, { status: 302, headers: { location: userInput } })`
bypasses all of those guards entirely.

Prerequisites: `pracht inspect` requires a vite config that registers the
pracht plugin.

## Step 1: Inventory redirect sites

Bound the search first — do not grep the whole repo blind:

```bash
pracht inspect routes --json
```

If the pracht MCP server is registered (see `docs/MCP.md`), prefer its tools
(`inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify`) over
shelling out.

The resolved graph gives you each route's `file`, `loaderFile`, and
`middleware` names (resolve names to files via the `defineApp({ middleware })`
map in the manifest). Grep those files plus the API handler files from
`pracht inspect api --json`, and client components, for two distinct classes:

**Class A — guarded sites** (scheme/CRLF-safe, still open-redirect capable):

- Middleware/loaders/handlers returning `redirect(...)` or
  `buildRedirectResponse(...)`.
- `useNavigate()(value)` and `<a href={value}>` where `value` is dynamic
  (client guard applies).
- `prefetchRouteState(value)` calls with dynamic input.

**Class B — unguarded sites** (bypass every framework guard):

- Hand-rolled 3xx `Response`s: `new Response(null, { status: 302, headers:
  { location: ... } })` or `headers.set("location", ...)` in loaders,
  middleware, or API handlers. With user input these allow not just open
  redirects but also unsafe schemes and header-injection attempts — flag at
  higher severity.

## Step 2: Trace the input

For each site, identify whether the redirect target is:

- **Static** — string literal. Safe.
- **Internal-derived** — built from `params`, `route.path`, or a closed
  allowlist. Safe if the allowlist is verifiable.
- **Request-derived** — read from `url.searchParams.get(...)`,
  `request.headers.get('referer')`, request body fields, cookie values, or
  query parameters. **Suspect.**

Common suspect names: `redirect`, `redirectTo`, `next`, `returnTo`, `continue`,
`url`, `dest`, `goto`.

## Step 3: Check the gate

For each request-derived target, look for one of:

| Gate                                   | Safe? |
| -------------------------------------- | ----- |
| Hardcoded allowlist of paths/origins   | Yes   |
| `target.startsWith('/')` AND `!target.startsWith('//')` | Yes — same-origin path only |
| `new URL(target, base).origin === url.origin`           | Yes — origin comparison |
| `new URL(target).hostname === expected` | Yes if `expected` is trusted |
| No check                                | **Open redirect** |
| `target.includes(domain)` (substring)   | **Bypassable** (`evil.com#yourdomain.com`) |
| Regex without anchors                   | **Likely bypassable** |

`startsWith('/')` alone is **not** sufficient — `//evil.example/path` parses
as a protocol-relative URL and most browsers treat it as cross-origin. Require
both `startsWith('/')` AND `!startsWith('//')`, or use `URL` parsing.

Remember: `redirect()`'s built-in validation covers scheme and CRLF only — it
happily redirects to any well-formed `http(s)` origin, so Class A sites still
need an origin/path gate for request-derived targets.

## Step 4: Report

| File:Line | Class (A/B) | Source | Target expression | Gate | Severity | Verdict |
| --------- | ----------- | ------ | ----------------- | ---- | -------- | ------- |

Severity is the primary scale; the verdict is a secondary domain label:

- `error` / `open` — request-derived target, no check. A Class B site here is
  the worst case (no scheme/CRLF guard either) — say so explicitly.
- `warn` / `risky` — substring/regex check; suggest URL-parse rewrite.
- `info` / `safe` — static or properly gated. For Class B sites that are
  static today, still recommend migrating to `redirect()` so the scheme/CRLF
  guards apply if the target ever becomes dynamic.

For each `open`/`risky` finding, propose a fix snippet, e.g.:

```ts
const raw = url.searchParams.get("redirect") ?? "/dashboard";
const safe = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";
return redirect(safe, { request });
```

## Step 5: Cross-check with the framework guards

Note in the report that pracht drops `javascript:`, `data:`, `vbscript:`,
`blob:`, and `file:` schemes both in the client router (since #122) and in
server-side `redirect()`/`buildRedirectResponse()` — so a guarded open
redirect cannot become script execution. But it can still phish (redirect to
a look-alike origin) and leak session/referrer headers, and Class B raw
Responses get none of this protection.

## Rules

1. Default to suspicion for any request-derived target.
2. Recommend `URL` parsing over string prefix checks for non-trivial gates.
3. Do not trust `referer` as a gate; it is forgeable and often stripped.
4. After-login redirects are the most dangerous — user is authenticated.
5. Recommend `redirect()` over hand-rolled 3xx Responses so the scheme/CRLF
   guards apply.
6. Do not auto-fix; surface the gap and propose the patch.

$ARGUMENTS
