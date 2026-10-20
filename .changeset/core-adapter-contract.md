---
"@pracht/core": minor
"@pracht/vite-plugin": patch
"@pracht/adapter-node": patch
"@pracht/adapter-netlify": patch
"@pracht/adapter-vercel": patch
"@pracht/adapter-static": patch
---

The adapter contract (`PrachtAdapter` and its build and dev types) is now importable from `@pracht/core/adapter`, and `createServerEntryModule(entry)` receives the build's `buildId`; `@pracht/vite-plugin` keeps re-exporting the same types.
