---
"@pracht/core": patch
---

Strip the "did you mean" edit-distance implementation from production client bundles. Manifest wiring errors still list the registered names in production, but the Levenshtein-based suggestion is now computed only in dev, tests, and CLI builds where `import.meta.env.DEV` is not statically `false` — saving ~560 B raw (~260 B gzip) from every production client bundle.
