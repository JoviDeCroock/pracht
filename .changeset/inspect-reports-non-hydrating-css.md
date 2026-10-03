---
"@pracht/cli": patch
---

`pracht inspect build` now reports the stylesheets of `hydration: "none"` and `"islands"` routes, and `pracht build` writes the route-to-stylesheet mapping to `dist/server/css-manifest.json`.
