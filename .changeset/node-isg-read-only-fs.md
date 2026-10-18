---
"@pracht/adapter-node": patch
---

Node ISG on a read-only filesystem now answers cold renders instead of failing them, warns once, and re-renders a stale page at most once per revalidate window instead of on every request.
