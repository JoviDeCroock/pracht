---
"@pracht/core": patch
---

`viewport` and `render` prefetches now run at most three at a time and are skipped when the browser reports Save-Data or a 2G connection.
