---
"@pracht/core": minor
---

Surface a visible in-page banner when Preact reports a hydration mismatch in dev mode. The banner is wired up by `initClientRouter` via Preact's `options.__m` hook, includes the offending component name, chains to any pre-existing hook, and is fully removed in production builds via `import.meta.env.DEV`.
