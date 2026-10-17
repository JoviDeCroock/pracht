---
"@pracht/vite-plugin": minor
"@pracht/adapter-vercel": patch
"@pracht/adapter-cloudflare": patch
"@pracht/cli": patch
---

Adapters can write their platform's deploy output from a new `finalizeBuild(context)` hook that `pracht build` calls after prerendering, and a plain `vite build` now fails with a pointer to `pracht build` instead of an unresolved `index.html`.
