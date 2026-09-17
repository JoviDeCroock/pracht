---
"@pracht/core": minor
"@pracht/vite-plugin": minor
---

`pracht({ client: { hydrationWarnings: true } })` keeps the hydration-mismatch reporter in production client and islands bundles, so a build can be walked for mismatches before it is deployed. Every mismatch is now reported as a `console.error` as well as in the on-page banner; the default build still compiles the reporter out.
