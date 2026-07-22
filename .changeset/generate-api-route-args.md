---
"@pracht/cli": patch
---

`pracht generate api` now types generated handlers with `ApiRouteArgs`
instead of `BaseRouteArgs`, matching the exported API handler signature
(which includes `route: ResolvedApiRoute`).
