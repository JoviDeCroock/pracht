---
"@pracht/vite-plugin": patch
"@pracht/core": patch
"@pracht/adapter-node": patch
"@pracht/cli": patch
---

Vercel edge deploys build again: the generated server module no longer uses a top-level `await`, which Vercel's edge bundler rejected.
