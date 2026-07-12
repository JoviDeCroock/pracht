---
"@pracht/cli": minor
---

`pracht dev` keeps generated route types in sync: when `src/pracht.d.ts` exists (the project has run `pracht typegen` once), the dev server regenerates it on startup and whenever route files are added, removed, or renamed — including `.tsrx` routes — or the route manifest changes. This prevents stale `apiFetch()`/`href()` types after creating or rewiring a route. `pracht typegen` also skips rewriting outputs whose content is unchanged, so watch-mode regeneration never triggers spurious HMR updates.
