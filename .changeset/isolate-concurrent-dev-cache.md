---
"@pracht/cli": patch
---

Add `pracht dev --cache-dir` so concurrent development servers can use independent Vite optimizer caches instead of racing over `node_modules/.vite`.
