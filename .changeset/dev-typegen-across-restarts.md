---
"@pracht/cli": patch
---

`pracht dev` keeps regenerating `src/pracht.d.ts` after edits to `routes.ts` restart the dev server, and starts syncing as soon as `pracht typegen` first runs during the session.
