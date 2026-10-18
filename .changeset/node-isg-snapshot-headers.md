---
"@pracht/adapter-node": patch
---

Regenerated Node ISG pages are now served with the headers their render produced, so a `headers()` value that depends on loader data (such as `x-robots-tag`) no longer stays at its build-time value.
