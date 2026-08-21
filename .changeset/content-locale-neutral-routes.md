---
"@pracht/content": patch
---

Keep `routePrefix: "never"` locale-neutral collections valid when multiple
translations share one route, and reject artifact descendants that would turn
Netlify's root control files into directories.
