---
"@pracht/core": patch
---

Fix two client router regressions introduced by the stateful `RouterRoot` navigation flow: shell-less SPA routes now complete their initial pending bootstrap without crashing, and `useRouteData()` no longer exposes stale data for one render during route transitions.
