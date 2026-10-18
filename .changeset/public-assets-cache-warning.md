---
"@pracht/cli": patch
---

`pracht build` now warns when `public/assets/` exists, because files there are served from `/assets/`, which server adapters cache as immutable for a year.
