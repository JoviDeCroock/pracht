---
"@pracht/core": patch
---

The dev server and `pracht build` now warn when a manifest route can never match because an earlier route matches every URL it does, or when two routes share an id.
