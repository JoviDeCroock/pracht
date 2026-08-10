---
"@pracht/vite-plugin": minor
"@pracht/core": minor
"@pracht/capabilities": patch
---

Drop the agent surface from server bundles that do not use it.

`handlePrachtRequest` statically imported the capability dispatch and the Web Bot
Auth verifier, so every app shipped them whether or not it registered a
capability or configured `agents` — about 15 KB gzip (a third) of an
islands-example server bundle.

Both now load on demand, and the vite plugin defines `__PRACHT_AGENT_SURFACE__`
as `false` for builds whose manifest provably registers neither, which lets the
bundler eliminate them outright even when `llmsTxt` indexes pages and API
routes. The analysis is deliberately one-sided: an
unreadable or non-literal manifest, a parse failure, a spread, a shorthand
registration, or a computed key keeps the runtime, and a build that elided the
runtime while capabilities are registered logs a loud error instead of 404ing
quietly. Dev builds always keep the runtime so a freshly added capability works
without a restart. Escaped quoted property names are decoded by the shared
static scanner, while escaped identifier keys conservatively keep the runtime.
