---
"@pracht/cli": patch
---

`pracht build` moves the client Vite manifest to `dist/server/.vite/client-manifest.json`, so no deploy target or static export serves the app's module graph publicly.
