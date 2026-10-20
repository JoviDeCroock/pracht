---
"@pracht/core": patch
---

A client navigation that falls back to a full page load now honours `replace: true` and back/forward history, a static-export fallback page no longer reloads itself in a loop, and a redirect or view-transition commit that a mutation outdated refetches instead of acting on stale route state.
