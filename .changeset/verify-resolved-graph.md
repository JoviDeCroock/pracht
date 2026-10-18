---
"@pracht/cli": patch
---

`pracht verify` and `pracht doctor` now check a manifest app against its resolved route graph, so routes spread in from other modules are counted and checked, an extensionless import in `routes.ts` is no longer reported as a missing file, and `constraints` passed by shorthand are enforced.
