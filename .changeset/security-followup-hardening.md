---
"@pracht/adapter-node": patch
"@pracht/adapter-cloudflare": patch
"@pracht/cli": patch
---

Follow-up security hardening after the main audit fixes.

- `@pracht/adapter-node` now supports `canonicalOrigin` so apps can pin
  `request.url` to a known public origin instead of depending on untrusted
  `Host` values. The adapter also treats both `x-pracht-route-state-request`
  and `?_data=1` as route-state transports before any static/ISG HTML serving,
  and ISG regeneration now uses a clean HTML request instead of replaying the
  triggering user's cookies or authorization headers.
- `@pracht/adapter-cloudflare` now bypasses static asset serving for both
  route-state transports (`x-pracht-route-state-request` and `?_data=1`).
- `@pracht/cli` now emits a Vercel Build Output rule that sends `?_data=1`
  requests to the render function before static rewrites can serve prerendered
  HTML.
