---
name: audit-redirects
version: 1.0.0
description: |
  Find open-redirect vulnerabilities in pracht loaders, middleware, and
  navigation calls. The framework already rejects unsafe URL schemes
  (javascript:, data:, vbscript:, blob:, file:) on the client (commit 901ef5b)
  but a server-issued cross-origin redirect can still phish your users.
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

Pracht's client router already drops non-`http(s):` schemes at the navigation
boundary. This skill audits the **server-side** decision to redirect at all.

## Step 1: Inventory redirect sites

Grep for every redirect-issuing site:

- Middleware returning `{ redirect: ... }`.
- Loaders that throw a redirect or return a `Response` with `302`/`303`/`307`/`308`.
- API handlers building responses with a `location` header.
- `useNavigate()(value)` and `<a href={value}>` where `value` is dynamic.
- `prefetchRouteState(value)` calls with dynamic input.

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

## Step 4: Report

| File:Line | Source | Target expression | Gate | Verdict |
| --------- | ------ | ----------------- | ---- | ------- |

Verdicts:
- `safe` — static or properly gated.
- `risky` — uses substring/regex check; suggest URL-parse rewrite.
- `open` — no check at all; **fix immediately**.

For each `open`/`risky` finding, propose a fix snippet, e.g.:

```ts
const raw = url.searchParams.get("redirect") ?? "/dashboard";
const safe = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";
return { redirect: safe };
```

## Step 5: Cross-check with the client guard

Note in the report that pracht's client router (since #122) drops
`javascript:`, `data:`, `vbscript:`, `blob:`, and `file:` schemes — so even an
open redirect cannot become script execution in-browser. But it can still
phish (redirect to look-alike origin) and leak session/referrer headers.

## Rules

1. Default to suspicion for any request-derived target.
2. Recommend `URL` parsing over string prefix checks for non-trivial gates.
3. Do not trust `referer` as a gate; it is forgeable and often stripped.
4. After-login redirects are the most dangerous — user is authenticated.
5. Do not auto-fix; surface the gap and propose the patch.

$ARGUMENTS
