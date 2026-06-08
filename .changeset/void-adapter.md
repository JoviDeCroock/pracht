---
"@pracht/adapter-void": minor
"@pracht/cli": patch
"@pracht/vite-plugin": patch
---

Add `@pracht/adapter-void` for deploying Pracht apps through Void. The adapter
emits Cloudflare Worker-compatible output, wraps requests in Void's runtime env
context for binding helpers like `void/db` and `void/kv`, and teaches `pracht
build` to print `void deploy --skip-build` for the Void target.
