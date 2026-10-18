---
"@pracht/core": patch
---

Client navigations and revalidations no longer copy and re-parse the loader data on the server, which roughly halves route-state response time for large payloads.
