---
"@pracht/core": patch
---

Fix client-side query-string navigation so internal links keep using the client router, and expose `search` separately from `pathname` in `useLocation()`.
