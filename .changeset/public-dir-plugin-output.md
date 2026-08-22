---
"@pracht/cli": patch
---

Stop overwriting build-plugin output for `public/` assets. `pracht build` copied `public/` over `dist/client/` after the client build had already emitted it, which restored the source files on top of anything a plugin rewrote on the way out — an image optimizer's compressed copies, for instance. Vite now owns that copy alone, so a custom `publicDir` and `build.copyPublicDir` are honoured too. The server build no longer duplicates `public/` into `dist/server/` either, so asset plugins stop paying for a second, discarded pass.
