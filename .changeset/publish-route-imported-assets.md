---
"@pracht/vite-plugin": patch
---

Publish the assets a route imports into its markup when that route is outside the client bundle, so an `<img src>` built from an asset import on a `hydration: "none"` or `hydration: "islands"` page no longer points at a file that only exists in `dist/server`.
