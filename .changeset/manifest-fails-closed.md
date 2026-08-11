---
"@pracht/core": minor
"@pracht/cli": minor
---

Make two fail-open manifest mistakes fail closed.

A registered middleware module that does not export `middleware` used to be skipped silently. A renamed export, or a `default` export (a plausible reading of the docs), therefore left an auth gate declared in the manifest and absent at runtime — while `pracht doctor`, `pracht verify`, `requireMiddleware()` constraints, the committed app-graph snapshot, and the `pracht dev` banner's `MIDDLEWARE` column all reported the route as guarded. The chain now throws instead of skipping, and `pracht verify` reports the missing export before a request is ever served.

Unknown keys in `route()` meta, `group()` meta, and `notFound` were likewise ignored, so `group({ middlewares: ["auth"] })` resolved to a route with no middleware at all. `resolveApp()` now rejects them with a "did you mean" suggestion.

A missing `middleware` export is also logged once per module. Failing closed is right, but failing closed *silently* is an outage a reviewer has to bisect — the likely trigger is a refactor renaming the export, which takes down every route carrying that middleware at deploy time, and sanitized 5xx responses say nothing.

The `pracht verify` check reads the export clause rather than pattern-matching it, over comment- and string-masked source: `export { middleware as default }` mentions the word but exports nothing named `middleware`, which is exactly the mistake being caught.

The meta-key check runs on the server (including production bundles, where the existing dev-only guard folds away) and is dead-code-eliminated from client bundles, where `resolveApp()` only ever sees a manifest the server already accepted.

Both are breaking for manifests that were already wrong; a manifest that resolves today is unaffected.
