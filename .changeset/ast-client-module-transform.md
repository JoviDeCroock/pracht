---
"@pracht/vite-plugin": major
---

Switch the client-module stripping pass to a Vite 8 Rolldown/Oxc post-transform
so typed route exports, mixed export declarations, Markdown route modules, and
local re-export forms are handled without producing invalid client bundles.

This also narrows `@pracht/vite-plugin` to `vite@^8.0.0`.
