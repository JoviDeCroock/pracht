---
"@pracht/cli": patch
---

`pracht typegen --check` no longer reports `src/pracht.d.ts` and `src/pracht-routes.ts` as stale after a formatter rewrites them, and regenerating leaves an already-correct file untouched.
