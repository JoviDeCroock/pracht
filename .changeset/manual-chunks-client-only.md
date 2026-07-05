---
"@pracht/vite-plugin": patch
---

Only apply the preact vendor `manualChunks` split to client builds. SSR builds
that disable code splitting (for example webworker-target server bundles)
reject `manualChunks` with `"output.manualChunks" cannot be used when
"output.codeSplitting" is set to false`, and the split never had an effect on
single-file server output anyway.
