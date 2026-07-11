---
"@pracht/cli": patch
"@pracht/vite-plugin": patch
---

Treat `VITE_` environment variables as non-public in env leak detection unless explicitly allowlisted, preserving Pracht's `PRACHT_PUBLIC_` public-env boundary.
