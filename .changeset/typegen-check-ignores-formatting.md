---
"@pracht/cli": patch
---

`pracht typegen --check` now compares the generated declarations rather than the exact bytes, so a project whose formatter has been over `src/pracht.d.ts` and `src/pracht-routes.ts` no longer sees them reported stale forever. Regenerating leaves an already-correct file untouched for the same reason.
