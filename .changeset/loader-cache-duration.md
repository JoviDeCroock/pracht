---
"@pracht/core": patch
"@pracht/cli": patch
---

Add an inheritable `loaderCache` route option for controlling how long browsers privately cache successful route-state loader data. Positive durations emit `Cache-Control: private, max-age=<seconds>`, while `false`, `0`, and the default remain `no-store`.

Expose the resolved loader cache policy in `pracht inspect routes --json` and the MCP route graph.

Manual `useRevalidate()` calls bypass route-state browser caching so explicit refreshes and post-mutation reloads still re-run the loader.

Form redirects after state-changing submissions also bypass cached route-state data when reloading the destination route.
