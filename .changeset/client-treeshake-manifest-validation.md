---
"@pracht/core": patch
---

Stop shipping manifest validation to production client bundles. Route matching, path, and href primitives now live in a dependency-free module the client router imports directly, and `resolveApp`'s validation (unknown shell/middleware names, loaderCache checks, SPA+hydration conflicts, and their "did you mean" error formatting) runs only where `import.meta.env.DEV` is not statically `false` — dev servers, tests, and `pracht build` in Node, where invalid manifests still fail loudly. Production clients only flatten the already-validated manifest, cutting ~2 kB raw (~0.8 kB gzip) from the framework's client payload. Public API is unchanged: `buildHref`, `buildPathFromSegments`, and `matchAppRoute` keep their existing exports and signatures.
