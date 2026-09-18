---
"@pracht/cli": patch
---

`pracht inspect build` now reports the stylesheets of routes that never enter the client bundle, and `pracht build` records the full route-to-stylesheet mapping in `dist/server/css-manifest.json`. A `hydration: "none"` or `"islands"` route previously read as having no CSS, because the report was built from the client manifest alone.
