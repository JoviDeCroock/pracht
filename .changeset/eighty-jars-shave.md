---
"@pracht/core": patch
---

Strip the internal `_data=1` route-state marker from the request middleware and loaders receive, so `args.request.url` and `args.url` always agree on the query string.
